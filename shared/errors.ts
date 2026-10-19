/**
 * 联网对战错误码（前后端共享）。
 * 服务端只发送目录内的错误码；前端按码显示中文提示，禁止把内部异常文本直接透给玩家。
 * 错误码不携带房间码、昵称、令牌等隐私信息。
 */

export const ERROR_CODES = [
  // 协议层
  'PROTOCOL_VERSION',
  'UNKNOWN_TYPE',
  'FORBIDDEN_FIELD',
  'BAD_MESSAGE',
  'TOO_LARGE',
  'BAD_ORIGIN',
  'RATE_LIMITED',
  // 参数校验
  'BAD_NICKNAME',
  'BAD_ROOM_CODE',
  'BAD_CAPACITY',
  'BAD_LEVEL',
  'BAD_SEED',
  'BAD_MODE',
  'BAD_SNAPSHOT',
  // 房间与席位
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'NAME_TAKEN',
  'ROOM_CODE_EXHAUSTED',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'TOKEN_REPLAY',
  'GENERATION_STALE',
  'SEAT_TAKEN',
  // 状态机
  'GAME_STARTED',
  'NOT_HOST',
  'NOT_READY',
  'NOT_ENOUGH_PLAYERS',
  'NOT_IN_GAME',
  'ALREADY_FINISHED',
  // 服务端
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误码 → 中文提示与是否可重试。 */
export const ERROR_CATALOG: Record<ErrorCode, { message: string; retryable: boolean }> = {
  PROTOCOL_VERSION: { message: '协议版本不匹配，请刷新页面后重试。', retryable: false },
  UNKNOWN_TYPE: { message: '收到未知的消息类型。', retryable: false },
  FORBIDDEN_FIELD: { message: '消息包含不被允许的字段。', retryable: false },
  BAD_MESSAGE: { message: '消息格式不合法。', retryable: true },
  TOO_LARGE: { message: '消息超过大小限制。', retryable: true },
  BAD_ORIGIN: { message: '请求来源不被允许。', retryable: false },
  RATE_LIMITED: { message: '操作过于频繁，请稍后再试。', retryable: true },

  BAD_NICKNAME: { message: '昵称需为 1–16 位英文字母或数字。', retryable: false },
  BAD_ROOM_CODE: { message: '房间码需为 100000–999999 的 6 位数字。', retryable: false },
  BAD_CAPACITY: { message: '房间人数需为 2–6 人。', retryable: false },
  BAD_LEVEL: { message: '初始等级需为 1–10。', retryable: false },
  BAD_SEED: { message: '自定义种子需为 1–32 位英文字母或数字。', retryable: false },
  BAD_MODE: { message: '随机模式需为 S1、S2 或 S3。', retryable: false },
  BAD_SNAPSHOT: { message: '棋盘快照数据不合法。', retryable: true },

  ROOM_NOT_FOUND: { message: '房间不存在或已关闭。', retryable: false },
  ROOM_FULL: { message: '房间已满员。', retryable: false },
  NAME_TAKEN: { message: '该昵称已被房间内其他玩家使用。', retryable: false },
  ROOM_CODE_EXHAUSTED: { message: '房间号分配失败，请稍后重试。', retryable: true },
  UNAUTHORIZED: { message: '席位凭据无效，请重新加入房间。', retryable: false },
  TOKEN_EXPIRED: { message: '连接票据已过期，正在重新连接。', retryable: true },
  TOKEN_REPLAY: { message: '连接票据已被使用，正在重新连接。', retryable: true },
  GENERATION_STALE: { message: '房间已重置，请重新加入。', retryable: false },
  SEAT_TAKEN: { message: '该席位已有其他连接。', retryable: true },

  GAME_STARTED: { message: '比赛已开始，无法加入或修改设置。', retryable: false },
  NOT_HOST: { message: '只有房主可以执行该操作。', retryable: false },
  NOT_READY: { message: '仍有玩家尚未准备。', retryable: false },
  NOT_ENOUGH_PLAYERS: { message: '至少需要 2 名玩家才能开始。', retryable: false },
  NOT_IN_GAME: { message: '当前房间状态不允许该操作。', retryable: false },
  ALREADY_FINISHED: { message: '本局比赛已结束。', retryable: false },

  INTERNAL: { message: '服务器内部错误，请稍后再试。', retryable: true },
};

/** 判定未知输入是否为合法错误码（用于服务端出站与前端入站校验）。 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** 取错误码对应的中文提示；未知码统一回退为 INTERNAL，避免泄露内部细节。 */
export function describeError(code: ErrorCode | string): { message: string; retryable: boolean } {
  return isErrorCode(code) ? ERROR_CATALOG[code] : ERROR_CATALOG.INTERNAL;
}
