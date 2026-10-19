/**
 * 前端网络模块入口（`src/net/`）。
 * 边界：本目录只负责房间 API、WebSocket 通信、协议类型复用与快照编解码；
 * 不得被 `src/game/` 依赖，也不得引用 `worker/` 下的任何服务端实现。
 * 具体实现：N23 快照编码、N24 限频发布、N31 客户端生命周期。
 */
export {
  BOARD_CELL_CHARS,
  CLIENT_MESSAGE_TYPES,
  MAX_MESSAGE_BYTES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  NICKNAME_PATTERN,
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  RANDOM_MODES,
  ROOM_CODE_MAX,
  ROOM_CODE_MIN,
  SERVER_MESSAGE_TYPES,
  SNAPSHOT_MAX_BYTES,
  decodeMessage,
  encodeMessage,
  isVersionSupported,
} from '../../shared/protocol';
export { ERROR_CATALOG, ERROR_CODES, describeError, isErrorCode } from '../../shared/errors';
export {
  SnapshotError,
  decodeSnapshot,
  encodeSnapshot,
  utf8ByteLength,
  validateSnapshot,
} from './snapshot';
export type { SnapshotDecodeResult, SnapshotErrorCode } from './snapshot';
export {
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_MIN_INTERVAL_MS,
  SnapshotPublisher,
} from './publisher';
export type { PublishReject, PublishResult, PublisherOptions } from './publisher';
export type {
  ActivePieceSnapshot,
  ClientMessage,
  ClientMessageType,
  LeaderboardEntry,
  PlayerView,
  RoomSettings,
  ServerMessage,
  ServerMessageType,
  SnapshotPayload,
  SnapshotStatus,
} from '../../shared/protocol';
