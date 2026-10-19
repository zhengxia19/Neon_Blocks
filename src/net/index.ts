/**
 * 前端网络模块入口（`src/net/`）。
 * 边界：本目录只负责房间 API、WebSocket 通信、协议类型复用与快照编解码；
 * 不得被 `src/game/` 依赖，也不得引用 `worker/` 下的任何服务端实现。
 * 具体实现：N23 快照编码、N24 限频发布、N31 客户端生命周期。
 */
export {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  NICKNAME_PATTERN,
  ROOM_CODE_MAX,
  ROOM_CODE_MIN,
} from '../../shared/protocol';
