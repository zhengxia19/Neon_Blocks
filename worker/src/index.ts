/**
 * Worker HTTP 入口（N09：DO 绑定 + CORS 接线 + 健康检查 + 房间码分配验收路由）。
 * N10 起在此接入 POST /api/rooms；N13 接入 WebSocket 升级。
 * 边界：Worker 只做 HTTP / 升级 / 限流 / 路由，不实现游戏物理。
 */
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../../shared/protocol';
import { validateRoomCode } from '../../shared/validate';
import { corsHeaders, isOriginAllowed } from './cors';
import { allocateRoomCode, type ClaimResult, type RoomNamespaceLike } from './room-store';

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

    // N09 验收临时路由（N10 正式 API 落地时移除）：
    // POST /api/__create → 服务端随机取码 + DO 内原子占用（禁止客户端先检查再提交）。
    if (url.pathname === '/api/__create' && request.method === 'POST') {
      // DO stub 面（tryClaim）由 room.ts 实现；命名空间类型经 RoomNamespaceLike 适配。
      const allocation = await allocateRoomCode(env.ROOM_DO as unknown as RoomNamespaceLike);
      if (!allocation.ok) {
        return jsonResponse(
          { error: allocation.error, message: '房间码分配失败，请重试。', attempts: allocation.attempts },
          503,
          origin,
        );
      }
      return jsonResponse(
        { code: allocation.code, id: allocation.id, generation: allocation.generation },
        200,
        origin,
      );
    }

    // POST /api/__claim|__release|__verify/<码>[/<代际>] → 指定码的占用/释放/凭据校验。
    const roomMatch = /^\/api\/__(claim|release|verify)\/([0-9]{6})(?:\/([0-9]{1,9}))?$/.exec(url.pathname);
    if (roomMatch !== null && request.method === 'POST') {
      const code = validateRoomCode(roomMatch[2]);
      if (!code.ok) {
        return jsonResponse({ error: code.code, message: '房间码非法。' }, 400, origin);
      }
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(code.value)) as DurableObjectStub & {
        tryClaim(): Promise<ClaimResult>;
        release(): Promise<ClaimResult>;
        verifyGeneration(g: number): Promise<{ valid: boolean; generation: number }>;
      };
      if (roomMatch[1] === 'claim') {
        const result = await stub.tryClaim();
        return jsonResponse({ code: code.value, ...result }, 200, origin);
      }
      if (roomMatch[1] === 'release') {
        const result = await stub.release();
        return jsonResponse({ code: code.value, ...result }, 200, origin);
      }
      const gen = Number(roomMatch[3]);
      if (!Number.isInteger(gen) || gen < 0) {
        return jsonResponse({ error: 'BAD_GENERATION', message: '代际非法。' }, 400, origin);
      }
      const result = await stub.verifyGeneration(gen);
      return jsonResponse({ code: code.value, requested: gen, ...result }, 200, origin);
    }

    return jsonResponse({ error: 'NOT_FOUND', message: '接口不存在。' }, 404, origin);
  },
} satisfies ExportedHandler<Env>;
