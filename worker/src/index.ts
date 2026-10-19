/**
 * Worker HTTP 入口（N08：DO 绑定 + CORS 接线 + 健康检查 + DO 实例化探针）。
 * N10 起在此接入 POST /api/rooms；N13 接入 WebSocket 升级。
 * 边界：Worker 只做 HTTP / 升级 / 限流 / 路由，不实现游戏物理。
 */
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../../shared/protocol';
import { validateRoomCode } from '../../shared/validate';
import { corsHeaders, isOriginAllowed } from './cors';

// Wrangler 要求 DO 类从入口模块导出（N08 绑定校验）。
export { RoomDO } from './room';

/** 运行时绑定（wrangler.jsonc 声明）。 */
export interface Env {
  ROOM_DO: DurableObjectNamespace;
  /** 逗号分隔的正式 Origin 白名单。 */
  ALLOWED_ORIGINS: string;
}

function jsonResponse(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin, 'GET') },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    // CORS：带 Origin 的请求先过白名单（方案 §11：正式仅 GitHub Pages；本地白名单仅测试）。
    if (!isOriginAllowed(origin, env.ALLOWED_ORIGINS)) {
      return jsonResponse(
        { error: 'BAD_ORIGIN', message: '来源不被允许。' },
        403,
        null,
      );
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, 'OPTIONS') });
    }

    if (url.pathname === '/api/health') {
      return jsonResponse(
        { status: 'ok', protocol: PROTOCOL_ID, version: PROTOCOL_VERSION },
        200,
        origin,
      );
    }

    // N08 验收探针：验证「房间码 → 固定 DO」映射可实例化且 SQLite 存储可用。
    // 正式创建/加入 API 属 N10；探针仅 GET，无副作用之外的写入（幂等）。
    const probeMatch = /^\/api\/__probe\/([0-9]{6})$/.exec(url.pathname);
    if (probeMatch !== null && request.method === 'GET') {
      const code = validateRoomCode(probeMatch[1]);
      if (!code.ok) {
        return jsonResponse({ error: code.code, message: '房间码非法。' }, 400, origin);
      }
      const id = env.ROOM_DO.idFromName(code.value);
      const stub = env.ROOM_DO.get(id) as DurableObjectStub & {
        probe(c: string): { code: string; generation: number };
      };
      const result = await stub.probe(code.value);
      return jsonResponse({ id: id.toString(), ...result }, 200, origin);
    }

    return jsonResponse({ error: 'NOT_FOUND', message: '接口不存在。' }, 404, origin);
  },
} satisfies ExportedHandler<Env>;
