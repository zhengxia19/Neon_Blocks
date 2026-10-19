/**
 * 联网对战协议公共契约（前后端共享，纯类型与常量，无任何 DOM / Worker API 依赖）。
 * N02 先固定「协议版本 + 标识 + 报文上限」这条最小边界；
 * N03 在此文件内锁定完整消息类型与错误码，N04 在 `shared/validate.ts` 实现运行时校验。
 */

/** 协议版本号；前后端必须一致，不匹配一律拒绝。 */
export const PROTOCOL_VERSION = 1 as const;

/** 协议标识，用于健康检查与握手时区分服务。 */
export const PROTOCOL_ID = 'neon-blocks-mp' as const;

/** 单条 WebSocket 消息 UTF-8 字节硬上限（服务端按原始字节拒绝）。 */
export const MAX_MESSAGE_BYTES = 4096 as const;

/** 房间码空间：6 位数字 100000–999999。 */
export const ROOM_CODE_MIN = 100000 as const;
export const ROOM_CODE_MAX = 999999 as const;

/** 房间容量与昵称边界（已批准规则）。 */
export const MIN_PLAYERS = 2 as const;
export const MAX_PLAYERS = 6 as const;
export const NICKNAME_PATTERN = /^[A-Za-z0-9]{1,16}$/;
