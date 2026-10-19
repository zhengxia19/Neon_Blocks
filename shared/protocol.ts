/**
 * 联网对战协议公共契约（前后端共享，纯类型与常量；禁止引用 DOM / Worker API）。
 * N02 固定版本与边界；N03 在此锁定消息模型、字段边界与兼容策略；N04 在 `shared/validate.ts` 实现运行时校验。
 *
 * 兼容策略（前后端必须一致）：
 * 1. `v` 必须精确等于 `PROTOCOL_VERSION`；不匹配 → 回 `error(PROTOCOL_VERSION)` 后以 WebSocket 1002 关闭连接。
 * 2. `type` 必须在对应方向的白名单内；未知类型 → 回 `error(UNKNOWN_TYPE)` 并忽略该条消息，连接保持。
 * 3. 客户端消息不得携带 `FORBIDDEN_CLIENT_FIELDS` 中的服务端权威字段（如席位令牌、胜者、服务端时间）；
 *    出现即整条拒绝 → `error(FORBIDDEN_FIELD)`，连接保持。
 * 4. 未声明的可选扩展字段：服务端按白名单丢弃（不报错、不生效），保证前向兼容时不改变已批准规则。
 */

/** 协议版本号；前后端必须一致，不匹配一律拒绝。 */
export const PROTOCOL_VERSION = 1 as const;

/** 协议标识，用于健康检查与握手时区分服务。 */
export const PROTOCOL_ID = 'neon-blocks-mp' as const;

/** 单条 WebSocket 消息 UTF-8 字节硬上限（服务端按原始字节拒绝）。 */
export const MAX_MESSAGE_BYTES = 4096 as const;

/** 创建/加入等 HTTP 请求体字节上限（防大包）。 */
export const MAX_HTTP_BODY_BYTES = 2048 as const;

/** 房间码空间：6 位数字 100000–999999。 */
export const ROOM_CODE_MIN = 100000 as const;
export const ROOM_CODE_MAX = 999999 as const;

/** 房间容量与昵称边界（已批准规则）。 */
export const MIN_PLAYERS = 2 as const;
export const MAX_PLAYERS = 6 as const;
export const NICKNAME_PATTERN = /^[A-Za-z0-9]{1,16}$/;

/** 房主自定义种子边界（S3 模式）。 */
export const CUSTOM_SEED_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/** 房主可选初始等级。 */
export const MIN_START_LEVEL = 1 as const;
export const MAX_START_LEVEL = 10 as const;

/** 服务器权威比赛时长上限与断线宽限（毫秒）。 */
export const MATCH_DURATION_MS = 600_000 as const;
export const DISCONNECT_GRACE_MS = 30_000 as const;
/** 全员意外离线后业务房间最长保留时间（毫秒）。 */
export const EMPTY_ROOM_TTL_MS = 1_800_000 as const;

/** 棋盘尺寸（与 `src/game/constants.ts` 一致，由测试守护一致性）。 */
export const BOARD_WIDTH = 10 as const;
export const BOARD_HEIGHT = 24 as const;

/** 版本兼容判定：仅接受精确匹配的协议版本。 */
export function isVersionSupported(v: unknown): v is typeof PROTOCOL_VERSION {
  return v === PROTOCOL_VERSION;
}

/** 版本不匹配时服务端关闭 WebSocket 使用的状态码（协议错误）。 */
export const VERSION_CLOSE_CODE = 1002 as const;

// ---------------------------------------------------------------- 基础标识

/** 服务端签发的内部席位 ID（可公开显示，不含令牌）。 */
export type SeatId = string;
/** 服务端签发的席位令牌（机密，仅存于浏览器会话存储，不进入 URL 与日志）。 */
export type SeatToken = string;
/** 服务端签发的一次性短期握手票据。 */
export type HandshakeTicket = string;
/** 一局比赛的唯一标识。 */
export type MatchId = string;
/** 6 位数字房间码（字符串形式，保留前导零语义）。 */
export type RoomCode = string;

// ---------------------------------------------------------------- 业务枚举

/** 房间阶段状态机。 */
export type RoomPhase = 'LOBBY' | 'COUNTDOWN' | 'RUNNING' | 'FINISHED';

/** 玩家在游戏内的可见状态。 */
export type PlayerStatus =
  | 'lobby'
  | 'ready'
  | 'playing'
  | 'disconnected'
  | 'eliminated'
  | 'finished';

/** 方块随机模式（已批准三模式）。 */
export type RandomMode = 'S1' | 'S2' | 'S3';
export const RANDOM_MODES: readonly RandomMode[] = ['S1', 'S2', 'S3'];

/** PRNG 算法版本，随开局下发以保证跨端可复现。 */
export type RngAlgo = 'xorshift32-bag7-v1';

/** 快照中的运行状态（联网禁用个人暂停，故无 paused）。 */
export type SnapshotStatus = 'running' | 'gameover';

/** 客户端上报的结束原因。 */
export type ClientEndReason = 'topout' | 'voluntary';

/** 比赛结束原因。 */
export type EndReason = 'survival' | 'timeout' | 'abandoned';

/** 玩家离开房间的原因。 */
export type LeaveReason = 'left' | 'eliminated' | 'grace_expired';

// ---------------------------------------------------------------- 房间与玩家视图

/** 房主可设置的对局参数（开局即冻结）。 */
export interface RoomSettings {
  capacity: number;
  randomMode: RandomMode;
  /** 仅 S3 模式存在。 */
  customSeed?: string;
  startLevel: number;
}

/** 房间内玩家的公开视图（不含任何令牌）。 */
export interface PlayerView {
  playerId: SeatId;
  nickname: string;
  /** 加入顺序（1 起），用于稳定显示与房主转让。 */
  seatIndex: number;
  isHost: boolean;
  ready: boolean;
  status: PlayerStatus;
  score: number;
  lines: number;
  level: number;
}

/** 排行榜条目（全员同一份，见 N27）。 */
export interface LeaderboardEntry {
  playerId: SeatId;
  nickname: string;
  score: number;
  lines: number;
  /** 同分并列名次（1 起）。 */
  rank: number;
  status: PlayerStatus;
}

/** 终局名次条目（胜负排序与得分榜分离，见 N19）。 */
export interface StandingEntry {
  playerId: SeatId;
  nickname: string;
  score: number;
  lines: number;
  /** 生存者名次（1 起）；已淘汰者为 null。 */
  placement: number | null;
  eliminatedAt: number | null;
}

// ---------------------------------------------------------------- 棋盘快照

/** 活动方块在快照中的紧凑表示。 */
export interface ActivePieceSnapshot {
  /** 方块类型 I/O/T/S/Z/J/L。 */
  t: 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
  /** 旋转态 0–3。 */
  r: 0 | 1 | 2 | 3;
  x: number;
  y: number;
}

/**
 * 棋盘快照（N23 实现编解码与大小校验）：
 * `board` 为 24 行、每行 10 字符；`.` 表示空，其余为方块类型首字母（含隐藏区）。
 */
export interface SnapshotPayload {
  seq: number;
  board: string[];
  active: ActivePieceSnapshot | null;
  score: number;
  lines: number;
  level: number;
  status: SnapshotStatus;
}

// ---------------------------------------------------------------- 消息信封

/** 所有消息的公共字段：协议版本与类型。 */
export interface MessageBase<T extends string = string> {
  v: number;
  type: T;
}

/** 客户端 → 服务器消息类型白名单（方案 §7.2）。 */
export const CLIENT_MESSAGE_TYPES = [
  'ready',
  'start',
  'settings_update',
  'snapshot',
  'gameover',
  'leave',
  'ping',
] as const;
export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];

/** 服务器 → 客户端消息类型白名单（方案 §7.2）。 */
export const SERVER_MESSAGE_TYPES = [
  'room_state',
  'player_joined',
  'player_left',
  'countdown',
  'match_start',
  'scoreboard',
  'watch_target',
  'remote_snapshot',
  'match_end',
  'error',
  'pong',
] as const;
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

/** 客户端消息禁止携带的服务端权威字段（出现即整条拒绝）。 */
export const FORBIDDEN_CLIENT_FIELDS = [
  'seatToken',
  'ticket',
  'playerId',
  'isHost',
  'isWinner',
  'matchId',
  'winners',
  'winnerIds',
  'standings',
  'placement',
  'eliminatedAt',
  'serverTime',
  'revision',
  'roomGeneration',
  'generation',
  'seed',
  'seatSeed',
] as const;

/** 客户端连接内单调递增序号（用于去重与丢弃陈旧消息）。 */
export interface ClientSeqField {
  seq: number;
}

export interface ReadyMsg extends MessageBase<'ready'>, ClientSeqField {}
export interface StartMsg extends MessageBase<'start'>, ClientSeqField {}
export interface LeaveMsg extends MessageBase<'leave'>, ClientSeqField {}
export interface PingMsg extends MessageBase<'ping'>, ClientSeqField {
  clientTime: number;
}
export interface SettingsUpdateMsg
  extends MessageBase<'settings_update'>,
    ClientSeqField {
  capacity: number;
  randomMode: RandomMode;
  customSeed?: string;
  startLevel: number;
}
export interface SnapshotMsg extends MessageBase<'snapshot'>, ClientSeqField {
  snapshot: SnapshotPayload;
}
export interface GameOverMsg extends MessageBase<'gameover'>, ClientSeqField {
  reason: ClientEndReason;
}

export type ClientMessage =
  | ReadyMsg
  | StartMsg
  | SettingsUpdateMsg
  | SnapshotMsg
  | GameOverMsg
  | LeaveMsg
  | PingMsg;

/** 服务端消息带房间/榜单 revision（同 revision 内容完全一致）。 */
export interface ServerRevField {
  revision: number;
}

export interface RoomStateMsg extends MessageBase<'room_state'>, ServerRevField {
  roomGeneration: number;
  phase: RoomPhase;
  roomCode: RoomCode;
  settings: RoomSettings;
  players: PlayerView[];
  matchId: MatchId | null;
  startAt: number | null;
  deadlineAt: number | null;
  serverTime: number;
}
export interface PlayerJoinedMsg extends MessageBase<'player_joined'>, ServerRevField {
  player: PlayerView;
}
export interface PlayerLeftMsg extends MessageBase<'player_left'>, ServerRevField {
  playerId: SeatId;
  reason: LeaveReason;
}
export interface CountdownMsg extends MessageBase<'countdown'>, ServerRevField {
  matchId: MatchId;
  startAt: number;
  deadlineAt: number;
}
export interface MatchStartMsg extends MessageBase<'match_start'>, ServerRevField {
  matchId: MatchId;
  startAt: number;
  deadlineAt: number;
  rngAlgo: RngAlgo;
  /** 该席位的实际出块种子（S1/S3 全员相同，S2 按席位派生）。 */
  seatSeed: number;
  seatIndex: number;
  startLevel: number;
}
export interface ScoreboardMsg extends MessageBase<'scoreboard'>, ServerRevField {
  entries: LeaderboardEntry[];
}
export interface WatchTargetMsg extends MessageBase<'watch_target'>, ServerRevField {
  targetPlayerId: SeatId;
}
export interface RemoteSnapshotMsg
  extends MessageBase<'remote_snapshot'>,
    ServerRevField {
  targetPlayerId: SeatId;
  snapshot: SnapshotPayload;
}
export interface MatchEndMsg extends MessageBase<'match_end'>, ServerRevField {
  matchId: MatchId;
  reason: EndReason;
  /** 胜者席位（并列时多名；无胜者时为空）。 */
  winners: SeatId[];
  standings: StandingEntry[];
}
export interface ErrorMsg extends MessageBase<'error'>, ServerRevField {
  code: string;
  message: string;
  retryable: boolean;
}
export interface PongMsg extends MessageBase<'pong'> {
  /** 回显客户端 ping 的 seq。 */
  seq: number;
  serverTime: number;
}

export type ServerMessage =
  | RoomStateMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | CountdownMsg
  | MatchStartMsg
  | ScoreboardMsg
  | WatchTargetMsg
  | RemoteSnapshotMsg
  | MatchEndMsg
  | ErrorMsg
  | PongMsg;

// ---------------------------------------------------------------- HTTP 模型

export interface CreateRoomRequest {
  nickname: string;
  capacity: number;
  randomMode: RandomMode;
  customSeed?: string;
  startLevel: number;
}

export interface JoinRoomRequest {
  nickname: string;
}

/** 创建/加入成功响应（seatToken 仅此一次回显，之后不再出现在任何响应中）。 */
export interface SeatGrantedResponse {
  roomCode: RoomCode;
  roomGeneration: number;
  seatToken: SeatToken;
  playerId: SeatId;
  createdAt: number;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PlayerView[];
}

/** 换取一次性握手票据的响应。 */
export interface TicketResponse {
  ticket: HandshakeTicket;
  expiresAt: number;
}

export interface HealthResponse {
  status: 'ok';
  protocol: string;
  version: number;
}

// ---------------------------------------------------------------- 编解码

/** 序列化消息为 JSON 文本（WebSocket 仅使用 text 帧）。 */
export function encodeMessage(msg: MessageBase): string {
  return JSON.stringify(msg);
}

/**
 * 解析 WebSocket 文本帧；JSON 非法时返回 null（不抛异常），
 * 结构合法性由 N04 的 `shared/validate.ts` 严格校验。
 */
export function decodeMessage(raw: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
