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
  LeaderboardEntry,
  MatchEndMsg,
  MatchId,
  MatchStartMsg,
  PlayerJoinedMsg,
  PlayerLeftMsg,
  PlayerStatus,
  PlayerView,
  RandomMode,
  RngAlgo,
  RoomCode,
  RoomPhase,
  RoomSettings,
  RoomStateMsg,
  ScoreboardMsg,
  SnapshotMsg,
  WatchTargetMsg,
} from '../../shared/protocol';
import { describeError } from '../../shared/errors';
import { validateClientMessage, withinMessageLimit } from '../../shared/validate';
import { buildLeaderboard, type LeaderboardRow } from './leaderboard';
import { pickWatchTarget, type WatchCandidate } from './watch-target';
import type { Env } from './index';

type RoomMetaRow = { generation: number; occupied: number };

// N25：入站硬限流——每连接每秒消息上限（客户端快照节奏 5Hz，留 4 倍余量；
// 超限在 JSON 解析**之前**丢弃，恶意 100Hz 不放大 CPU/内存）。
const INBOUND_RATE_PER_SEC = 20;
// N25：出站背压阈值——ws.bufferedAmount 超过此值时快照帧只入单槽队列
// （丢弃旧帧保留新帧），缓冲回落后补发。槽数受连接数约束（≤6）。
const OUTBOUND_BUFFER_LIMIT = 16_384;
// N28：排行榜广播最小间隔（最高 2Hz；方案 §5:129「排行榜最多广播 2 次／秒」）。
const SCOREBOARD_MIN_INTERVAL_MS = 500;
// N42：出站目标帧率限——每连接（每人至多 1 路目标流）相邻 remote_snapshot 最小间隔
// 200ms（≤5Hz，与客户端 publisher 节奏一致）。入站 20/s 限流放行的高频快照不得向
// 观察者放大；目标切换补发帧不受此限（一次性关键帧，且刷新限流时戳）。
const OUTBOUND_FRAME_MIN_INTERVAL_MS = 200;
// N42：背压槽自动补发重试间隔——槽内最新帧若因缓冲未回落迟迟没有下一帧触发投递，
// 定时器到点主动重试一次（保证「最新态必达」；每连接至多一个定时器，随连接清理）。
const SLOT_FLUSH_RETRY_MS = 500;

/** N25：席位最新快照槽（内存态，绝不写 SQLite；N26 单目标路由读取源）。 */
export type SnapshotSlot = {
  encoded: string;
  seq: number;
  matchId: MatchId;
  receivedAt: number;
  /** N28：入账时提取的成绩（榜单构建免重复解析；快照校验保证为有限数）。 */
  score: number;
  lines: number;
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
  // N42：connId → 最近一次向该连接投递目标帧的时刻（出站 ≤5Hz 门控；随连接清理）。
  readonly #frameLastAt = new Map<string, number>();
  // N42：connId → 背压槽补发重试定时器（每连接至多一个；随连接/业务释放清理）。
  readonly #slotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // —— N26：观察订阅映射（内存态，每局重建；席位 ≤6）——
  // playerId → 当前观察目标（目标永不为自身；开局建默认环，N29 纯函数/N30 周期重估替换）。
  readonly #watchTarget = new Map<string, string>();
  // targetPlayerId → 观察该目标的席位集合（反向索引：快照扇出 O(观察者数)，杜绝 O(N²) 全发）。
  readonly #watchersOf = new Map<string, Set<string>>();
  // —— N28：服务端消息 revision 与排行榜 dirty 批处理（内存态；无常驻定时器、
  // 无每变更 Alarm——仅在有 pending 变更且处于静默窗时挂单个一次性定时器）——
  // 房间级消息 revision：每个广播批次/单发消息递增一次（同 revision ⇒ 内容一致）。
  #revision = 0;
  // 榜单脏标记：成绩/状态变化置位，广播时才重排（不按每个快照全员重排）。
  #sbDirty = false;
  // 上次榜单广播时刻（null=本局尚未发过，首个变化立即发）。
  #sbLastSentAt: number | null = null;
  // 上次广播的 entries 序列化（内容一致则跳过发布，不占 revision）。
  #sbLastEntriesJson: string | null = null;
  // 上次广播榜单的 revision（N44：attach 补发复用同一 revision，内容一致语义不变）。
  #sbLastRevision: number | null = null;
  // 静默窗内合并多个变化的单个一次性定时器（发出即清空；无变化永不挂）。
  #sbTimer: ReturnType<typeof setTimeout> | null = null;

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
    // N33：房间码持久化（room_state 回显用；DO 与码经 idFromName 一一映射，
    // 占用时写入、WS 握手路径兜底补写，同一 DO 生命周期内恒定）。
    try {
      sql.exec('ALTER TABLE room_config ADD COLUMN room_code TEXT');
    } catch {
      // 列已存在（N33 前旧库）：幂等忽略。
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
  async createRoom(req: CreateRoomRequest, roomCode?: string): Promise<CreateClaim> {
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
         (id, capacity, random_mode, start_level, custom_seed, generation, room_code)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      req.capacity,
      req.randomMode,
      req.startLevel,
      req.customSeed ?? null,
      generation,
      roomCode ?? null,
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
    // N33：加入成功即向已连接席位广播 player_joined + room_state（大厅实时刷新；
    // 新加入者尚未连接 WS，只收 HTTP 响应）。
    const joinedView: PlayerView = {
      playerId,
      nickname,
      seatIndex: joinOrder,
      isHost: false,
      ready: false,
      status: 'lobby',
      score: 0,
      lines: 0,
      level: settings.startLevel,
    };
    const joinedRevision = this.#nextRevision();
    this.#broadcast(
      () =>
        ({
          v: PROTOCOL_VERSION,
          type: 'player_joined',
          revision: joinedRevision,
          player: joinedView,
        }) as PlayerJoinedMsg,
    );
    this.#sendRoomState();
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
   * N33：席位公开视图（PlayerView[]，无令牌）。状态映射：LOBBY 下按
   * 准备/断线标记；COUNTDOWN/RUNNING 下按淘汰表/断线标记；FINISHED 下
   * 淘汰/完赛。成绩取内存快照槽（无则 0），等级按 startLevel+⌊lines/10⌋。
   */
  #playerViews(): PlayerView[] {
    const lobby = this.getLobbyState();
    if (lobby === null) return [];
    const eliminated = new Set(
      [
        ...this.#sql.exec<{ player_id: string }>(
          'SELECT player_id FROM eliminations WHERE generation = ?',
          lobby.generation,
        ),
      ].map((r) => r.player_id),
    );
    return lobby.seats.map((seat) => {
      const snap = this.#snapLatest.get(seat.playerId);
      const score = snap?.score ?? 0;
      const lines = snap?.lines ?? 0;
      const disconnected = seat.disconnectedAt !== null;
      let status: PlayerStatus;
      if (lobby.state === 'LOBBY') {
        status = disconnected ? 'disconnected' : seat.isReady ? 'ready' : 'lobby';
      } else if (lobby.state === 'FINISHED') {
        status = eliminated.has(seat.playerId) ? 'eliminated' : 'finished';
      } else {
        status = eliminated.has(seat.playerId)
          ? 'eliminated'
          : disconnected
            ? 'disconnected'
            : 'playing';
      }
      return {
        playerId: seat.playerId,
        nickname: seat.nickname,
        seatIndex: seat.joinOrder,
        isHost: seat.isHost,
        ready: seat.isReady,
        status,
        score,
        lines,
        level: lobby.settings.startLevel + Math.floor(lines / 10),
      };
    });
  }

  /**
   * N33：room_state 载荷（房间级同一份；revision 每次调用递增一次，广播内
   * 全员同 revision ⇒ 内容完全一致）。未占用/代际不符返回 null。
   */
  #roomStatePayload(): RoomStateMsg | null {
    this.#ensureSchema();
    this.#ensureRow();
    const lobby = this.getLobbyState();
    if (lobby === null) return null;
    const codeRow = [
      ...this.#sql.exec<{ room_code: string | null }>(
        'SELECT room_code FROM room_config WHERE id = 1',
      ),
    ][0];
    const match =
      lobby.state === 'COUNTDOWN' || lobby.state === 'RUNNING' || lobby.state === 'FINISHED'
        ? this.#readMatchState(lobby.generation)
        : undefined;
    return {
      v: PROTOCOL_VERSION,
      type: 'room_state',
      revision: this.#nextRevision(),
      roomGeneration: lobby.generation,
      phase: lobby.state,
      roomCode: (codeRow?.room_code ?? '') as RoomCode,
      settings: lobby.settings,
      players: this.#playerViews(),
      matchId: match === undefined ? null : (String(match.match_id) as MatchId),
      startAt: match === undefined ? null : Number(match.start_at),
      deadlineAt: match === undefined ? null : Number(match.deadline_at),
      serverTime: Date.now(),
    };
  }

  /** N33：向全部活动连接广播同一份 room_state（单 revision、单 JSON 序列化）。 */
  #sendRoomState(): void {
    const payload = this.#roomStatePayload();
    if (payload === null) return;
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.#attachmentOf(ws) === null) continue;
      ws.send(text);
    }
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
    // N26：订阅映射随局作废（RUNNING 时按冻结名单重建默认环）。
    this.#watchTarget.clear();
    this.#watchersOf.clear();
    // N28：榜单批处理态随局作废（开局首榜在 advanceToRunning 重新发布）。
    this.#resetScoreboardBatch();
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
    const countdownRevision = this.#nextRevision();
    this.#broadcast((playerId) => {
      void playerId;
      return {
        v: PROTOCOL_VERSION,
        type: 'countdown',
        revision: countdownRevision,
        matchId,
        startAt,
        deadlineAt,
      };
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
    const matchStartRevision = this.#nextRevision();
    this.#broadcast((playerId) => ({
      v: PROTOCOL_VERSION,
      type: 'match_start',
      revision: matchStartRevision,
      matchId: row.match_id,
      startAt,
      deadlineAt: Number(row.deadline_at),
      rngAlgo: row.rng_algo as RngAlgo,
      seatSeed: config.randomMode === 'S2' ? deriveSeatSeed(masterSeed, playerId) : masterSeed,
      seatIndex: seatIndex.get(playerId) ?? 0,
      startLevel: config.startLevel,
    }));
    // N30：观战目标不再预置默认环——开局首榜发布时经 #flushScoreboard 钩子用
    // N29 纯函数计算自动目标并逐席位单发 watch_target（同一事件内完成，无新定时器）。
    // N28：开局首榜（全员零分/playing；此后仅经 dirty 批处理发布，≤2Hz）。
    this.#sbDirty = true;
    this.#flushScoreboard(now);
    // 复审 P2-1（N30）：驱逐后延迟开赛（now ≥ startAt+500 且槽全空）首榜被 N28
    // 空槽守卫跳过 ⇒ 钩子未跑——仍须建立自动目标并通知（全零基线，随快照入账
    // ≤500ms/发布自纠），否则服务端按新映射路由而客户端从未收到 watch_target。
    if (this.#watchTarget.size === 0) {
      const changedTargets = this.#applyAutoWatchTargets(Number(meta.generation));
      this.#notifyWatchTargets(String(row.match_id), changedTargets);
    }
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
    if (now >= Number(row.deadline_at)) this.#endAtDeadline(Number(meta.generation), row.match_id, now);
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
    this.#frameLastAt.clear();
    for (const t of this.#slotTimers.values()) clearTimeout(t); // N42：补发定时器一并清理
    this.#slotTimers.clear();
    // N26：订阅映射随业务释放清空。
    this.#watchTarget.clear();
    this.#watchersOf.clear();
    // N28：榜单批处理态随业务释放清空（含未触发的一次性定时器）。
    this.#resetScoreboardBatch();
    void this.ctx.storage.deleteAlarm();
  }

  /**
   * N17：超时终局裁决（闹钟/重建路径专用，客户端无权触发）。finishGame 幂等门：
   * 非 RUNNING 直接返回，不重复广播。此刻尚无淘汰面（N18），名单全员存活 →
   * winners=冻结名单全体；最终名次 standings 由 N19 ranking 填充。
   */
  #endAtDeadline(generation: number, matchId: string, now = Date.now()): void {
    const res = this.finishGame();
    if (!res.finished) return;
    // N18：超时终局的胜者 = 冻结名单中未被淘汰的存活者（无淘汰时即全体）。
    const winners = this.#survivorsOf(generation, matchId);
    const matchEndRevision = this.#nextRevision();
    this.#broadcast(
      () =>
        ({
          v: PROTOCOL_VERSION,
          type: 'match_end',
          revision: matchEndRevision,
          matchId,
          reason: 'timeout',
          winners,
          standings: [],
        }) as MatchEndMsg,
    );
    // N28：终局为关键状态——最终榜单立即广播（得分降序不切换，方案 §5:131）。
    this.#markScoreboardDirty(true, now);
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
    build: (
      playerId: string,
    ) =>
      | CountdownMsg
      | MatchStartMsg
      | MatchEndMsg
      | PlayerLeftMsg
      | PlayerJoinedMsg
      | ScoreboardMsg,
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

  /** N28：房间级消息 revision（每广播批次/单发消息递增一次；同 revision ⇒ 内容完全一致）。 */
  #nextRevision(): number {
    this.#revision += 1;
    return this.#revision;
  }

  /**
   * N28：成绩/状态变化标记榜单 dirty。事件时间戳门控最高 2Hz：距上次广播
   * ≥500ms 立即随事件发出（零额外定时器）；静默窗内只挂**一个**一次性定时器
   * 合并全部变化（无待发送变化时不唤醒：无常驻 500ms 定时器、绝不每次变更
   * 调 Alarm）。关键状态（淘汰/终局）immediate=true 立即广播。
   */
  #markScoreboardDirty(immediate: boolean, now: number = Date.now()): void {
    this.#sbDirty = true;
    if (immediate) {
      this.#flushScoreboard(now);
      return;
    }
    if (this.#sbTimer !== null) return; // 已合并：不重复挂、不重置窗口
    if (this.#sbLastSentAt === null || now - this.#sbLastSentAt >= SCOREBOARD_MIN_INTERVAL_MS) {
      this.#flushScoreboard(now);
      return;
    }
    const wait = SCOREBOARD_MIN_INTERVAL_MS - (now - this.#sbLastSentAt);
    this.#sbTimer = setTimeout(() => {
      this.#sbTimer = null;
      this.#flushScoreboard(Date.now());
    }, wait);
  }

  /**
   * N28：榜单唯一重排/发布点（dirty 才构建；每 ≤500ms 至多一次，全员同一份
   * entries+revision）。数据源：冻结名单 + 淘汰表 + 席位断线标记 + 内存快照槽
   * （**零写库**，读查询受席位规模约束）。
   */
  #flushScoreboard(now: number): void {
    if (this.#sbTimer !== null) {
      clearTimeout(this.#sbTimer);
      this.#sbTimer = null;
    }
    if (!this.#sbDirty) return;
    this.#sbDirty = false;
    this.#ensureSchema();
    this.#ensureRow();
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return;
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation)) return;
    const generation = Number(meta.generation);
    const row = this.#readMatchState(generation);
    if (row === undefined) return; // 未开局（LOBBY/COUNTDOWN）：无榜单可发
    const matchId = String(row.match_id);
    const eliminated = new Set(
      [
        ...this.#sql.exec<{ player_id: string }>(
          'SELECT player_id FROM eliminations WHERE generation = ? AND match_id = ?',
          generation,
          matchId,
        ),
      ].map((r) => r.player_id),
    );
    const disconnected = new Map<string, number>();
    for (const s of this.#sql.exec<{ player_id: string; disconnected_at: number | null }>(
      'SELECT player_id, disconnected_at FROM seats WHERE generation = ?',
      generation,
    )) {
      if (s.disconnected_at !== null) disconnected.set(s.player_id, Number(s.disconnected_at));
    }
    const rows: LeaderboardRow[] = [];
    let anySlot = false;
    for (const r of this.#sql.exec<{ player_id: string; nickname: string; join_order: number }>(
      'SELECT player_id, nickname, join_order FROM match_roster WHERE generation = ? ORDER BY join_order ASC',
      generation,
    )) {
      const slot = this.#snapLatest.get(r.player_id);
      if (slot !== undefined) anySlot = true;
      let status: PlayerStatus = 'playing';
      if (eliminated.has(r.player_id)) status = 'eliminated';
      else if (disconnected.has(r.player_id)) status = 'disconnected';
      rows.push({
        playerId: r.player_id,
        nickname: r.nickname,
        score: slot?.score ?? 0,
        lines: slot?.lines ?? 0,
        joinOrder: Number(r.join_order),
        status,
      });
    }
    if (rows.length === 0) return;
    // 复审 P2-1（N28）：DO 驱逐后内存槽全空——若已开球 ≥500ms 仍无人入账，跳过发布
    // （全员 0 分榜会覆盖客户端已显示的正确榜；发布错误榜劣于不发布；后续快照入账
    // 自然重建。开局首榜在 now===startAt 发布，不受此守卫影响）。
    if (!anySlot && now - Number(row.start_at) >= SCOREBOARD_MIN_INTERVAL_MS) return;
    const entries = buildLeaderboard(rows);
    // 方案 §5：榜单内容无变化不重复推送（不占 revision、不刷新发布时刻）。
    const entriesJson = JSON.stringify(entries);
    if (entriesJson === this.#sbLastEntriesJson) return;
    const revision = this.#nextRevision();
    this.#broadcast(
      () => ({ v: PROTOCOL_VERSION, type: 'scoreboard', revision, entries }) as ScoreboardMsg,
    );
    this.#sbLastSentAt = now;
    this.#sbLastEntriesJson = entriesJson;
    this.#sbLastRevision = revision;
    // N30：排行榜 revision 已发布 ⇒ 同一事件内重估观战目标（复用榜单已读的名单/槽，
    // 不新增定时器），仅向目标改变的观看者逐席位单发 watch_target（方案 §6.2.4：
    // 仅通知当前观看者；公共排行榜本身不因目标而变）。
    // 复审 O-2：仅 RUNNING 重估——终局（FINISHED）最终榜发布后不再发 watch_target/补帧。
    if (config.state === 'RUNNING') {
      const changedTargets = this.#applyAutoWatchTargets(generation);
      this.#notifyWatchTargets(matchId, changedTargets);
    }
  }

  /** N28：局/房间切换作废榜单批处理态（revision 计数保持单调，防陈旧定时器补发）。 */
  #resetScoreboardBatch(): void {
    if (this.#sbTimer !== null) {
      clearTimeout(this.#sbTimer);
      this.#sbTimer = null;
    }
    this.#sbDirty = false;
    this.#sbLastSentAt = null;
    this.#sbLastEntriesJson = null;
    this.#sbLastRevision = null;
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
      const leftRevision = this.#nextRevision();
      this.#broadcast(
        () =>
          ({
            v: PROTOCOL_VERSION,
            type: 'player_left',
            revision: leftRevision,
            playerId,
            reason,
          }) as PlayerLeftMsg,
      );
      accepted.push(playerId);
    }
    // N28：淘汰属关键状态——榜单立即广播（死人留榜、分数冻结在最后快照）。
    if (accepted.length > 0) this.#markScoreboardDirty(true, now);
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
      this.#endMatchWithWinners(matchId, winners, now);
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
  #endMatchWithWinners(matchId: string, winners: string[], now = Date.now()): void {
    const res = this.finishGame();
    if (!res.finished) return;
    const matchEndRevision = this.#nextRevision();
    this.#broadcast(
      () =>
        ({
          v: PROTOCOL_VERSION,
          type: 'match_end',
          revision: matchEndRevision,
          matchId,
          reason: 'survival',
          winners,
          standings: [],
        }) as MatchEndMsg,
    );
    // N28：终局为关键状态——最终榜单立即广播。
    this.#markScoreboardDirty(true, now);
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
    // N26：订阅映射同样随局作废（RUNNING 时重建默认环）。
    this.#watchTarget.clear();
    this.#watchersOf.clear();
    // N28：榜单批处理态随局作废。
    this.#resetScoreboardBatch();
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
    // N26：离开者摘除观察订阅（不再收流，也不再作为观察者计入扇出）。
    this.#unwatch(playerId);
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
    // N28：重连恢复「连接中断」标记属状态变化（非关键，走批处理）。
    this.#markScoreboardDirty(false);
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
    // N33：新连接建立即下发当前 room_state（大厅首屏；后续经广播增量维护）。
    // 走全量广播而非单发：新 socket 已 accept+attach 在 getWebSockets 内，
    // 既收到自己的首帧，也让其他席位即时摆脱「连接中断」陈旧标记（复审 P2）。
    this.#sendRoomState();
    // N44（跨网 E2E 复现）：榜单「内容无变化不重发」+ 刷新重连竞态（新 attach 先于
    // 旧连接 close 处理 ⇒ 全程无状态变化）会让重连客户端整局收不到 scoreboard，
    // 对手面板停在「等待对手…」。attach 后向新连接单发当前已发布榜（同 revision，
    // 内容一致语义不变；客户端无去重，直接覆盖）。仅 RUNNING 且内存已有已发布榜；
    // DO 驱逐后为 null，等下次快照入账自然广播（复审 O：驱逐窗内不补发空榜）。
    if (this.#sbLastEntriesJson !== null && this.#sbLastRevision !== null
      && this.#readConfig()?.state === 'RUNNING') {
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'scoreboard',
          revision: this.#sbLastRevision,
          entries: JSON.parse(this.#sbLastEntriesJson) as LeaderboardEntry[],
        } satisfies ScoreboardMsg),
      );
    }
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
      // N33：握手路径兜底持久化房间码（DO↔码经 idFromName 恒定映射；
      // 占用时 createRoom 已写入，此处覆盖直连测试与历史库缺列场景），
      // 先于 attachWebSocket 内的首帧 room_state，保证首屏房间码正确。
      // N43：条件写——room_code 已相同则 0 行变更（SQLite 不计 Rows written），
      // 消除重连风暴下每握手一次的冗余写放大。
      this.#ensureSchema();
      this.#sql.exec(
        'UPDATE room_config SET room_code = ? WHERE id = 1 AND (room_code IS NULL OR room_code != ?)',
        decodeURIComponent(url.pathname.slice('/ws/'.length)),
        decodeURIComponent(url.pathname.slice('/ws/'.length)),
      );
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
    // N43：裸 ping 同样计入每连接 20/s 速率门（恶意连接 ping 风暴的 1:1 pong
    // 放大因此有界）；合法客户端保活走信封 ping，裸 ping 仅烟测脚本，远低于限。
    // N25：每秒硬上限——超限消息在解析前丢弃（恶意 100Hz 不放大 CPU）。
    if (!this.#allowInbound(att.connId, Date.now())) return;
    if (message === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
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
        // N33：准备状态变更 → 全员 room_state 刷新；拒绝回 error（中文目录）。
        const result = this.setReady(att.playerId, true);
        if (result.ok) {
          this.#sendRoomState();
        } else {
          this.#sendProtocolError(ws, result.error);
        }
        return;
      }
      case 'start': {
        // N39-a：终局阶段收到 start = 房主下一局触发（FINISHED→LOBBY，全员重新
        // 准备）。§7.2 C→S 白名单无独立下一局消息，语义由服务端按房间阶段裁决；
        // 非房主 → NOT_HOST，非终局竞态 → BAD_STATE 映射目录 NOT_IN_GAME。
        if (this.#readConfig()?.state === 'FINISHED') {
          const result = this.nextRound(att.playerId);
          if (result.ok) {
            this.#sendRoomState();
          } else {
            this.#sendProtocolError(ws, result.error === 'BAD_STATE' ? 'NOT_IN_GAME' : result.error);
          }
          return;
        }
        const result = this.startGame(att.playerId);
        // N33：开局失败定向回 error（PLAYERS_NOT_READY 复用目录 NOT_READY 文案；
        // 成功路径的 countdown 广播在 startGame 内原子段完成）。
        if (!result.started) {
          this.#sendProtocolError(
            ws,
            result.error === 'PLAYERS_NOT_READY' ? 'NOT_READY' : result.error,
          );
        } else {
          // N33：开局成功 → room_state 携带 COUNTDOWN 阶段与 startAt/deadlineAt。
          this.#sendRoomState();
        }
        return;
      }
      case 'leave': {
        const result = this.leaveRoom(att.playerId);
        if (!result.left) {
          this.#sendProtocolError(ws, result.error);
          return;
        }
        // N33：主动退出广播 player_left（含房主转让后的 room_state；
        // 房间随之关闭则不再广播状态）。
        const leftRevision = this.#nextRevision();
        this.#broadcast(
          () =>
            ({
              v: PROTOCOL_VERSION,
              type: 'player_left',
              revision: leftRevision,
              playerId: att.playerId,
              reason: 'left',
            }) as PlayerLeftMsg,
        );
        if (!result.roomClosed) this.#sendRoomState();
        return;
      }
      case 'settings_update': {
        // N33：房主大厅设置（updateConfig 内原子校验：仅 LOBBY、仅房主、
        // 改后全员准备清零；非法回 error，成功广播 room_state）。
        const result = this.updateConfig(att.playerId, {
          capacity: msg.capacity,
          randomMode: msg.randomMode,
          startLevel: msg.startLevel,
          customSeed: msg.customSeed,
        });
        if (result.updated) {
          this.#sendRoomState();
        } else {
          this.#sendProtocolError(ws, result.error);
        }
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
      score: msg.snapshot.score,
      lines: msg.snapshot.lines,
    });
    // P2-1（N26 复审）：DO 驱逐/重建后内存订阅映射丢失——RUNNING 中惰性重建
    // 自动目标（N30：与正常重估同一算法；目标随后随榜单发布继续修正）。
    // 必须先于 dirty/flush：空映射下 flush 内重估会把全部席位判为“变化”而
    // 补发目标帧，与本帧路由重复。
    if (this.#watchTarget.size === 0) this.#applyAutoWatchTargets(Number(att.generation));
    // N28：成绩变化只置 dirty（不按每个快照全员重排）；分数/消行未变不标记。
    if (
      prev === undefined ||
      prev.score !== msg.snapshot.score ||
      prev.lines !== msg.snapshot.lines
    ) {
      this.#markScoreboardDirty(false);
    }
    // N26：单目标路由——只向当前观察该玩家的连接投递（扇出 O(观察者数)≤N-1，
    // 每席位至多一条目标流；绝不向全员转发造成 O(N²)）。
    const watchers = this.#watchersOf.get(att.playerId);
    if (watchers !== undefined && watchers.size > 0) {
      const slot = this.#snapLatest.get(att.playerId) as SnapshotSlot;
      const revision = this.#nextRevision();
      const text = `{"v":${PROTOCOL_VERSION},"type":"remote_snapshot","revision":${revision},"targetPlayerId":${JSON.stringify(att.playerId)},"snapshot":${slot.encoded}}`;
      // N42：出站 ≤5Hz 门控——同一连接相邻目标帧至少间隔 200ms；被丢弃的中间帧
      // 无信息损失（快照为最新态语义，后续帧携带更新状态）。
      const now = Date.now();
      for (const ws of this.ctx.getWebSockets()) {
        const wAtt = this.#attachmentOf(ws);
        if (wAtt === null || !watchers.has(wAtt.playerId)) continue;
        const last = this.#frameLastAt.get(wAtt.connId);
        if (last !== undefined && now - last < OUTBOUND_FRAME_MIN_INTERVAL_MS) continue;
        this.#frameLastAt.set(wAtt.connId, now);
        this.deliverFrame(wAtt.connId, ws, text);
      }
    }
  }

  /**
   * N26：设置席位观察目标（订阅映射）。校验：RUNNING、目标≠自身、观察方与
   * 目标均在本局冻结名单内（被淘汰者仍可被观察/继续观察）。成功即向该席位
   * 即时下发 watch_target（关键小消息直发）；目标已有本局最新帧则紧随补发
   * remote_snapshot（经背压单槽，慢连接只留最新）。
   * N30：手动目标为临时覆盖——下一次排行榜发布时自动算法按方案 §6.2 重估并
   * 覆盖（仅当重估结果与当前不同才再发 watch_target）。
   */
  setWatchTarget(playerId: string, targetPlayerId: string): { ok: true } | { ok: false; error: 'BAD_STATE' | 'INVALID_TARGET' } {
    this.#ensureSchema();
    this.#ensureRow();
    if (playerId === targetPlayerId) return { ok: false, error: 'INVALID_TARGET' };
    const meta = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    if (meta.occupied !== 1) return { ok: false, error: 'BAD_STATE' };
    const config = this.#readConfig();
    if (config === null || config.generation !== Number(meta.generation) || config.state !== 'RUNNING') {
      return { ok: false, error: 'BAD_STATE' };
    }
    const generation = Number(meta.generation);
    const row = this.#readMatchState(generation);
    if (row === undefined) return { ok: false, error: 'BAD_STATE' };
    const matchId = String(row.match_id) as MatchId;
    for (const id of [playerId, targetPlayerId]) {
      const inRoster = [
        ...this.#sql.exec<{ n: number }>(
          'SELECT 1 AS n FROM match_roster WHERE player_id = ? AND generation = ?',
          id,
          generation,
        ),
      ];
      if (inRoster.length === 0) return { ok: false, error: 'INVALID_TARGET' };
    }
    // P2-1（N26 复审）：驱逐重建后订阅映射为空——先惰性重建自动目标再改写。
    if (this.#watchTarget.size === 0) this.#applyAutoWatchTargets(generation);
    this.#setWatchMaps(playerId, targetPlayerId);
    const watchTargetRevision = this.#nextRevision();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.#attachmentOf(ws);
      if (att === null || att.playerId !== playerId) continue;
      // O2（N26 复审）：切换即弃背压槽内旧目标待补帧（客户端本就按 targetPlayerId
      // 丢弃非当前目标帧，服务端不留旧目标积压）。
      this.#outSlots.delete(att.connId);
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'watch_target',
          revision: watchTargetRevision,
          targetPlayerId,
        }),
      );
      const slot = this.#snapLatest.get(targetPlayerId);
      if (slot !== undefined && slot.matchId === matchId) {
        this.#frameLastAt.set(att.connId, Date.now()); // N42：补发帧刷新出站限流时戳
        this.deliverFrame(
          att.connId,
          ws,
          `{"v":${PROTOCOL_VERSION},"type":"remote_snapshot","revision":${this.#nextRevision()},"targetPlayerId":${JSON.stringify(targetPlayerId)},"snapshot":${slot.encoded}}`,
        );
      }
    }
    return { ok: true };
  }

  /**
   * N30：自动观战目标重估（N29 纯函数 pickWatchTarget）。
   * 候选=本局冻结名单全体（含淘汰/断线/倒计时离席者，成绩冻结仍参与比较，
   * 方案 §6.2.1）；观看者=名单∩现存席位（离席者无连接不占订阅）。
   * 仅在排行榜 revision 发布或驱逐惰性重建时调用（不按每个快照重估）；
   * 返回目标发生变化的观看者映射（供逐席位通知；惰性重建忽略返回值）。
   */
  #applyAutoWatchTargets(generation: number): Map<string, string> {
    const seated = new Set<string>(
      [
        ...this.#sql.exec<{ player_id: string }>(
          'SELECT player_id FROM seats WHERE generation = ?',
          generation,
        ),
      ].map((r) => String(r.player_id)),
    );
    const candidates: WatchCandidate[] = [
      ...this.#sql.exec<{ player_id: string; join_order: number }>(
        'SELECT player_id, join_order FROM match_roster WHERE generation = ? ORDER BY join_order ASC',
        generation,
      ),
    ].map((r) => {
      const slot = this.#snapLatest.get(String(r.player_id));
      return {
        playerId: String(r.player_id),
        score: slot?.score ?? 0,
        lines: slot?.lines ?? 0,
        joinOrder: Number(r.join_order),
      };
    });
    const changed = new Map<string, string>();
    for (const c of candidates) {
      if (!seated.has(c.playerId)) continue;
      const target = pickWatchTarget(c.playerId, candidates);
      if (target === null || target === this.#watchTarget.get(c.playerId)) continue;
      this.#setWatchMaps(c.playerId, target);
      changed.set(c.playerId, target);
    }
    return changed;
  }

  /**
   * N30：向目标改变的观看者逐席位单发 watch_target（同批次共享一个 revision，
   * 不变式按单连接成立）；切换即弃背压槽内旧目标待补帧（旧快照丢弃），目标
   * 已有本局最新帧则紧随补发（经背压单槽）。
   */
  #notifyWatchTargets(matchId: string, changed: Map<string, string>): void {
    if (changed.size === 0) return;
    const revision = this.#nextRevision();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.#attachmentOf(ws);
      if (att === null) continue;
      const target = changed.get(att.playerId);
      if (target === undefined) continue;
      this.#outSlots.delete(att.connId);
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'watch_target',
          revision,
          targetPlayerId: target,
        } as WatchTargetMsg),
      );
      const slot = this.#snapLatest.get(target);
      if (slot !== undefined && String(slot.matchId) === matchId) {
        this.#frameLastAt.set(att.connId, Date.now()); // N42：补发帧刷新出站限流时戳
        this.deliverFrame(
          att.connId,
          ws,
          `{"v":${PROTOCOL_VERSION},"type":"remote_snapshot","revision":${this.#nextRevision()},"targetPlayerId":${JSON.stringify(target)},"snapshot":${slot.encoded}}`,
        );
      }
    }
  }

  /** N26：订阅映射写入（旧目标的观察者集合同步收缩）。 */
  #setWatchMaps(playerId: string, target: string): void {
    const prev = this.#watchTarget.get(playerId);
    if (prev !== undefined && prev !== target) {
      const set = this.#watchersOf.get(prev);
      if (set !== undefined) {
        set.delete(playerId);
        if (set.size === 0) this.#watchersOf.delete(prev);
      }
    }
    this.#watchTarget.set(playerId, target);
    let set = this.#watchersOf.get(target);
    if (set === undefined) {
      set = new Set();
      this.#watchersOf.set(target, set);
    }
    set.add(playerId);
  }

  /** N26：席位删除（leaveRoom）时摘除其观察订阅。 */
  #unwatch(playerId: string): void {
    const prev = this.#watchTarget.get(playerId);
    if (prev !== undefined) {
      const set = this.#watchersOf.get(prev);
      if (set !== undefined) {
        set.delete(playerId);
        if (set.size === 0) this.#watchersOf.delete(prev);
      }
    }
    this.#watchTarget.delete(playerId);
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

  /** 协议 error 回复（message/retryable 取自 shared 错误目录；N28：revision 房间级单调）。 */
  #sendProtocolError(ws: WebSocket, code: string): void {
    const meta = describeError(code);
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'error',
        revision: this.#nextRevision(),
        code,
        message: meta.message,
        retryable: meta.retryable,
      }),
    );
  }

  /**
   * N25：出站背压投递——ws.bufferedAmount 超阈值时只入单槽（覆盖旧帧保留新帧，
   * 慢客户端不积压陈旧快照）；缓冲回落后先补发槽内最新帧。快照路由（N26）使用。
   */
  deliverFrame(connId: string, ws: WebSocket, text: string): void {
    const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > OUTBOUND_BUFFER_LIMIT) {
      this.#outSlots.set(connId, text); // 单槽覆盖：丢弃旧帧，保留新帧
      this.#armSlotTimer(connId); // N42：无后续帧时定时器兜底补发（最新态必达）
      return;
    }
    const slot = this.#outSlots.get(connId);
    if (slot !== undefined) {
      this.#outSlots.delete(connId);
      if (slot !== text) ws.send(slot);
    }
    ws.send(text);
  }

  /** N42：为背压槽挂一次性补发定时器（已有则不重复挂；到点经连接重查后走 deliverFrame）。 */
  #armSlotTimer(connId: string): void {
    if (this.#slotTimers.has(connId)) return;
    this.#slotTimers.set(
      connId,
      setTimeout(() => {
        this.#slotTimers.delete(connId);
        const slot = this.#outSlots.get(connId);
        if (slot === undefined) return;
        for (const ws of this.ctx.getWebSockets()) {
          const att = this.#attachmentOf(ws);
          if (att !== null && att.connId === connId) {
            // 缓冲已回落 → 补发；仍超限 → 重新入槽并重挂定时器。
            this.deliverFrame(connId, ws, slot);
            return;
          }
        }
        this.#outSlots.delete(connId); // 连接已终结：弃槽（连接清理路径兜底）
      }, SLOT_FLUSH_RETRY_MS),
    );
  }

  /** N25：读取席位最新快照槽（N26 单目标路由/测试用；无则 null）。 */
  peekSnapshot(playerId: string): SnapshotSlot | null {
    return this.#snapLatest.get(playerId) ?? null;
  }

  /** N25：管线内存态规模（全部受席位/连接数约束；测试断言有界性）。 */
  pipelineStats(): {
    snapshots: number;
    conns: number;
    outSlots: number;
    frameGateSize: number;
    slotTimerSize: number;
    watchTargets: number;
    sbRevision: number;
    sbDirty: boolean;
    sbTimerPending: boolean;
  } {
    return {
      snapshots: this.#snapLatest.size,
      conns: this.#connSeq.size,
      outSlots: this.#outSlots.size,
      frameGateSize: this.#frameLastAt.size, // N42：出站门控时戳表（≤连接数，随连接清理）
      slotTimerSize: this.#slotTimers.size, // N42：背压槽补发定时器（≤连接数，随连接清理）
      watchTargets: this.#watchTarget.size,
      sbRevision: this.#revision,
      sbDirty: this.#sbDirty,
      sbTimerPending: this.#sbTimer !== null,
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
    this.#frameLastAt.delete(att.connId); // N42：出站限流时戳随连接清理
    const slotTimer = this.#slotTimers.get(att.connId); // N42：补发定时器随连接清理
    if (slotTimer !== undefined) {
      clearTimeout(slotTimer);
      this.#slotTimers.delete(att.connId);
    }
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
    // N28：断线显示「连接中断」属状态变化（宽限期非关键，走 ≤2Hz 批处理；
    // 宽限到期淘汰是独立裁决，走关键立即通道）。
    this.#markScoreboardDirty(false, now);
    // N33：大厅/观战侧同步断线状态（status='disconnected'）。
    this.#sendRoomState();
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
