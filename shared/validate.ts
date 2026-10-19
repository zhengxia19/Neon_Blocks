/**
 * 联网协议运行时校验（N04）。
 * 原则：
 * - 不使用 `as Type` 代替运行时校验；所有出站对象都由本模块重新构造（白名单字段），未知字段被丢弃。
 * - 校验失败一律返回错误码，不抛异常；调用方据此回 `error(...)` 或 4xx。
 * - 区分三类凭据：公开消息（可日志）、机密席位令牌 `seatToken`（禁止日志/URL）、一次性票据 `ticket`（短期）。
 */
import { ERROR_CODES, type ErrorCode } from './errors';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  CLIENT_MESSAGE_TYPES,
  CUSTOM_SEED_PATTERN,
  FORBIDDEN_CLIENT_FIELDS,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MAX_START_LEVEL,
  MIN_PLAYERS,
  MIN_START_LEVEL,
  NICKNAME_PATTERN,
  PROTOCOL_VERSION,
  RANDOM_MODES,
  ROOM_CODE_MAX,
  ROOM_CODE_MIN,
  type ClientMessage,
  type ClientMessageType,
  type CreateRoomRequest,
  type HandshakeTicket,
  type JoinRoomRequest,
  type RandomMode,
  type RoomCode,
  type RoomSettings,
  type SeatToken,
  type SnapshotPayload,
  type SnapshotStatus,
} from './protocol';

export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode): Result<never> {
  return { ok: false, code };
}

const PIECE_CHARS = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const;
const EMPTY_CHAR = '.';
const SEAT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SNAPSHOT_STATUS: readonly SnapshotStatus[] = ['running', 'gameover'];
const CLIENT_END_REASONS = ['topout', 'voluntary'] as const;

/** 活动块坐标宽松边界：仅拦截异常值，真实合法性由游戏引擎规则保证。 */
const ACTIVE_X_MIN = -4;
const ACTIVE_X_MAX = BOARD_WIDTH + 3;
const ACTIVE_Y_MIN = -4;
const ACTIVE_Y_MAX = BOARD_HEIGHT + 3;

/** UTF-8 字节长度（浏览器 / Node / Workers 均提供 TextEncoder）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 报文是否在上限内（服务端按原始字节拒绝，超限回 TOO_LARGE）。 */
export function withinMessageLimit(raw: string): boolean {
  return utf8ByteLength(raw) <= MAX_MESSAGE_BYTES;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** 校验并规范化错误码（服务端出站与前端入站共用）。 */
export function validateErrorCode(value: unknown): Result<ErrorCode> {
  if (typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)) {
    return ok(value as ErrorCode);
  }
  return fail('BAD_MESSAGE');
}

// ---------------------------------------------------------------- 基础字段

export function validateNickname(raw: unknown): Result<string> {
  if (typeof raw !== 'string' || !NICKNAME_PATTERN.test(raw)) return fail('BAD_NICKNAME');
  return ok(raw);
}

/** 房间码：接受 6 位数字字符串或范围内整数，统一规范化为 6 位字符串。 */
export function validateRoomCode(raw: unknown): Result<RoomCode> {
  let digits: string | null = null;
  if (typeof raw === 'string' && /^\d{6}$/.test(raw)) digits = raw;
  else if (isInteger(raw) && inRange(raw, ROOM_CODE_MIN, ROOM_CODE_MAX)) digits = String(raw);
  if (digits === null) return fail('BAD_ROOM_CODE');
  const num = Number(digits);
  if (!inRange(num, ROOM_CODE_MIN, ROOM_CODE_MAX)) return fail('BAD_ROOM_CODE');
  return ok(digits);
}

export function validateCapacity(raw: unknown): Result<number> {
  if (!isInteger(raw) || !inRange(raw, MIN_PLAYERS, MAX_PLAYERS)) return fail('BAD_CAPACITY');
  return ok(raw);
}

export function validateStartLevel(raw: unknown): Result<number> {
  if (!isInteger(raw) || !inRange(raw, MIN_START_LEVEL, MAX_START_LEVEL)) return fail('BAD_LEVEL');
  return ok(raw);
}

export function validateRandomMode(raw: unknown): Result<RandomMode> {
  if (typeof raw === 'string' && (RANDOM_MODES as readonly string[]).includes(raw)) {
    return ok(raw as RandomMode);
  }
  return fail('BAD_MODE');
}

/** S3 必须带自定义种子；S1/S2 必须不带。 */
export function validateCustomSeed(raw: unknown, mode: RandomMode): Result<string | undefined> {
  if (mode !== 'S3') {
    if (raw !== undefined && raw !== null) return fail('BAD_SEED');
    return ok(undefined);
  }
  if (typeof raw !== 'string' || !CUSTOM_SEED_PATTERN.test(raw)) return fail('BAD_SEED');
  return ok(raw);
}

/** 房主设置（丢弃未知字段；S3 种子必填）。 */
export function validateRoomSettings(raw: unknown): Result<RoomSettings> {
  if (!isPlainObject(raw)) return fail('BAD_MESSAGE');
  const mode = validateRandomMode(raw.randomMode);
  if (!mode.ok) return mode;
  const capacity = validateCapacity(raw.capacity);
  if (!capacity.ok) return capacity;
  const level = validateStartLevel(raw.startLevel);
  if (!level.ok) return level;
  const seed = validateCustomSeed(raw.customSeed, mode.value);
  if (!seed.ok) return seed;
  const settings: RoomSettings = {
    capacity: capacity.value,
    randomMode: mode.value,
    startLevel: level.value,
  };
  if (seed.value !== undefined) settings.customSeed = seed.value;
  return ok(settings);
}

export function validateCreateRoomRequest(raw: unknown): Result<CreateRoomRequest> {
  if (!isPlainObject(raw)) return fail('BAD_MESSAGE');
  const nickname = validateNickname(raw.nickname);
  if (!nickname.ok) return nickname;
  const settings = validateRoomSettings(raw);
  if (!settings.ok) return settings;
  return ok({
    nickname: nickname.value,
    capacity: settings.value.capacity,
    randomMode: settings.value.randomMode,
    startLevel: settings.value.startLevel,
    ...(settings.value.customSeed !== undefined ? { customSeed: settings.value.customSeed } : {}),
  });
}

export function validateJoinRoomRequest(raw: unknown): Result<JoinRoomRequest> {
  if (!isPlainObject(raw)) return fail('BAD_MESSAGE');
  const nickname = validateNickname(raw.nickname);
  if (!nickname.ok) return nickname;
  return ok({ nickname: nickname.value });
}

// ---------------------------------------------------------------- 凭据

/** 机密席位令牌：仅允许在创建/加入响应中出现一次，禁止进入 URL 与日志。 */
export function validateSeatToken(raw: unknown): Result<SeatToken> {
  if (typeof raw !== 'string' || !SEAT_TOKEN_PATTERN.test(raw)) return fail('UNAUTHORIZED');
  return ok(raw);
}

/** 一次性短期握手票据。 */
export function validateTicket(raw: unknown): Result<HandshakeTicket> {
  if (typeof raw !== 'string' || !TICKET_PATTERN.test(raw)) return fail('TOKEN_EXPIRED');
  return ok(raw);
}

// ---------------------------------------------------------------- 棋盘快照

/** 严格校验 24×10 棋盘：24 行、每行 10 字符、字符仅 `.` 或方块类型。 */
export function validateBoard(raw: unknown): Result<string[]> {
  if (!Array.isArray(raw) || raw.length !== BOARD_HEIGHT) return fail('BAD_SNAPSHOT');
  const rows: string[] = [];
  for (const row of raw) {
    if (typeof row !== 'string' || row.length !== BOARD_WIDTH) return fail('BAD_SNAPSHOT');
    for (const ch of row) {
      if (ch !== EMPTY_CHAR && !(PIECE_CHARS as readonly string[]).includes(ch)) {
        return fail('BAD_SNAPSHOT');
      }
    }
    rows.push(row);
  }
  return ok(rows);
}

/** 快照载荷严格校验并重建（丢弃未知字段、拒绝非法坐标与越界数值）。 */
export function validateSnapshotPayload(raw: unknown): Result<SnapshotPayload> {
  if (!isPlainObject(raw)) return fail('BAD_SNAPSHOT');
  const board = validateBoard(raw.board);
  if (!board.ok) return board;
  if (!isInteger(raw.seq) || !inRange(raw.seq, 0, Number.MAX_SAFE_INTEGER)) return fail('BAD_SNAPSHOT');
  if (!isInteger(raw.score) || !inRange(raw.score, 0, 1_000_000_000)) return fail('BAD_SNAPSHOT');
  if (!isInteger(raw.lines) || !inRange(raw.lines, 0, 10_000)) return fail('BAD_SNAPSHOT');
  if (!isInteger(raw.level) || !inRange(raw.level, MIN_START_LEVEL, MAX_START_LEVEL + 20)) {
    return fail('BAD_SNAPSHOT');
  }
  if (
    typeof raw.status !== 'string' ||
    !(SNAPSHOT_STATUS as readonly string[]).includes(raw.status)
  ) {
    return fail('BAD_SNAPSHOT');
  }
  let active: SnapshotPayload['active'] = null;
  if (raw.active !== null) {
    if (!isPlainObject(raw.active)) return fail('BAD_SNAPSHOT');
    const t = raw.active.t;
    const r = raw.active.r;
    const x = raw.active.x;
    const y = raw.active.y;
    if (typeof t !== 'string' || !(PIECE_CHARS as readonly string[]).includes(t)) {
      return fail('BAD_SNAPSHOT');
    }
    if (!isInteger(r) || !inRange(r, 0, 3)) return fail('BAD_SNAPSHOT');
    if (!isInteger(x) || !inRange(x, ACTIVE_X_MIN, ACTIVE_X_MAX)) return fail('BAD_SNAPSHOT');
    if (!isInteger(y) || !inRange(y, ACTIVE_Y_MIN, ACTIVE_Y_MAX)) return fail('BAD_SNAPSHOT');
    active = { t: t as (typeof PIECE_CHARS)[number], r: r as 0 | 1 | 2 | 3, x, y };
  }
  return ok({
    seq: raw.seq,
    board: board.value,
    active,
    score: raw.score,
    lines: raw.lines,
    level: raw.level,
    status: raw.status as SnapshotStatus,
  });
}

// ---------------------------------------------------------------- 客户端消息

function isClientMessageType(value: string): value is ClientMessageType {
  return (CLIENT_MESSAGE_TYPES as readonly string[]).includes(value);
}

/**
 * 客户端消息严格校验：版本 → 类型白名单 → 禁止字段 → seq → 各类型专属字段。
 * 返回的对象为重新构造的白名单对象（未知字段丢弃，污染字段整条拒绝）。
 */
export function validateClientMessage(raw: unknown): Result<ClientMessage> {
  if (!isPlainObject(raw)) return fail('BAD_MESSAGE');
  if (raw.v !== PROTOCOL_VERSION) return fail('PROTOCOL_VERSION');
  if (typeof raw.type !== 'string' || !isClientMessageType(raw.type)) return fail('UNKNOWN_TYPE');
  for (const key of Object.keys(raw)) {
    if ((FORBIDDEN_CLIENT_FIELDS as readonly string[]).includes(key)) return fail('FORBIDDEN_FIELD');
  }
  if (!isInteger(raw.seq) || !inRange(raw.seq, 0, Number.MAX_SAFE_INTEGER)) return fail('BAD_MESSAGE');
  const v = raw.seq;

  switch (raw.type) {
    case 'ready':
    case 'start':
    case 'leave':
      return ok({ v: PROTOCOL_VERSION, type: raw.type, seq: v });
    case 'ping': {
      if (typeof raw.clientTime !== 'number' || !Number.isFinite(raw.clientTime) || raw.clientTime < 0) {
        return fail('BAD_MESSAGE');
      }
      return ok({ v: PROTOCOL_VERSION, type: 'ping', seq: v, clientTime: raw.clientTime });
    }
    case 'settings_update': {
      const settings = validateRoomSettings(raw);
      if (!settings.ok) return settings;
      return ok({
        v: PROTOCOL_VERSION,
        type: 'settings_update',
        seq: v,
        capacity: settings.value.capacity,
        randomMode: settings.value.randomMode,
        startLevel: settings.value.startLevel,
        ...(settings.value.customSeed !== undefined ? { customSeed: settings.value.customSeed } : {}),
      });
    }
    case 'snapshot': {
      const snapshot = validateSnapshotPayload(raw.snapshot);
      if (!snapshot.ok) return snapshot;
      return ok({ v: PROTOCOL_VERSION, type: 'snapshot', seq: v, snapshot: snapshot.value });
    }
    case 'gameover': {
      if (
        typeof raw.reason !== 'string' ||
        !(CLIENT_END_REASONS as readonly string[]).includes(raw.reason)
      ) {
        return fail('BAD_MESSAGE');
      }
      return ok({
        v: PROTOCOL_VERSION,
        type: 'gameover',
        seq: v,
        reason: raw.reason as (typeof CLIENT_END_REASONS)[number],
      });
    }
    default:
      return fail('UNKNOWN_TYPE');
  }
}
