/**
 * N10：房间 Durable Object（SQLite-backed）。
 * 每个有效房间码映射一个 DO（`idFromName(roomCode)`）。占用/配置/房主席位写入在
 * DO 内原子完成：令牌与摘要先行生成（await 仅发生在任何写入之前），占用
 * （occupied 0→1、generation+1）经条件 UPDATE + changes() 与配置/席位写入构成
 * 无 await 同步段，其他调用不可能看到半初始化房间。代际（generation）用于
 * 房间码复用隔离：释放后再占用 generation+1，旧代际凭据即刻失效（N09）。
 * 席位令牌只存 SHA-256 摘要（禁止回显内部摘要）；完整状态机属 N11–N21。
 */
import { DurableObject } from 'cloudflare:workers';
import type { CreateRoomRequest, RoomSettings } from '../../shared/protocol';
import type { Env } from './index';

type RoomMetaRow = { generation: number; occupied: number };

export type CreateClaim =
  | {
      claimed: true;
      generation: number;
      playerId: string;
      seatToken: string;
      settings: RoomSettings;
    }
  | { claimed: false; generation: number };

export type JoinFailure = 'ROOM_NOT_FOUND' | 'GAME_STARTED' | 'ROOM_FULL' | 'NAME_TAKEN';

export type JoinResult =
  | {
      joined: true;
      generation: number;
      playerId: string;
      seatToken: string;
      joinOrder: number;
      settings: RoomSettings;
    }
  | { joined: false; error: JoinFailure };

export type SeatInfo = { playerId: string; nickname: string; isHost: boolean; joinOrder: number };

export type LeaveResult =
  | { left: true; newHostPlayerId: string | null; roomClosed: boolean; generation: number }
  | { left: false; error: 'ROOM_NOT_FOUND' | 'UNAUTHORIZED' };

export type TicketFailure = 'ROOM_NOT_FOUND' | 'UNAUTHORIZED';

export type TicketResult =
  | { issued: true; ticket: string; expiresAt: number }
  | { issued: false; error: TicketFailure };

export type ConsumeFailure = 'TOKEN_REPLAY' | 'TOKEN_EXPIRED' | 'GENERATION_STALE' | 'UNAUTHORIZED' | 'SEAT_TAKEN';

export type ConsumeResult =
  | { ok: true; playerId: string; generation: number }
  | { ok: false; error: ConsumeFailure };

/** N13：握手票据有效期 30s（单次短期票据，席位令牌本身不进 URL）。 */
export const TICKET_TTL_MS = 30_000;

/** N14：Hibernation 附件——连接身份随 socket 持久化，DO 休眠/热重启后可恢复。 */
export type WsAttachment = { playerId: string; generation: number };

/** 强随机十六进制串（crypto.getRandomValues）。 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class RoomDO extends DurableObject<Env> {
  // SQLite DO 访问方式（本地 workerd 实测）：每次经 `this.ctx.storage.sql` 取用；
  // 构造器缓存句柄在驱逐后写入不可见。
  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /**
   * 惰性建表：room_meta 单行（occupied/generation）；room_config 单行（当前代际
   * 配置）；seats 席位（昵称大小写不敏感唯一，令牌只存摘要）。
   */
  #ensureSchema(): void {
    const sql = this.#sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS room_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         generation INTEGER NOT NULL,
         created_at TEXT NOT NULL,
         occupied INTEGER NOT NULL DEFAULT 0
       );`,
    );
    try {
      sql.exec('ALTER TABLE room_meta ADD COLUMN occupied INTEGER NOT NULL DEFAULT 0');
    } catch {
      // 列已存在（N08 旧库）：幂等忽略。
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS room_config (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         capacity INTEGER NOT NULL,
         random_mode TEXT NOT NULL,
         start_level INTEGER NOT NULL,
         custom_seed TEXT,
         generation INTEGER NOT NULL,
         state TEXT NOT NULL DEFAULT 'LOBBY'
       );`,
    );
    try {
      sql.exec("ALTER TABLE room_config ADD COLUMN state TEXT NOT NULL DEFAULT 'LOBBY'");
    } catch {
      // 列已存在（N11 前旧库）：幂等忽略。
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS seats (
         player_id TEXT PRIMARY KEY,
         nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
         token_hash TEXT NOT NULL,
         is_host INTEGER NOT NULL,
         join_order INTEGER NOT NULL,
         generation INTEGER NOT NULL
       );`,
    );
    // N13：单次短期握手票据（只存摘要）与席位活动连接声明。
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ws_tickets (
         ticket_hash TEXT PRIMARY KEY,
         player_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       );`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS seat_conns (
         player_id TEXT PRIMARY KEY,
         generation INTEGER NOT NULL
       );`,
    );
  }

  /** 确保元数据行存在（初始：generation=0、空闲）。 */
  #ensureRow(): void {
    this.#sql.exec(
      'INSERT OR IGNORE INTO room_meta (id, generation, created_at, occupied) VALUES (1, 0, ?, 0)',
      new Date().toISOString(),
    );
  }

  /**
   * 原子创建：空闲则占用（generation+1）、写入配置与房主席位并签发席位令牌；
   * 已占用返回 claimed=false（由 Worker 换码重试，禁止客户端先检查再提交）。
   * 注意（本地 workerd 实测陷阱）：不可用「SELECT `.next()` 判空再 INSERT」守卫——
   * 未耗尽游标会使后续写入对之后查询不可见；用 `INSERT OR IGNORE` 幂等插入。
   * 令牌与摘要在任何 await 之前先行生成（纯随机+哈希，无副作用），因此占用
   * （条件 UPDATE + changes()）与配置/席位写入构成无 await 的同步段：不存在
   * 「已占用但无席位」的半初始化窗口（N10 复审观察①）。
   */
  async createRoom(req: CreateRoomRequest): Promise<CreateClaim> {
    this.#ensureSchema();
    this.#ensureRow();
    const playerId = `p_${randomHex(6)}`;
    const seatToken = randomHex(32); // 64 位 hex，符合 SEAT_TOKEN_PATTERN
    const tokenHash = await sha256Hex(seatToken);
    this.#sql.exec(
      'UPDATE room_meta SET occupied = 1, generation = generation + 1 WHERE id = 1 AND occupied = 0',
    );
    const changed = this.#sql.exec<{ c: number }>('SELECT changes() AS c').one();
    const row = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    const generation = Number(row.generation);
    if (Number(changed.c) !== 1) {
      return { claimed: false, generation };
    }
    // 占用已同步提交：清理旧代际残留，写入新配置（复用码不继承旧席位）。
    this.#sql.exec('DELETE FROM seats');
    this.#sql.exec('DELETE FROM seat_conns');
    this.#sql.exec(
      `INSERT OR REPLACE INTO room_config
         (id, capacity, random_mode, start_level, custom_seed, generation)
       VALUES (1, ?, ?, ?, ?, ?)`,
      req.capacity,
      req.randomMode,
      req.startLevel,
      req.customSeed ?? null,
      generation,
    );
    this.#sql.exec(
      `INSERT INTO seats (player_id, nickname, token_hash, is_host, join_order, generation)
       VALUES (?, ?, ?, 1, 1, ?)`,
      playerId,
      req.nickname,
      tokenHash,
      generation,
    );
    const settings: RoomSettings = {
      capacity: req.capacity,
      randomMode: req.randomMode,
      startLevel: req.startLevel,
    };
    if (req.customSeed !== undefined) settings.customSeed = req.customSeed;
    return { claimed: true, generation, playerId, seatToken, settings };
  }

  /** 读取当前配置（含状态）；无配置行返回 null。 */
  #readConfig(): (RoomSettings & { state: string; generation: number }) | null {
    const rows = [
      ...this.#sql.exec<{
        capacity: number;
        random_mode: string;
        start_level: number;
        custom_seed: string | null;
        state: string;
        generation: number;
      }>('SELECT capacity, random_mode, start_level, custom_seed, state, generation FROM room_config WHERE id = 1'),
    ];
    const row = rows[0];
    if (row === undefined) return null;
    const settings: RoomSettings & { state: string; generation: number } = {
      capacity: Number(row.capacity),
      randomMode: row.random_mode as RoomSettings['randomMode'],
      startLevel: Number(row.start_level),
      state: row.state,
      generation: Number(row.generation),
    };
    if (row.custom_seed !== null) settings.customSeed = row.custom_seed;
    return settings;
  }

  /**
   * N11：大厅加入。占用态与状态（仅 LOBBY）、容量、昵称大小写不敏感冲突、席位写入
   * 构成无 await 同步段（令牌/摘要先行生成），DO 单线程串行 → 并发抢最后席位
   * 只能成功一人（清单 N11 验收）。昵称合法性由 Worker 入口先行校验。
   */
  async joinRoom(nickname: string): Promise<JoinResult> {
    this.#ensureSchema();
    this.#ensureRow();
    const playerId = `p_${randomHex(6)}`;
    const seatToken = randomHex(32);
    const tokenHash = await sha256Hex(seatToken);
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) {
      return { joined: false, error: 'ROOM_NOT_FOUND' };
    }
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { joined: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'LOBBY') {
      return { joined: false, error: 'GAME_STARTED' };
    }
    const count = Number(
      this.#sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM seats').one().c,
    );
    if (count >= config.capacity) {
      return { joined: false, error: 'ROOM_FULL' };
    }
    const clash = [
      ...this.#sql.exec<{ n: number }>('SELECT 1 AS n FROM seats WHERE nickname = ? LIMIT 1', nickname),
    ];
    if (clash.length > 0) {
      return { joined: false, error: 'NAME_TAKEN' };
    }
    const joinOrder = count + 1;
    this.#sql.exec(
      `INSERT INTO seats (player_id, nickname, token_hash, is_host, join_order, generation)
       VALUES (?, ?, ?, 0, ?, ?)`,
      playerId,
      nickname,
      tokenHash,
      joinOrder,
      Number(meta.generation),
    );
    const settings: RoomSettings = {
      capacity: config.capacity,
      randomMode: config.randomMode,
      startLevel: config.startLevel,
    };
    if (config.customSeed !== undefined) settings.customSeed = config.customSeed;
    return { joined: true, generation: Number(meta.generation), playerId, seatToken, joinOrder, settings };
  }

  /** 席位快照（N12：权限/房主标识/加入序号；供 N15 大厅态复用）。 */
  getSeats(): SeatInfo[] {
    this.#ensureSchema();
    this.#ensureRow();
    return [
      ...this.#sql.exec<{ player_id: string; nickname: string; is_host: number; join_order: number }>(
        'SELECT player_id, nickname, is_host, join_order FROM seats ORDER BY join_order ASC',
      ),
    ].map((row) => ({
      playerId: row.player_id,
      nickname: row.nickname,
      isHost: Number(row.is_host) === 1,
      joinOrder: Number(row.join_order),
    }));
  }

  /**
   * N12：主动退出。席位删除与房主转让（按存活加入序号最小者）构成无 await 同步段，
   * DO 单线程串行保证「房主退出后新房主唯一」。最后一人离开即关闭房间业务态
   * （occupied=0，代际保留）；退出者席位行删除后其令牌摘要不再匹配（旧凭据失效）。
   */
  leaveRoom(playerId: string): LeaveResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) {
      return { left: false, error: 'ROOM_NOT_FOUND' };
    }
    const seat = [
      ...this.#sql.exec<{ is_host: number }>('SELECT is_host FROM seats WHERE player_id = ?', playerId),
    ][0];
    if (seat === undefined) {
      return { left: false, error: 'UNAUTHORIZED' };
    }
    this.#sql.exec('DELETE FROM seats WHERE player_id = ?', playerId);
    if (Number(seat.is_host) !== 1) {
      return { left: true, newHostPlayerId: null, roomClosed: false, generation: Number(meta.generation) };
    }
    const survivors = [
      ...this.#sql.exec<{ player_id: string }>(
        'SELECT player_id FROM seats ORDER BY join_order ASC LIMIT 1',
      ),
    ];
    if (survivors.length === 0) {
      this.#sql.exec('UPDATE room_meta SET occupied = 0 WHERE id = 1');
      return { left: true, newHostPlayerId: null, roomClosed: true, generation: Number(meta.generation) };
    }
    const newHost = survivors[0].player_id;
    this.#sql.exec('UPDATE seats SET is_host = 1 WHERE player_id = ?', newHost);
    return {
      left: true,
      newHostPlayerId: newHost,
      roomClosed: false,
      generation: Number(meta.generation),
    };
  }

  /**
   * N13：签发单次短期握手票据。席位令牌（seatToken）经 HTTPS 校验后只换发
   * 30s 单次票据进 WS URL，令牌本身不落 URL/日志。校验：占用态→席位存在→
   * 令牌摘要匹配→当代代际；await（哈希）全部在写入同步段之前。
   */
  async issueTicket(playerId: string, seatToken: string): Promise<TicketResult> {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) {
      return { issued: false, error: 'ROOM_NOT_FOUND' };
    }
    const seat = [
      ...this.#sql.exec<{ token_hash: string; generation: number }>(
        'SELECT token_hash, generation FROM seats WHERE player_id = ?',
        playerId,
      ),
    ][0];
    if (seat === undefined) {
      return { issued: false, error: 'UNAUTHORIZED' };
    }
    const providedHash = await sha256Hex(seatToken);
    if (providedHash !== seat.token_hash || Number(seat.generation) !== Number(meta.generation)) {
      return { issued: false, error: 'UNAUTHORIZED' };
    }
    const ticket = randomHex(16);
    const ticketHash = await sha256Hex(ticket);
    const expiresAt = Date.now() + TICKET_TTL_MS;
    this.#sql.exec(
      'DELETE FROM ws_tickets WHERE expires_at <= ? OR player_id = ?',
      Date.now(),
      playerId,
    );
    this.#sql.exec(
      'INSERT INTO ws_tickets (ticket_hash, player_id, generation, expires_at) VALUES (?, ?, ?, ?)',
      ticketHash,
      playerId,
      Number(meta.generation),
      expiresAt,
    );
    return { issued: true, ticket, expiresAt };
  }

  /**
   * N13：消费票据（WS 握手入口调用）。票据哈希 await 前置，其后
   * 查找→DELETE changes() 单次判定→代际→席位存在→连接声明
   * （seat_conns 主键 INSERT OR IGNORE + changes()，保证每席位至多一条
   * 活动连接声明）构成无 await 同步段，DO 串行原子：并发重放同一票据
   * 只有一个 DELETE changes()=1。
   */
  async consumeTicket(ticket: string): Promise<ConsumeResult> {
    this.#ensureSchema();
    this.#ensureRow();
    const ticketHash = await sha256Hex(ticket);
    const now = Date.now();
    const row = [
      ...this.#sql.exec<{ player_id: string; generation: number; expires_at: number }>(
        'SELECT player_id, generation, expires_at FROM ws_tickets WHERE ticket_hash = ?',
        ticketHash,
      ),
    ][0];
    if (row === undefined) {
      return { ok: false, error: 'TOKEN_REPLAY' };
    }
    this.#sql.exec('DELETE FROM ws_tickets WHERE ticket_hash = ?', ticketHash);
    const deleted = Number(
      this.#sql.exec<{ c: number }>('SELECT changes() AS c').one().c,
    );
    if (deleted !== 1) {
      return { ok: false, error: 'TOKEN_REPLAY' };
    }
    if (row.expires_at <= now) {
      return { ok: false, error: 'TOKEN_EXPIRED' };
    }
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1 || Number(row.generation) !== Number(meta.generation)) {
      return { ok: false, error: 'GENERATION_STALE' };
    }
    const seat = [
      ...this.#sql.exec<{ n: number }>('SELECT 1 AS n FROM seats WHERE player_id = ?', row.player_id),
    ];
    if (seat.length === 0) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }
    this.#sql.exec(
      'INSERT OR IGNORE INTO seat_conns (player_id, generation) VALUES (?, ?)',
      row.player_id,
      Number(meta.generation),
    );
    const claimed = Number(
      this.#sql.exec<{ c: number }>('SELECT changes() AS c').one().c,
    );
    if (claimed !== 1) {
      return { ok: false, error: 'SEAT_TAKEN' };
    }
    return { ok: true, playerId: row.player_id, generation: Number(meta.generation) };
  }

  // —— N14：WebSocket Hibernation 接线（不与 ws.accept 混用）——

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 热重启/驱逐重建后恢复连接上下文：按附件核验席位与代际，失效连接即刻关闭
    // 并释放连接声明；房间配置从 SQLite 读取，无常驻内存、无轮询。
    this.#restoreHibernated();
  }

  /**
   * 票据消费 + Hibernation 接管：DO 内 `ctx.websocket.acceptWebSocket(ws, attachment)`
   * 完成升级登记（fetch 入口不再 `server.accept()`），附件携带席位身份。
   */
  async attachWebSocket(ticket: string, ws: WebSocket): Promise<ConsumeResult> {
    const result = await this.consumeTicket(ticket);
    if (!result.ok) {
      return result;
    }
    // workers-types：acceptWebSocket 第二参为 tags；附件经 serializeAttachment 随
    // socket 持久化，休眠/重建后 deserializeAttachment 恢复席位身份。
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({
      playerId: result.playerId,
      generation: result.generation,
    } satisfies WsAttachment);
    return result;
  }

  /**
   * N14：升级请求交接入口：fetch 入口把升级请求原样 `stub.fetch(request)` 转发。
   * 生产运行时把 server 端连接挂在 `request.webSocket` 上（WebSocket 不可作为
   * RPC 方法参数序列化）；本地 wrangler dev（miniflare loopback）不附加该属性，
   * 则 DO 自建 WebSocketPair：server 端交 Hibernation 接管，client 端经 101
   * Response 回传运行时完成握手。两条路径都只经 acceptWebSocket，不混用 accept()。
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) {
      const jsonError = (error: string, status: number): Response =>
        new Response(JSON.stringify({ error }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
        return jsonError('BAD_MESSAGE', 400);
      }
      const ticket = url.searchParams.get('ticket') ?? '';
      const runtimeWs = (request as unknown as { webSocket?: WebSocket | null }).webSocket;
      let server: WebSocket;
      let client: WebSocket | null = null;
      if (runtimeWs !== undefined && runtimeWs !== null) {
        // 生产路径：运行时已创建 server 端连接，Hibernation 直接接管。
        server = runtimeWs;
      } else {
        // 本地 dev 路径：DO 自建 pair，client 端随 101 回传（miniflare 会把它与
        // 真实客户端 socket 对接；workerd RPC 支持 Response.webSocket 透传）。
        const pair = new WebSocketPair() as unknown as WebSocket[];
        server = pair[1];
        client = pair[0];
      }
      const result = await this.attachWebSocket(ticket, server);
      if (!result.ok) {
        return jsonError(result.error, result.error === 'SEAT_TAKEN' ? 409 : 401);
      }
      return client !== null
        ? new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit)
        : new Response(null, { status: 101 });
    }
    return new Response('not found', { status: 404 });
  }

  /** 事件回调（平台在休眠实例上直接唤起）：N14 提供 liveness ping/pong，协议消息 N16+。 */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const att = this.#attachmentOf(ws);
    if (att === null) {
      ws.close(4001, 'attachment missing');
      return;
    }
    if (typeof message === 'string' && message === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
    // 其余消息类型属 N16 协议接线；未知内容忽略不放大（防滥用属 N25）。
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.#releaseSeatConn(ws);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.#releaseSeatConn(ws);
  }

  #attachmentOf(ws: WebSocket): WsAttachment | null {
    const raw = ws.deserializeAttachment() as unknown;
    if (
      typeof raw !== 'object' || raw === null ||
      typeof (raw as WsAttachment).playerId !== 'string' ||
      !Number.isInteger((raw as WsAttachment).generation)
    ) {
      return null;
    }
    return raw as WsAttachment;
  }

  /** 断线即释放该席位的连接声明（重连换发新票据即可再占；宽限/淘汰属 N20）。 */
  #releaseSeatConn(ws: WebSocket): void {
    const att = this.#attachmentOf(ws);
    if (att === null) return;
    this.#ensureSchema();
    this.#sql.exec(
      'DELETE FROM seat_conns WHERE player_id = ? AND generation = ?',
      att.playerId,
      att.generation,
    );
  }

  /** 热重启重建：遍历 Hibernation 存量连接，附件缺失或席位/代际/占用态失效即关闭。 */
  #restoreHibernated(): void {
    this.#ensureSchema();
    this.#ensureRow();
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    for (const ws of sockets) {
      const att = this.#attachmentOf(ws);
      if (att === null) {
        ws.close(4001, 'attachment missing');
        continue;
      }
      const seat = [
        ...this.#sql.exec<{ n: number }>(
          'SELECT 1 AS n FROM seats WHERE player_id = ? AND generation = ?',
          att.playerId,
          att.generation,
        ),
      ];
      if (meta.occupied !== 1 || att.generation !== Number(meta.generation) || seat.length === 0) {
        ws.close(4001, 'stale connection');
        this.#sql.exec('DELETE FROM seat_conns WHERE player_id = ?', att.playerId);
      }
    }
  }

  /** 释放：occupied=0；代际保留，下次占用 +1（旧凭据失效依据）。 */
  release(): { generation: number } {
    this.#ensureSchema();
    this.#ensureRow();
    this.#sql.exec('UPDATE room_meta SET occupied = 0 WHERE id = 1');
    const row = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    return { generation: Number(row.generation) };
  }
}
