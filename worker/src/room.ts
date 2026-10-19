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
import {
  COUNTDOWN_MS,
  CUSTOM_SEED_PATTERN,
  DISCONNECT_GRACE_MS,
  EMPTY_ROOM_TTL_MS,
  MATCH_DURATION_MS,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MAX_START_LEVEL,
  MIN_PLAYERS,
  MIN_START_LEVEL,
  PROTOCOL_VERSION,
  RANDOM_MODES,
  RNG_ALGO,
  VERSION_CLOSE_CODE,
  deriveSeatSeed,
  normalizeSeed32,
} from '../../shared/protocol';
import type {
  CountdownMsg,
  CreateRoomRequest,
  MatchEndMsg,
  MatchId,
  MatchStartMsg,
  PlayerLeftMsg,
  RandomMode,
  RngAlgo,
  RoomPhase,
  RoomSettings,
  SnapshotMsg,
} from '../../shared/protocol';
import { describeError } from '../../shared/errors';
import { validateClientMessage, withinMessageLimit } from '../../shared/validate';
import type { Env } from './index';

type RoomMetaRow = { generation: number; occupied: number };

// N25：入站硬限流——每连接每秒消息上限（客户端快照节奏 5Hz，留 4 倍余量；
// 超限在 JSON 解析**之前**丢弃，恶意 100Hz 不放大 CPU/内存）。
const INBOUND_RATE_PER_SEC = 20;
// N25：出站背压阈值——ws.bufferedAmount 超过此值时快照帧只入单槽队列
// （丢弃旧帧保留新帧），缓冲回落后补发。槽数受连接数约束（≤6）。
const OUTBOUND_BUFFER_LIMIT = 16_384;

/** N25：席位最新快照槽（内存态，绝不写 SQLite；N26 单目标路由读取源）。 */
export type SnapshotSlot = {
  encoded: string;
  seq: number;
  matchId: MatchId;
  receivedAt: number;
};

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

// —— N18：淘汰与提前终局裁决（淘汰时间只由服务端接受，客户端不可指定）——

export type EliminationFailure = 'ROOM_NOT_FOUND' | 'BAD_STATE' | 'MATCH_MISMATCH' | 'NOT_PARTICIPANT';

export type EliminationResult =
  | {
      eliminated: true;
      /** 重复淘汰事件：幂等返回既有服务端淘汰时间，不重复广播/裁决。 */
      alreadyEliminated: boolean;
      eliminatedAt: number;
      matchEnded: boolean;
      /** matchEnded=true 时的胜者（并列为多人；最后 1 人即单人）。 */
      winners: string[];
    }
  | { eliminated: false; error: EliminationFailure };

export type BatchEliminationResult =
  | {
      ok: true;
      /** 本次新入账（服务端时刻已写入）。 */
      accepted: string[];
      /** 重复事件：幂等跳过。 */
      already: string[];
      /** 身份不在冻结名单：拒绝入账。 */
      rejected: string[];
      matchEnded: boolean;
      winners: string[];
    }
  | { ok: false; error: 'ROOM_NOT_FOUND' | 'BAD_STATE' | 'MATCH_MISMATCH' };

export type TicketResult =
  | { issued: true; ticket: string; expiresAt: number }
  | { issued: false; error: TicketFailure };

// N22：SEAT_TAKEN 死支清理——N20 起消费为替换语义（旧连接 4003 关闭），不再返回该码。
export type ConsumeFailure = 'TOKEN_REPLAY' | 'TOKEN_EXPIRED' | 'GENERATION_STALE' | 'UNAUTHORIZED';

export type ConsumeResult =
  | { ok: true; playerId: string; generation: number }
  | { ok: false; error: ConsumeFailure };

/** N13：握手票据有效期 30s（单次短期票据，席位令牌本身不进 URL）。 */
export const TICKET_TTL_MS = 30_000;

// —— N15：会话状态机（LOBBY→COUNTDOWN→RUNNING→FINISHED→LOBBY/CLOSED）与准备 ——

export type ConfigPatch = {
  capacity?: number;
  randomMode?: RandomMode;
  startLevel?: number;
  /** null 表示清除自定义种子（回到系统随机）。 */
  customSeed?: string | null;
};

export type ConfigFailure =
  | 'ROOM_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'NOT_HOST'
  | 'GAME_STARTED'
  | 'BAD_CONFIG'
  | 'CAPACITY_BELOW_SEATS';

export type ConfigResult =
  | { updated: true; settings: RoomSettings; readyReset: true; generation: number }
  | { updated: false; error: ConfigFailure };

export type ReadyResult =
  | { ok: true; isReady: boolean; generation: number }
  | { ok: false; error: 'ROOM_NOT_FOUND' | 'UNAUTHORIZED' | 'GAME_STARTED' };

export type StartFailure =
  | 'ROOM_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'NOT_HOST'
  | 'GAME_STARTED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'PLAYERS_NOT_READY';

export type StartResult =
  | {
      started: true;
      generation: number;
      settings: RoomSettings;
      roster: SeatInfo[];
      /** N16：服务器权威开局信息（一次性下发，不逐秒广播）。 */
      match: {
        matchId: MatchId;
        startAt: number;
        deadlineAt: number;
        rngAlgo: RngAlgo;
        /** 各席位实际出块种子（S1/S3 全员相同，S2 按席位派生）。 */
        seatSeeds: Record<string, number>;
      };
    }
  | { started: false; error: StartFailure };

export type NextRoundResult =
  | { ok: true; generation: number }
  | { ok: false; error: 'ROOM_NOT_FOUND' | 'UNAUTHORIZED' | 'NOT_HOST' | 'BAD_STATE' };

// —— N16：统一倒计时与开局种子派生 ——

export type MatchInfo = {
  matchId: MatchId;
  startAt: number;
  deadlineAt: number;
  rngAlgo: RngAlgo;
  seatSeed: number;
  seatIndex: number;
  startLevel: number;
};

export type RunningResult =
  | { started: true; matchId: MatchId; startAt: number; deadlineAt: number }
  | { started: false; error: 'ROOM_NOT_FOUND' | 'BAD_STATE' | 'TOO_EARLY' };

/** N14：Hibernation 附件——连接身份随 socket 持久化，DO 休眠/热重启后可恢复。 */
export type WsAttachment = { playerId: string; generation: number; connId: string };

/** 强随机十六进制串（crypto.getRandomValues）。 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 强随机 32 位主种子（0 映射为固定非零值，xorshift32 状态非零要求）。 */
function randomUint32(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] === 0 ? 0x9e3779b9 : buf[0];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class RoomDO extends DurableObject<Env> {
  // —— N25：入站快照管线（全部内存态，绝不逐帧写 SQLite；规模受席位/连接数约束）——
  // playerId → 最新快照槽（每局开局清空，席位至多 6 槽）。
  readonly #snapLatest = new Map<string, SnapshotSlot>();
  // connId → 已接受信封 seq（连接内严格单调；重连即新 connId 重新计数）。
  readonly #connSeq = new Map<string, number>();
  // connId → 最近 1 秒入站时刻滑窗（每窗至多 INBOUND_RATE_PER_SEC 条）。
  readonly #connRate = new Map<string, number[]>();
  // connId → 出站背压单槽（缓冲超限时覆盖旧帧保留新帧）。
  readonly #outSlots = new Map<string, string>();

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
    // N21：空置起点（全部连接意外断开时的服务端时刻；NULL=有活动连接或未空置）。
    try {
      sql.exec('ALTER TABLE room_meta ADD COLUMN idle_since INTEGER');
    } catch {
      // 列已存在（N21 前旧库）：幂等忽略。
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
         generation INTEGER NOT NULL,
         conn_id TEXT
       );`,
    );
    try {
      sql.exec('ALTER TABLE seat_conns ADD COLUMN conn_id TEXT');
    } catch {
      // 列已存在（N20 前旧库）：幂等忽略。
    }
    // N20：断线标记（服务端断线时刻；NULL=有活动连接）。席位数据存续至
    // 房间到期/主动离开，与 30 分钟房间清理（N21）互不混同。
    try {
      sql.exec('ALTER TABLE seats ADD COLUMN disconnected_at INTEGER');
    } catch {
      // 列已存在（N20 前旧库）：幂等忽略。
    }
    // N15：准备标志（房主改配置后整体清零）与开局冻结名单（独立于 seats，
    // 下一局重新冻结；名单冻结后中途退出不改写已冻结的参赛名单）。
    try {
      sql.exec('ALTER TABLE seats ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0');
    } catch {
      // 列已存在（N15 前旧库）：幂等忽略。
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS match_roster (
         player_id TEXT PRIMARY KEY,
         nickname TEXT NOT NULL,
         join_order INTEGER NOT NULL,
         generation INTEGER NOT NULL
       );`,
    );
    // N16：当前局权威时间/种子（单行；startGame 整体替换，代际核验）。
    sql.exec(
      `CREATE TABLE IF NOT EXISTS match_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         match_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         master_seed INTEGER NOT NULL,
         rng_algo TEXT NOT NULL,
         start_at INTEGER NOT NULL,
         deadline_at INTEGER NOT NULL,
         running_at INTEGER
       );`,
    );
    // N18：服务端接受的淘汰时间（禁止客户端指定；nextRound/createRoom 清空，
    // 故 player_id 单主键即每局每人至多一次淘汰，重复事件天然幂等）。
    sql.exec(
      `CREATE TABLE IF NOT EXISTS eliminations (
         player_id TEXT PRIMARY KEY,
         eliminated_at INTEGER NOT NULL,
         match_id TEXT NOT NULL,
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
    this.#sql.exec('DELETE FROM match_roster');
    this.#sql.exec('DELETE FROM match_state');
    this.#sql.exec('DELETE FROM eliminations');
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
    // N12 复审 O2 修复：加入序号取 MAX+1（中途退出后 COUNT+1 会撞号）。
    const maxRow = this.#sql
      .exec<{ m: number | null }>('SELECT MAX(join_order) AS m FROM seats')
      .one();
    const joinOrder = (maxRow.m === null ? 0 : Number(maxRow.m)) + 1;
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
   * N15：权威房间态快照（状态+配置+席位含准备标志），供 N16 大厅广播复用。
   * 未占用/配置代际不符返回 null。
   */
  getLobbyState(): {
    state: RoomPhase;
    settings: RoomSettings;
    seats: (SeatInfo & { isReady: boolean; disconnectedAt: number | null })[];
    generation: number;
  } | null {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return null;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) return null;
    const settings: RoomSettings = {
      capacity: config.capacity,
      randomMode: config.randomMode,
      startLevel: config.startLevel,
    };
    if (config.customSeed !== undefined) settings.customSeed = config.customSeed;
    const seats = [
      ...this.#sql.exec<{
        player_id: string;
        nickname: string;
        is_host: number;
        join_order: number;
        is_ready: number;
        disconnected_at: number | null;
      }>(
        'SELECT player_id, nickname, is_host, join_order, is_ready, disconnected_at FROM seats ORDER BY join_order ASC',
      ),
    ].map((row) => ({
      playerId: row.player_id,
      nickname: row.nickname,
      isHost: Number(row.is_host) === 1,
      joinOrder: Number(row.join_order),
      isReady: Number(row.is_ready) === 1,
      // N20：断线时刻（服务端时钟）；重连即清空。席位存续与 30 分钟清理独立。
      disconnectedAt: row.disconnected_at === null ? null : Number(row.disconnected_at),
    }));
    return {
      state: config.state as RoomPhase,
      settings,
      seats,
      generation: Number(meta.generation),
    };
  }

  /**
   * N15：房主更新配置（仅 LOBBY 可改，开赛后锁定）。任一字段更新后**全部准备
   * 标志清零**（含房主自身），要求重新准备（清单 N15 验收）。字段边界与创建
   * 入口同源（shared/protocol 常量）；容量不得低于当前在场席位数。
   * 全程无 await：校验→UPDATE 配置→清准备构成原子段。
   */
  updateConfig(playerId: string, patch: ConfigPatch): ConfigResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { updated: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { updated: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'LOBBY') return { updated: false, error: 'GAME_STARTED' };
    const seat = [
      ...this.#sql.exec<{ is_host: number }>('SELECT is_host FROM seats WHERE player_id = ?', playerId),
    ][0];
    if (seat === undefined) return { updated: false, error: 'UNAUTHORIZED' };
    if (Number(seat.is_host) !== 1) return { updated: false, error: 'NOT_HOST' };
    const capacity = patch.capacity ?? config.capacity;
    const randomMode = patch.randomMode ?? config.randomMode;
    const startLevel = patch.startLevel ?? config.startLevel;
    const customSeed = patch.customSeed === undefined ? config.customSeed ?? null : patch.customSeed;
    if (
      !Number.isInteger(capacity) ||
      capacity < MIN_PLAYERS ||
      capacity > MAX_PLAYERS ||
      !RANDOM_MODES.includes(randomMode) ||
      !Number.isInteger(startLevel) ||
      startLevel < MIN_START_LEVEL ||
      startLevel > MAX_START_LEVEL ||
      (customSeed !== null && !CUSTOM_SEED_PATTERN.test(customSeed))
    ) {
      return { updated: false, error: 'BAD_CONFIG' };
    }
    const seatCount = Number(
      this.#sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM seats').one().c,
    );
    if (capacity < seatCount) return { updated: false, error: 'CAPACITY_BELOW_SEATS' };
    this.#sql.exec(
      'UPDATE room_config SET capacity = ?, random_mode = ?, start_level = ?, custom_seed = ? WHERE id = 1',
      capacity,
      randomMode,
      startLevel,
      customSeed,
    );
    this.#sql.exec('UPDATE seats SET is_ready = 0 WHERE generation = ?', Number(meta.generation));
    const settings: RoomSettings = { capacity, randomMode, startLevel };
    if (customSeed !== null) settings.customSeed = customSeed;
    return { updated: true, settings, readyReset: true, generation: Number(meta.generation) };
  }

  /** N15：玩家准备/取消准备（仅 LOBBY；开赛后拒绝）。 */
  setReady(playerId: string, ready: boolean): ReadyResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { ok: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { ok: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'LOBBY') return { ok: false, error: 'GAME_STARTED' };
    const seat = [
      ...this.#sql.exec<{ n: number }>('SELECT 1 AS n FROM seats WHERE player_id = ?', playerId),
    ];
    if (seat.length === 0) return { ok: false, error: 'UNAUTHORIZED' };
    this.#sql.exec('UPDATE seats SET is_ready = ? WHERE player_id = ?', ready ? 1 : 0, playerId);
    return { ok: true, isReady: ready, generation: Number(meta.generation) };
  }

  /**
   * N15：房主开局。开始条件（方案 §3.4）：在场席位不少于 MIN_PLAYERS、全部席位
   * （含房主）完成准备、不超过容量（加入门槛保证）；成功后 LOBBY→COUNTDOWN，
   * 冻结参赛名单（match_roster）与比赛参数（配置行由 state 锁定，updateConfig
   * 与 joinRoom 均拒绝）。全程无 await：校验→置状态→冻结名单构成原子段，
   * 不存在「已开赛但名单未冻结」窗口。
   */
  startGame(playerId: string): StartResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { started: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { started: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'LOBBY') return { started: false, error: 'GAME_STARTED' };
    const seat = [
      ...this.#sql.exec<{ is_host: number }>('SELECT is_host FROM seats WHERE player_id = ?', playerId),
    ][0];
    if (seat === undefined) return { started: false, error: 'UNAUTHORIZED' };
    if (Number(seat.is_host) !== 1) return { started: false, error: 'NOT_HOST' };
    const seatRows = [
      ...this.#sql.exec<{
        player_id: string;
        nickname: string;
        join_order: number;
        is_ready: number;
      }>('SELECT player_id, nickname, join_order, is_ready FROM seats ORDER BY join_order ASC'),
    ];
    if (seatRows.length < MIN_PLAYERS) return { started: false, error: 'NOT_ENOUGH_PLAYERS' };
    if (seatRows.some((r) => Number(r.is_ready) !== 1)) {
      return { started: false, error: 'PLAYERS_NOT_READY' };
    }
    this.#sql.exec("UPDATE room_config SET state = 'COUNTDOWN' WHERE id = 1");
    this.#sql.exec('DELETE FROM match_roster');
    this.#sql.exec('DELETE FROM eliminations');
    for (const r of seatRows) {
      this.#sql.exec(
        'INSERT INTO match_roster (player_id, nickname, join_order, generation) VALUES (?, ?, ?, ?)',
        r.player_id,
        r.nickname,
        Number(r.join_order),
        Number(meta.generation),
      );
    }
    // N16：服务器决定主种子/算法版本/统一开始与截止时间（同一原子段内入库）。
    // S3 用固定哈希归一化房主种子（可复盘）；S1/S2 用安全随机 32 位主种子。
    const masterSeed =
      config.randomMode === 'S3' && config.customSeed !== undefined
        ? normalizeSeed32(config.customSeed)
        : randomUint32();
    const matchId = `m_${randomHex(8)}`;
    const startAt = Date.now() + COUNTDOWN_MS;
    const deadlineAt = startAt + MATCH_DURATION_MS;
    // N25：新一局快照槽清空（陈旧局快照不得跨局存活）。
    this.#snapLatest.clear();
    this.#sql.exec(
      `INSERT OR REPLACE INTO match_state
         (id, match_id, generation, master_seed, rng_algo, start_at, deadline_at, running_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, NULL)`,
      matchId,
      Number(meta.generation),
      masterSeed,
      RNG_ALGO,
      startAt,
      deadlineAt,
    );
    // N17：倒计时截止由 DO Alarm 触发（服务器权威时间；无每心跳轮询）。
    this.ctx.storage.setAlarm(startAt);
    const seatSeeds: Record<string, number> = {};
    for (const r of seatRows) {
      seatSeeds[r.player_id] =
        config.randomMode === 'S2' ? deriveSeatSeed(masterSeed, r.player_id) : masterSeed;
    }
    // 一次性下发倒计时（各客户端本地显示 3、2、1；不逐秒广播）。
    this.#broadcast((playerId) => {
      void playerId;
      return { v: PROTOCOL_VERSION, type: 'countdown', revision: 1, matchId, startAt, deadlineAt };
    });
    const settings: RoomSettings = {
      capacity: config.capacity,
      randomMode: config.randomMode,
      startLevel: config.startLevel,
    };
    if (config.customSeed !== undefined) settings.customSeed = config.customSeed;
    return {
      started: true,
      generation: Number(meta.generation),
      settings,
      roster: seatRows.map((r) => ({
        playerId: r.player_id,
        nickname: r.nickname,
        isHost: r.player_id === playerId,
        joinOrder: Number(r.join_order),
      })),
      match: { matchId, startAt, deadlineAt, rngAlgo: RNG_ALGO, seatSeeds },
    };
  }

  /**
   * N16：席位查询当前局信息（match_start 载荷同源）：席位存在且当代、match_state
   * 代际一致才返回；seatSeed 按模式派生（S1/S3 全员同种子，S2 按席位独立）。
   */
  getMatchInfo(playerId: string): MatchInfo | null {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return null;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) return null;
    const seat = [
      ...this.#sql.exec<{ join_order: number }>(
        'SELECT join_order FROM seats WHERE player_id = ? AND generation = ?',
        playerId,
        Number(meta.generation),
      ),
    ][0];
    if (seat === undefined) return null;
    const row = [
      ...this.#sql.exec<{
        match_id: string;
        master_seed: number;
        rng_algo: string;
        start_at: number;
        deadline_at: number;
      }>(
        'SELECT match_id, master_seed, rng_algo, start_at, deadline_at FROM match_state WHERE id = 1 AND generation = ?',
        Number(meta.generation),
      ),
    ][0];
    if (row === undefined) return null;
    return {
      matchId: row.match_id,
      startAt: Number(row.start_at),
      deadlineAt: Number(row.deadline_at),
      rngAlgo: row.rng_algo as RngAlgo,
      seatSeed:
        config.randomMode === 'S2'
          ? deriveSeatSeed(Number(row.master_seed), playerId)
          : Number(row.master_seed),
      seatIndex: Number(seat.join_order),
      startLevel: config.startLevel,
    };
  }

  /**
   * N16：COUNTDOWN→RUNNING 权威确认（N17 闹钟在 startAt 到期调用）。**提前开始
   * 拒绝**：now < startAt 一律 TOO_EARLY；临界时刻 now === startAt 允许（清单验收）。
   * 成功后逐席位广播 match_start（含该席位 seatSeed/seatIndex/startLevel，全员
   * startAt/deadlineAt 一致）。无 await 原子段。
   */
  advanceToRunning(now: number = Date.now()): RunningResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { started: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { started: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'COUNTDOWN') return { started: false, error: 'BAD_STATE' };
    const row = [
      ...this.#sql.exec<{
        match_id: string;
        master_seed: number;
        rng_algo: string;
        start_at: number;
        deadline_at: number;
      }>(
        'SELECT match_id, master_seed, rng_algo, start_at, deadline_at FROM match_state WHERE id = 1 AND generation = ?',
        Number(meta.generation),
      ),
    ][0];
    if (row === undefined) return { started: false, error: 'BAD_STATE' };
    const startAt = Number(row.start_at);
    if (now < startAt) return { started: false, error: 'TOO_EARLY' };
    this.#sql.exec("UPDATE room_config SET state = 'RUNNING' WHERE id = 1");
    this.#sql.exec('UPDATE match_state SET running_at = ? WHERE id = 1', now);
    // N17：开赛即重排 600 秒截止闹钟（deadlineAt 已持久化，驱逐后可重建）。
    this.ctx.storage.setAlarm(Number(row.deadline_at));
    const seatIndex = new Map<string, number>();
    for (const s of this.#sql.exec<{ player_id: string; join_order: number }>(
      'SELECT player_id, join_order FROM seats',
    )) {
      seatIndex.set(s.player_id, Number(s.join_order));
    }
    const masterSeed = Number(row.master_seed);
    this.#broadcast((playerId) => ({
      v: PROTOCOL_VERSION,
      type: 'match_start',
      revision: 1,
      matchId: row.match_id,
      startAt,
      deadlineAt: Number(row.deadline_at),
      rngAlgo: row.rng_algo as RngAlgo,
      seatSeed: config.randomMode === 'S2' ? deriveSeatSeed(masterSeed, playerId) : masterSeed,
      seatIndex: seatIndex.get(playerId) ?? 0,
      startLevel: config.startLevel,
    }));
    return { started: true, matchId: row.match_id, startAt, deadlineAt: Number(row.deadline_at) };
  }

  /**
   * N17：DO Alarm 回调——超时/倒计时到点的**唯一权威触发源**（服务器时间，
   * 独立于客户端消息与心跳；不在每心跳上轮询）。到期语义见 #handleDeadline；
   * N20 起同一回调面先处理 deadline 再处理断线宽限到期（顺序保证 startAt 到点
   * 先 RUNNING 再裁决宽限过期，deadline 到点先终局、宽限不再淘汰），最后把
   * 最近宽限闹钟与 deadline 取更早者重排（联网比赛不停表）。
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.#handleDeadline(now);
    this.#handleGraceExpiry(now);
    // N21：全员意外离线满 EMPTY_ROOM_TTL_MS（30 分钟）→ 释放业务数据。
    this.#handleIdleExpiry(now);
    this.#rescheduleAlarms(now);
  }

  /**
   * N17：按服务器权威时间处理当前局截止。COUNTDOWN：now≥startAt → advanceToRunning
   * （内部重排 deadline 闹钟）；否则重排 startAt。RUNNING：now≥deadlineAt →
   * #endAtDeadline（幂等）；否则重排 deadlineAt。LOBBY/FINISHED/未占用/代际陈旧 →
   * 无操作（重复触发安全）。
   */
  #handleDeadline(now: number): void {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) return;
    if (config.state !== 'COUNTDOWN' && config.state !== 'RUNNING') return;
    const row = this.#readMatchState(Number(meta.generation));
    if (row === undefined) return;
    if (config.state === 'COUNTDOWN') {
      if (now >= Number(row.start_at)) this.advanceToRunning(now);
      else this.ctx.storage.setAlarm(Number(row.start_at));
      return;
    }
    if (now >= Number(row.deadline_at)) this.#endAtDeadline(Number(meta.generation), row.match_id);
    else this.ctx.storage.setAlarm(Number(row.deadline_at));
  }

  /**
   * N20：断线宽限到期裁决——RUNNING 局中，断线满 DISCONNECT_GRACE_MS（30 秒）
   * 仍未重连的**该局参赛者**按服务端当前时刻淘汰（`grace_expired`）；非参赛者
   * 不淘汰，席位数据存续。判定式 `disconnected_at + 30000 <= now`：29.999 秒
   * 可恢复、30 秒整超限淘汰。经 #applyEliminations 幂等门（重复触发安全）。
   */
  #handleGraceExpiry(now: number): void {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) return;
    if (config.state !== 'RUNNING') return; // 淘汰只在 RUNNING 有效（N18 语义）
    const row = this.#readMatchState(Number(meta.generation));
    if (row === undefined) return;
    const ids = [
      ...this.#sql.exec<{ player_id: string }>(
        `SELECT s.player_id
           FROM seats s
           JOIN match_roster r ON r.player_id = s.player_id AND r.generation = ?
          WHERE s.disconnected_at IS NOT NULL AND s.disconnected_at + ? <= ?
            AND s.player_id NOT IN
              (SELECT player_id FROM eliminations WHERE generation = ? AND match_id = ?)`,
        Number(meta.generation),
        DISCONNECT_GRACE_MS,
        now,
        Number(meta.generation),
        row.match_id,
      ),
    ].map((r) => String(r.player_id));
    if (ids.length > 0) {
      this.#applyEliminations(ids, Number(meta.generation), row.match_id, now, 'grace_expired');
    }
  }

  /** N20：断线者是否仍为当前 RUNNING/COUNTDOWN 局未淘汰参赛者（宽限闹钟只对参赛者有意义）。 */
  #pendingGraceAt(): number | undefined {
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return undefined;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) return undefined;
    if (config.state !== 'RUNNING' && config.state !== 'COUNTDOWN') return undefined;
    const row = this.#readMatchState(Number(meta.generation));
    if (row === undefined) return undefined;
    const r = this.#sql.exec<{ m: number | null }>(
      `SELECT MIN(s.disconnected_at) AS m
         FROM seats s
         JOIN match_roster r ON r.player_id = s.player_id AND r.generation = ?
        WHERE s.disconnected_at IS NOT NULL
          AND s.player_id NOT IN
            (SELECT player_id FROM eliminations WHERE generation = ? AND match_id = ?)`,
      Number(meta.generation),
      Number(meta.generation),
      row.match_id,
    ).one();
    return r.m === null ? undefined : Number(r.m) + DISCONNECT_GRACE_MS;
  }

  /** N20：当前局闹钟时刻（COUNTDOWN→start_at，RUNNING→deadline_at）；其余状态 undefined。 */
  #matchAlarmAt(generation: number): number | undefined {
    const config = this.#readConfig();
    if (config === null || config.generation !== generation) return undefined;
    if (config.state !== 'RUNNING' && config.state !== 'COUNTDOWN') return undefined;
    const row = this.#readMatchState(generation);
    if (row === undefined) return undefined;
    return config.state === 'COUNTDOWN' ? Number(row.start_at) : Number(row.deadline_at);
  }

  /**
   * N20/N21：单槽闹钟协调——始终排定**最近待触发时刻**（比赛 deadline/倒计时、
   * 宽限到期与空置到期取更早者）。不读 getAlarm（workers-types 返回 Promise），
   * 直接由 SQL 计算候选：倒计时/比赛 deadline 闹钟不会被更晚的宽限/空置闹钟
   * 覆盖；候选清空则 deleteAlarm 取消待触发闹钟（N18 复审 O1）。
   */
  #rescheduleAlarms(now: number): void {
    const candidates: number[] = [];
    const graceAt = this.#pendingGraceAt();
    if (graceAt !== undefined && graceAt > now) candidates.push(graceAt);
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied === 1) {
      const matchAt = this.#matchAlarmAt(Number(meta.generation));
      if (matchAt !== undefined && matchAt > now) candidates.push(matchAt);
      const idleAt = this.#idleAlarmAt();
      if (idleAt !== undefined && idleAt > now) candidates.push(idleAt);
    }
    if (candidates.length === 0) {
      void this.ctx.storage.deleteAlarm();
      return;
    }
    this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  /** N20：断线即刻重排闹钟（#pendingGraceAt 已含刚标记的断线者；非参赛者无候选）。 */
  #maybeScheduleGraceAlarm(now: number): void {
    this.#rescheduleAlarms(now);
  }

  /** N21：空置到期时刻（idle_since + EMPTY_ROOM_TTL_MS）；无空置起点返回 undefined。 */
  #idleAlarmAt(): number | undefined {
    const r = this.#sql.exec<{ idle_since: number | null }>(
      'SELECT idle_since FROM room_meta WHERE id = 1',
    ).one();
    return r.idle_since === null || r.idle_since === undefined
      ? undefined
      : Number(r.idle_since) + EMPTY_ROOM_TTL_MS;
  }

  /**
   * N21：占用中、席位存在且无活动连接时记录空置起点（只记一次、不后移；
   * attach 清空）。真实平台在 close 事件触发时把关闭的 socket 移出 Hibernation
   * 登记，故 getWebSockets()=0 即「所有 WebSocket 意外断开」。
   */
  #markIdleIfEmpty(now: number): void {
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return;
    const seats = [...this.#sql.exec<{ n: number }>('SELECT 1 AS n FROM seats LIMIT 1')];
    if (seats.length === 0) return;
    if (this.ctx.getWebSockets().length > 0) return;
    this.#sql.exec('UPDATE room_meta SET idle_since = ? WHERE id = 1 AND idle_since IS NULL', now);
  }

  /**
   * N21：空置到期裁决——判定式 `idle_since + EMPTY_ROOM_TTL_MS <= now`：
   * 29 分 59 秒房间业务记录仍存在（不意味着超出 30 秒宽限的参赛者仍可复活
   * 比赛——淘汰是 N20 独立裁决），30 分钟整释放业务数据。
   */
  #handleIdleExpiry(now: number): void {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return;
    if (this.ctx.getWebSockets().length > 0) {
      // 有活动连接却残留空置标记（attach 未及时清空）：自愈清空，不释放。
      this.#sql.exec('UPDATE room_meta SET idle_since = NULL WHERE id = 1');
      return;
    }
    const idleAt = this.#idleAlarmAt();
    if (idleAt === undefined || idleAt > now) return;
    this.#releaseRoomData();
  }

  /**
   * N21：释放业务房间——清空全部业务行（席位/配置/票据/连接声明/名单/局态/
   * 淘汰），occupied=0、idle_since 清空，代际保留（下次占用 +1，旧凭据即刻
   * 失效），并取消待触发闹钟。
   */
  #releaseRoomData(): void {
    this.#sql.exec('UPDATE room_meta SET occupied = 0, idle_since = NULL WHERE id = 1');
    this.#sql.exec('DELETE FROM seats');
    this.#sql.exec('DELETE FROM seat_conns');
    this.#sql.exec('DELETE FROM ws_tickets');
    this.#sql.exec('DELETE FROM match_roster');
    this.#sql.exec('DELETE FROM match_state');
    this.#sql.exec('DELETE FROM eliminations');
    this.#sql.exec('DELETE FROM room_config');
    // N25：业务释放同时清空全部内存管线态（快照/序号/限流窗/背压槽）。
    this.#snapLatest.clear();
    this.#connSeq.clear();
    this.#connRate.clear();
    this.#outSlots.clear();
    void this.ctx.storage.deleteAlarm();
  }

  /**
   * N17：超时终局裁决（闹钟/重建路径专用，客户端无权触发）。finishGame 幂等门：
   * 非 RUNNING 直接返回，不重复广播。此刻尚无淘汰面（N18），名单全员存活 →
   * winners=冻结名单全体；最终名次 standings 由 N19 ranking 填充。
   */
  #endAtDeadline(generation: number, matchId: string): void {
    const res = this.finishGame();
    if (!res.finished) return;
    // N18：超时终局的胜者 = 冻结名单中未被淘汰的存活者（无淘汰时即全体）。
    const winners = this.#survivorsOf(generation, matchId);
    this.#broadcast(
      () =>
        ({
          v: PROTOCOL_VERSION,
          type: 'match_end',
          revision: 1,
          matchId,
          reason: 'timeout',
          winners,
          standings: [],
        }) as MatchEndMsg,
    );
  }

  /** 当代 match_state 单行（时间/种子权威）；不存在或代际陈旧返回 undefined。 */
  #readMatchState(generation: number):
    | { match_id: string; start_at: number; deadline_at: number }
    | undefined {
    return [
      ...this.#sql.exec<{ match_id: string; start_at: number; deadline_at: number }>(
        'SELECT match_id, start_at, deadline_at FROM match_state WHERE id = 1 AND generation = ?',
        generation,
      ),
    ][0];
  }

  /**
   * N17：驱逐/重启后由持久化 deadline 重建闹钟——决策与 alarm 回调同源
   * （#handleDeadline）：截止已过即刻恢复推进/终局（浏览器全离线也不延长），
   * 否则 setAlarm 最近截止。构造期异常 fail-safe（下次 RPC 再经闹钟面兜底）。
   */
  #restoreAlarms(): void {
    try {
      const now = Date.now();
      this.#handleDeadline(now);
      // N20：驱逐期断线超宽限即刻淘汰（闹钟可能随驱逐丢失，裁决与排钟同源）。
      this.#handleGraceExpiry(now);
      // N21：重建期无活动连接 → 补记空置起点；空置已到期即刻释放业务数据。
      this.#markIdleIfEmpty(now);
      this.#handleIdleExpiry(now);
      this.#rescheduleAlarms(now);
    } catch {
      // 构造期存储面异常：不阻断实例化。
    }
  }

  /** 向全部 Hibernation 存量连接按席位身份发送一条服务端消息（附件缺失跳过）。 */
  #broadcast(
    build: (playerId: string) => CountdownMsg | MatchStartMsg | MatchEndMsg | PlayerLeftMsg,
  ): number {
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.#attachmentOf(ws);
      if (att === null) continue;
      ws.send(JSON.stringify(build(att.playerId)));
      sent += 1;
    }
    return sent;
  }

  /** N15：RUNNING→FINISHED 权威转换（N17 到期/N18 淘汰裁决触发；此处提供转移与幂等拒绝）。 */
  finishGame(): { finished: true } | { finished: false; error: 'BAD_STATE' | 'ROOM_NOT_FOUND' } {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { finished: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { finished: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'RUNNING') return { finished: false, error: 'BAD_STATE' };
    this.#sql.exec("UPDATE room_config SET state = 'FINISHED' WHERE id = 1");
    return { finished: true };
  }

  /**
   * N18：成员淘汰事件裁决（N25 由 gameover 消息以**服务端接收时刻**调用；
   * 客户端不可指定淘汰时间——签名无客户端时间字段）。校验：占用态→RUNNING→
   * 当代 match_state→**只认当前局 matchId**→身份必须在冻结名单内。
   * 重复淘汰幂等（既有服务端时间原样返回，不重复广播）；已结束（FINISHED/
   * LOBBY/COUNTDOWN）事件 BAD_STATE 无操作。终局裁决（方案 §1.6/§1.7）：
   * 单事件后存活 1 人立即胜出；同一结算批次可致零存活——并列胜者按最晚
   * 淘汰时刻组（分数/消行细则属 N19）。
   */
  reportElimination(playerId: string, matchId: string, now: number = Date.now()): EliminationResult {
    const batch = this.reportEliminations([playerId], matchId, now);
    if (!batch.ok) return { eliminated: false, error: batch.error };
    if (batch.rejected.length > 0) return { eliminated: false, error: 'NOT_PARTICIPANT' };
    const eliminatedAt = this.#eliminatedAtOf(playerId, matchId);
    return {
      eliminated: true,
      alreadyEliminated: batch.already.length === 1,
      eliminatedAt: eliminatedAt ?? now,
      matchEnded: batch.matchEnded,
      winners: batch.winners,
    };
  }

  /**
   * N18：同一结算批次淘汰（方案 §1.7「极端同时淘汰」：同刻多事件一次裁决，
   * 不凭网络到包顺序分胜负）。逐 id 身份校验（非参赛入 rejected），
   * 全部入账后**一次性**终局判定。
   */
  reportEliminations(
    playerIds: string[],
    matchId: string,
    now: number = Date.now(),
  ): BatchEliminationResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { ok: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { ok: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'RUNNING') return { ok: false, error: 'BAD_STATE' };
    const row = this.#readMatchState(Number(meta.generation));
    if (row === undefined) return { ok: false, error: 'BAD_STATE' };
    if (row.match_id !== matchId) return { ok: false, error: 'MATCH_MISMATCH' };
    return this.#applyEliminations(playerIds, Number(meta.generation), matchId, now);
  }

  /**
   * N18：写入服务端接受的淘汰时间（无 await 同步段）→ player_left(eliminated)
   * 广播 → 批次入账后一次性终局裁决。既有淘汰（同代同局）幂等跳过。
   */
  #applyEliminations(
    playerIds: string[],
    generation: number,
    matchId: string,
    now: number,
    reason: 'eliminated' | 'grace_expired' = 'eliminated',
  ): Extract<BatchEliminationResult, { ok: true }> {
    const accepted: string[] = [];
    const already: string[] = [];
    const rejected: string[] = [];
    for (const playerId of playerIds) {
      const roster = [
        ...this.#sql.exec<{ player_id: string }>(
          'SELECT player_id FROM match_roster WHERE player_id = ? AND generation = ?',
          playerId,
          generation,
        ),
      ];
      if (roster.length === 0) {
        rejected.push(playerId);
        continue;
      }
      const existing = [
        ...this.#sql.exec<{ eliminated_at: number }>(
          'SELECT eliminated_at FROM eliminations WHERE player_id = ? AND generation = ? AND match_id = ?',
          playerId,
          generation,
          matchId,
        ),
      ][0];
      if (existing !== undefined) {
        already.push(playerId);
        continue;
      }
      this.#sql.exec(
        'INSERT INTO eliminations (player_id, eliminated_at, match_id, generation) VALUES (?, ?, ?, ?)',
        playerId,
        now,
        matchId,
        generation,
      );
      this.#broadcast(
        () =>
          ({
            v: PROTOCOL_VERSION,
            type: 'player_left',
            revision: 1,
            playerId,
            reason,
          }) as PlayerLeftMsg,
      );
      accepted.push(playerId);
    }
    const survivors = this.#survivorsOf(generation, matchId);
    let matchEnded = false;
    let winners: string[] = [];
    if (survivors.length === 1) {
      winners = survivors; // 最后 1 人立即胜出
      matchEnded = true;
    } else if (survivors.length === 0) {
      winners = this.#coWinnersAtMaxTime(generation, matchId); // 0 人同刻出局可并列
      matchEnded = true;
    }
    if (matchEnded) {
      this.#endMatchWithWinners(matchId, winners);
      // N21（N18 复审 O1）：提前终局取消残留的 deadline 闹钟（重排候选或 deleteAlarm）。
      this.#rescheduleAlarms(now);
    }
    return { ok: true, accepted, already, rejected, matchEnded, winners };
  }

  /** N18：读取某玩家当前局的服务端淘汰时刻（幂等返回原值用）。 */
  #eliminatedAtOf(playerId: string, matchId: string): number | undefined {
    const row = [
      ...this.#sql.exec<{ eliminated_at: number }>(
        'SELECT eliminated_at FROM eliminations WHERE player_id = ? AND match_id = ?',
        playerId,
        matchId,
      ),
    ][0];
    return row === undefined ? undefined : Number(row.eliminated_at);
  }

  /** N18：冻结名单中未被淘汰的存活者（按加入序号）。 */
  #survivorsOf(generation: number, matchId: string): string[] {
    return [
      ...this.#sql.exec<{ player_id: string }>(
        `SELECT player_id FROM match_roster
          WHERE generation = ?
            AND player_id NOT IN (
              SELECT player_id FROM eliminations WHERE generation = ? AND match_id = ?
            )
          ORDER BY join_order ASC`,
        generation,
        generation,
        matchId,
      ),
    ].map((r) => r.player_id);
  }

  /** N18：全员出局时的并列胜者 = 最晚淘汰时刻（MAX eliminated_at）的同刻出局组。 */
  #coWinnersAtMaxTime(generation: number, matchId: string): string[] {
    return [
      ...this.#sql.exec<{ player_id: string }>(
        `SELECT player_id FROM eliminations
          WHERE generation = ? AND match_id = ?
            AND eliminated_at = (
              SELECT MAX(eliminated_at) FROM eliminations WHERE generation = ? AND match_id = ?
            )
          ORDER BY eliminated_at ASC`,
        generation,
        matchId,
        generation,
        matchId,
      ),
    ].map((r) => r.player_id);
  }

  /** N18：淘汰触发的提前终局（经 finishGame 幂等门；reason=survival）。 */
  #endMatchWithWinners(matchId: string, winners: string[]): void {
    const res = this.finishGame();
    if (!res.finished) return;
    this.#broadcast(
      () =>
        ({
          v: PROTOCOL_VERSION,
          type: 'match_end',
          revision: 1,
          matchId,
          reason: 'survival',
          winners,
          standings: [],
        }) as MatchEndMsg,
    );
  }

  /**
   * N15：房主发起下一局（FINISHED→LOBBY）：席位保留、准备全部清零、冻结名单
   * 清空、配置重新可改（下一局可重选模式/种子，开始时重新确定——方案 §2）。
   */
  nextRound(playerId: string): NextRoundResult {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { ok: false, error: 'ROOM_NOT_FOUND' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) {
      return { ok: false, error: 'ROOM_NOT_FOUND' };
    }
    if (config.state !== 'FINISHED') return { ok: false, error: 'BAD_STATE' };
    const seat = [
      ...this.#sql.exec<{ is_host: number }>('SELECT is_host FROM seats WHERE player_id = ?', playerId),
    ][0];
    if (seat === undefined) return { ok: false, error: 'UNAUTHORIZED' };
    if (Number(seat.is_host) !== 1) return { ok: false, error: 'NOT_HOST' };
    this.#sql.exec("UPDATE room_config SET state = 'LOBBY' WHERE id = 1");
    this.#sql.exec('UPDATE seats SET is_ready = 0 WHERE generation = ?', Number(meta.generation));
    this.#sql.exec('DELETE FROM match_roster');
    // N16 复审 O1：下一局重新开局前不得残留上局 match 信息（getMatchInfo 陈旧）。
    this.#sql.exec('DELETE FROM match_state');
    this.#sql.exec('DELETE FROM eliminations');
    // N25：下一局重新开局前清空上局快照槽（与 match_state 删除同步）。
    this.#snapLatest.clear();
    // N21：下一局若全员连接已意外离线，空置闹钟仍适用（重排最近候选）。
    this.#markIdleIfEmpty(Date.now());
    this.#rescheduleAlarms(Date.now());
    return { ok: true, generation: Number(meta.generation) };
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
    // N18（N15 复审 O2）：比赛进行中退出视为淘汰——以服务端接收时刻入账并
    // 参与终局裁决；冻结名单不改写（eliminations 独立于 seats，名次复盘保留）。
    const config = this.#readConfig();
    if (
      config !== null &&
      config.generation === Number(meta.generation) &&
      config.state === 'RUNNING'
    ) {
      const row = this.#readMatchState(Number(meta.generation));
      if (row !== undefined) {
        this.#applyEliminations([playerId], Number(meta.generation), row.match_id, Date.now());
      }
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
      // N21：最后一人主动离开 → 立即释放业务数据并取消待触发闹钟。
      this.#releaseRoomData();
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
      // N20：单席位重连——新连接**替换**旧连接：关闭该席位存量 socket（含
      // 无活 socket 的陈旧声明），随后重新声明。旧 socket 的 close 事件经
      // conn_id 核验不会误伤新声明（#releaseSeatConn）。
      for (const ws of this.ctx.getWebSockets()) {
        const att = this.#attachmentOf(ws);
        if (
          att !== null &&
          att.playerId === row.player_id &&
          att.generation === Number(meta.generation)
        ) {
          try {
            ws.close(4003, 'replaced');
          } catch {
            // 已关闭：忽略。
          }
        }
      }
      this.#sql.exec('DELETE FROM seat_conns WHERE player_id = ?', row.player_id);
      this.#sql.exec(
        'INSERT INTO seat_conns (player_id, generation) VALUES (?, ?)',
        row.player_id,
        Number(meta.generation),
      );
    }
    return { ok: true, playerId: row.player_id, generation: Number(meta.generation) };
  }

  // —— N14：WebSocket Hibernation 接线（不与 ws.accept 混用）——

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 热重启/驱逐重建后恢复连接上下文：按附件核验席位与代际，失效连接即刻关闭
    // 并释放连接声明；房间配置从 SQLite 读取，无常驻内存、无轮询。
    this.#restoreHibernated();
    // N17：闹钟由持久化 deadline 重建（驱逐后 Alarm 可能丢失，不依赖连接/心跳）。
    this.#restoreAlarms();
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
    // N20：连接身份 connId（close 事件核验，替换后的旧 socket 关闭不误伤新
    // 声明）；重连成功即清空断线标记。consumeTicket 之后到附件序列化之间
    // 无 await，声明写入与标记清空构成同步段。
    const connId = randomHex(8);
    this.#sql.exec(
      'UPDATE seat_conns SET conn_id = ? WHERE player_id = ? AND generation = ?',
      connId,
      result.playerId,
      result.generation,
    );
    this.#sql.exec('UPDATE seats SET disconnected_at = NULL WHERE player_id = ?', result.playerId);
    // workers-types：acceptWebSocket 第二参为 tags；附件经 serializeAttachment 随
    // socket 持久化，休眠/重建后 deserializeAttachment 恢复席位身份。
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({
      playerId: result.playerId,
      generation: result.generation,
      connId,
    } satisfies WsAttachment);
    // N21：恢复活动连接 → 清空空置起点（残留空置闹钟下次触发时自愈失效）。
    this.#sql.exec('UPDATE room_meta SET idle_since = NULL WHERE id = 1');
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
        return jsonError(result.error, 401);
      }
      return client !== null
        ? new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit)
        : new Response(null, { status: 101 });
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * N25：入站消息管线（席位身份只认连接附件，客户端不可冒充）：
   * 二进制帧关闭 → 每秒硬限流（解析前丢弃）→ 原始字节硬上限（1MiB 不进解析）
   * → 信封严格校验（版本/白名单/禁止字段/seq）→ 连接内 seq 严格单调（陈旧/
   * 重复丢弃）→ 按类型分派。校验失败回复 error（受同一限流约束，不放大）。
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const att = this.#attachmentOf(ws);
    if (att === null) {
      ws.close(4001, 'attachment missing');
      return;
    }
    // N25：协议仅文本帧；二进制直接关闭（不解析、不回复，防放大）。
    if (typeof message !== 'string') {
      ws.close(4003, 'binary frame not allowed');
      return;
    }
    // liveness：平台健康检查/烟测的裸 'ping'（非协议信封，保持 N14 语义）。
    // 有意豁免 20/s 限流：固定 4 字节成本、1:1 pong、连接数 ≤6 有界（N14 契约）。
    if (message === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    // N25：每秒硬上限——超限消息在解析前丢弃（恶意 100Hz 不放大 CPU）。
    if (!this.#allowInbound(att.connId, Date.now())) return;
    // N25：原始字节硬上限（4KiB 口径）：UTF-16 长度先行廉价预检（字节数 ≥ 长度，
    // 长度超则字节必超，1MiB 恶意报文不进 TextEncoder/JSON 解析），
    // 再以 TextEncoder 实际 UTF-8 字节数严格拒绝（多字节字符不放大门槛）。
    if (message.length > MAX_MESSAGE_BYTES || !withinMessageLimit(message)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.#sendProtocolError(ws, 'BAD_MESSAGE');
      return;
    }
    const result = validateClientMessage(parsed);
    if (!result.ok) {
      if (result.code === 'PROTOCOL_VERSION') {
        // 冻结契约（shared/protocol.ts 注释 1）：先回 error(PROTOCOL_VERSION) 再 1002 关闭。
        this.#sendProtocolError(ws, 'PROTOCOL_VERSION');
        ws.close(VERSION_CLOSE_CODE, 'protocol version mismatch');
        return;
      }
      this.#sendProtocolError(ws, result.code);
      return;
    }
    const msg = result.value;
    // N25：连接内 seq 严格单调递增——陈旧/重复/乱序回退消息丢弃（不回复）。
    const lastSeq = this.#connSeq.get(att.connId) ?? -1;
    if (msg.seq <= lastSeq) return;
    this.#connSeq.set(att.connId, msg.seq);
    switch (msg.type) {
      case 'ping': {
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'pong',
            seq: msg.seq,
            serverTime: Date.now(),
          }),
        );
        return;
      }
      case 'snapshot': {
        this.#ingestSnapshot(att, msg);
        return;
      }
      case 'gameover': {
        // N18 接线：matchId 由服务器当前局供给（客户端不可指定），淘汰时刻
        // 为服务端接收时刻（禁止客户端指定时间）。
        const matchId = this.#currentMatchId();
        if (matchId !== null) this.reportElimination(att.playerId, matchId, Date.now());
        return;
      }
      case 'ready': {
        this.setReady(att.playerId, true);
        return;
      }
      case 'start': {
        this.startGame(att.playerId);
        return;
      }
      case 'leave': {
        this.leaveRoom(att.playerId);
        return;
      }
      case 'settings_update': {
        // 大厅设置的服务端接线属 N33（当前经 HTTP 配置路径，WS 通道暂不放大）。
        return;
      }
    }
  }

  /** N25：每连接每秒滑窗硬限流（窗口 ≤INBOUND_RATE_PER_SEC 条，随连接清理）。 */
  #allowInbound(connId: string, now: number): boolean {
    let window = this.#connRate.get(connId);
    if (window === undefined) {
      window = [];
      this.#connRate.set(connId, window);
    }
    const cutoff = now - 1000;
    let drop = 0;
    while (drop < window.length && window[drop] <= cutoff) drop += 1;
    if (drop > 0) window.splice(0, drop);
    if (window.length >= INBOUND_RATE_PER_SEC) return false;
    window.push(now);
    return true;
  }

  /**
   * N25：快照入账（只读 SQLite、零写入）。仅接受：当前代际、RUNNING、
   * 该局冻结名单内且未淘汰的参赛者；快照 seq 每局每人严格单调（陈旧丢弃）。
   * 客户端声明的 status/分数不参与任何裁决（权威在服务器状态机）。
   */
  #ingestSnapshot(att: WsAttachment, msg: SnapshotMsg): void {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1 || att.generation !== Number(meta.generation)) return;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation) || config.state !== 'RUNNING') {
      return;
    }
    const row = this.#readMatchState(Number(meta.generation));
    if (row === undefined) return;
    const matchId = String(row.match_id) as MatchId;
    const roster = [
      ...this.#sql.exec<{ player_id: string }>(
        'SELECT player_id FROM match_roster WHERE player_id = ? AND generation = ?',
        att.playerId,
        att.generation,
      ),
    ];
    if (roster.length === 0) return; // 非该局冻结名单成员（附件身份，不可冒充）
    const eliminated = [
      ...this.#sql.exec<{ n: number }>(
        'SELECT 1 AS n FROM eliminations WHERE player_id = ? AND generation = ? AND match_id = ?',
        att.playerId,
        att.generation,
        matchId,
      ),
    ];
    if (eliminated.length > 0) return; // 已淘汰：不再接收其快照
    const prev = this.#snapLatest.get(att.playerId);
    if (prev !== undefined && (prev.matchId !== matchId || msg.snapshot.seq <= prev.seq)) {
      return; // 陈旧/重复快照（跨局残留同样丢弃）
    }
    this.#snapLatest.set(att.playerId, {
      encoded: JSON.stringify(msg.snapshot),
      seq: msg.snapshot.seq,
      matchId,
      receivedAt: Date.now(),
    });
  }

  /** 当前 RUNNING 局的 matchId（非 RUNNING/无局返回 null）。 */
  #currentMatchId(): MatchId | null {
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return null;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation) || config.state !== 'RUNNING') {
      return null;
    }
    const row = this.#readMatchState(Number(meta.generation));
    return row === undefined ? null : (String(row.match_id) as MatchId);
  }

  /** 协议 error 回复（message/retryable 取自 shared 错误目录；revision 暂硬编码 1，N26 统一修订号接管）。 */
  #sendProtocolError(ws: WebSocket, code: string): void {
    const meta = describeError(code);
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'error',
        revision: 1,
        code,
        message: meta.message,
        retryable: meta.retryable,
      }),
    );
  }

  /**
   * N25：出站背压投递——ws.bufferedAmount 超阈值时只入单槽（覆盖旧帧保留新帧，
   * 慢客户端不积压陈旧快照）；缓冲回落后先补发槽内最新帧。N26 快照路由使用。
   */
  deliverFrame(connId: string, ws: WebSocket, text: string): void {
    const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > OUTBOUND_BUFFER_LIMIT) {
      this.#outSlots.set(connId, text); // 单槽覆盖：丢弃旧帧，保留新帧
      return;
    }
    const slot = this.#outSlots.get(connId);
    if (slot !== undefined) {
      this.#outSlots.delete(connId);
      if (slot !== text) ws.send(slot);
    }
    ws.send(text);
  }

  /** N25：读取席位最新快照槽（N26 单目标路由/测试用；无则 null）。 */
  peekSnapshot(playerId: string): SnapshotSlot | null {
    return this.#snapLatest.get(playerId) ?? null;
  }

  /** N25：管线内存态规模（全部受席位/连接数约束；测试断言有界性）。 */
  pipelineStats(): { snapshots: number; conns: number; outSlots: number } {
    return {
      snapshots: this.#snapLatest.size,
      conns: this.#connSeq.size,
      outSlots: this.#outSlots.size,
    };
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
      !Number.isInteger((raw as WsAttachment).generation) ||
      typeof (raw as WsAttachment).connId !== 'string'
    ) {
      return null;
    }
    return raw as WsAttachment;
  }

  /**
   * N20：断线处理——按 conn_id 核验释放本连接自己的声明（替换后的旧 socket
   * 关闭事件 changes()=0，不误伤新声明）；成功释放则记录服务端断线时刻。
   * 该局参赛者的宽限到期淘汰经闹钟触发（#handleGraceExpiry）；非参赛者席位
   * 数据存续至房间到期/主动离开——与 30 分钟房间清理（N21）互不混同。
   */
  #releaseSeatConn(ws: WebSocket): void {
    const att = this.#attachmentOf(ws);
    if (att === null) return;
    // N25：连接终结即清理其内存管线态（含被替换的陈旧 connId，防 Map 无界增长）。
    this.#connSeq.delete(att.connId);
    this.#connRate.delete(att.connId);
    this.#outSlots.delete(att.connId);
    this.#ensureSchema();
    this.#sql.exec(
      'DELETE FROM seat_conns WHERE player_id = ? AND conn_id = ?',
      att.playerId,
      att.connId,
    );
    const released = Number(
      this.#sql.exec<{ c: number }>('SELECT changes() AS c').one().c,
    );
    if (released !== 1) return; // 已被替换的陈旧 close：不清标记、不排闹钟
    const now = Date.now();
    this.#sql.exec('UPDATE seats SET disconnected_at = ? WHERE player_id = ?', now, att.playerId);
    // N21：若本连接是最后一条活动连接 → 记录空置起点（空置闹钟候选）。
    this.#markIdleIfEmpty(now);
    this.#maybeScheduleGraceAlarm(now);
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
