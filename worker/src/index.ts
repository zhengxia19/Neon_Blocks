/**
 * Worker HTTP 入口（N02 最小骨架：仅健康检查，用于验证前后端共享类型的编译边界）。
 * N08 起在此接入 Durable Object 绑定与路由；N10 起接入 POST /api/rooms。
 * 边界：Worker 只做 HTTP / 升级 / 限流 / 路由，不实现游戏物理。
 */
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../../shared/protocol';

/** 运行时绑定（N08 将加入 ROOM_DO 等绑定）。 */
export interface Env {
  ROOM_DO?: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({
        status: 'ok',
        protocol: PROTOCOL_ID,
        version: PROTOCOL_VERSION,
      });
    }
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
