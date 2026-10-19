/**
 * Worker HTTP 入口（N10：POST /api/rooms 创建房间 + 最低防滥用门槛）。
 * N11 接入 join；N13 接入 WebSocket 升级。
 * 边界：Worker 只做 HTTP / 升级 / 限流 / 路由，不实现游戏物理。
 * 门槛顺序（清单 N10「在正式创建 DO 前」）：来源校验 → 创建频率 → 请求体字节 →
 * 参数校验 → 才分配/创建 DO。复杂规则统一在 N22 加固。
 */
import { describeError } from '../../shared/errors';
import { MAX_MESSAGE_BYTES, PROTOCOL_ID, PROTOCOL_VERSION } from '../../shared/protocol';
import {
  utf8ByteLength,
  validateCreateRoomRequest,
  validateNickname,
  validateRoomCode,
} from '../../shared/validate';
import { corsHeaders, isOriginAllowed } from './cors';
import type { ConsumeResult, JoinResult, TicketResult } from './room';
import { allocateRoomCode, type RoomNamespaceLike } from './room-store';

// Wrangler 要求 DO 类从入口模块导出（N08 绑定校验）。
export { RoomDO } from './room';

/** 运行时绑定（wrangler.jsonc 声明）。 */
export interface Env {
  ROOM_DO: DurableObjectNamespace;
  /** 逗号分隔的正式 Origin 白名单。 */
  ALLOWED_ORIGINS: string;
  /** 每 IP 每分钟创建房间上限（最低门槛，N22 加固）。缺省 30。 */
  CREATE_RATE_LIMIT_PER_MIN?: string;
  /** "true" 时并入本地开发 Origin 白名单（仅本地模拟/测试；生产缺省关闭）。 */
  ALLOW_DEV_ORIGINS?: string;
}

function jsonResponse(
  body: unknown,
  status = 200,
  origin: string | null = null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin, 'GET') },
  });
}

/** 错误响应：只回目录内错误码与统一中文文案，不透出内部细节。 */
function errorResponse(
  code: string,
  status: number,
  origin: string | null,
  messageOverride?: string,
): Response {
  const message = messageOverride ?? describeError(code).message;
  return jsonResponse({ error: code, message }, status, origin);
}

// N13：席位令牌格式（与 N10 签发 randomHex(32) 对应；票据本身短小单次不进 URL）。
const SEAT_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

// —— 请求体字节限制：先查 content-length，再按实际 UTF-8 字节复核（清单 N10/N11）。 ——
async function readJsonBody(
  request: Request,
  origin: string | null,
): Promise<{ value: unknown; response: null } | { value: null; response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_MESSAGE_BYTES) {
    return { value: null, response: errorResponse('TOO_LARGE', 413, origin) };
  }
  const raw = await request.text();
  if (utf8ByteLength(raw) > MAX_MESSAGE_BYTES) {
    return { value: null, response: errorResponse('TOO_LARGE', 413, origin) };
  }
  try {
    return { value: JSON.parse(raw), response: null };
  } catch {
    return { value: null, response: errorResponse('BAD_MESSAGE', 400, origin) };
  }
}

// —— 创建频率最低门槛：单实例滑动窗口（60s）。跨实例全局限流属 N22。 ——
const createWindow = new Map<string, number[]>();

/** 测试钩子：清空窗口。 */
export function __resetCreateRateWindow(): void {
  createWindow.clear();
}

function isRateLimited(bucket: string, limitPerMin: number, now: number): boolean {
  const cutoff = now - 60_000;
  let hits = createWindow.get(bucket);
  if (hits === undefined) {
    hits = [];
    createWindow.set(bucket, hits);
  }
  while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
  // 窗口表防泄漏：异常多 IP 时清掉过期项。
  if (createWindow.size > 4096) {
    for (const [key, list] of createWindow) {
      if (list.length === 0 || list[list.length - 1] <= cutoff) createWindow.delete(key);
    }
  }
  if (hits.length >= limitPerMin) return true;
  hits.push(now);
  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    // CORS：带 Origin 的请求先过白名单（方案 §11：正式仅 GitHub Pages；本地白名单仅测试）。
    if (
      !isOriginAllowed(origin, env.ALLOWED_ORIGINS, env.ALLOW_DEV_ORIGINS === 'true')
    ) {
      return errorResponse('BAD_ORIGIN', 403, null);
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

    // N10：POST /api/rooms 创建房间。创建类请求必须带可允许的来源（防脚本裸 POST）。
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (origin === null) {
        return errorResponse('BAD_ORIGIN', 403, null);
      }
      const limitRaw = Number(env.CREATE_RATE_LIMIT_PER_MIN ?? '30');
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 30;
      const ip = (request.cf as { ip?: string } | undefined)?.ip ?? 'no-cf';
      if (isRateLimited(`create|${ip}`, limit, Date.now())) {
        return errorResponse('RATE_LIMITED', 429, origin);
      }
      const body = await readJsonBody(request, origin);
      if (body.response !== null) return body.response;
      const req = validateCreateRoomRequest(body.value);
      if (!req.ok) {
        return errorResponse(req.code, 400, origin);
      }
      const allocation = await allocateRoomCode(
        env.ROOM_DO as unknown as RoomNamespaceLike,
        req.value,
      );
      if (!allocation.ok) {
        return errorResponse(allocation.error, 503, origin);
      }
      // 出站白名单：不回显令牌摘要/DO id 等内部摘要；seatToken 仅此一次。
      return jsonResponse(
        {
          code: allocation.code,
          generation: allocation.generation,
          playerId: allocation.playerId,
          seatToken: allocation.seatToken,
          room: allocation.settings,
        },
        201,
        origin,
      );
    }

    // N11：POST /api/rooms/<码>/join 大厅加入。容量/昵称冲突/状态判定在 DO 内原子完成。
    const joinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(url.pathname);
    if (joinMatch !== null && request.method === 'POST') {
      if (origin === null) {
        return errorResponse('BAD_ORIGIN', 403, null);
      }
      const code = validateRoomCode(joinMatch[1]);
      if (!code.ok) {
        return errorResponse(code.code, 400, origin);
      }
      const limitRaw = Number(env.CREATE_RATE_LIMIT_PER_MIN ?? '30');
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 30;
      const ip = (request.cf as { ip?: string } | undefined)?.ip ?? 'no-cf';
      if (isRateLimited(`join|${ip}`, limit, Date.now())) {
        return errorResponse('RATE_LIMITED', 429, origin);
      }
      const body = await readJsonBody(request, origin);
      if (body.response !== null) return body.response;
      const parsed = body.value;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const nickname = validateNickname((parsed as { nickname?: unknown }).nickname);
      if (!nickname.ok) {
        return errorResponse(nickname.code, 400, origin);
      }
      const id = env.ROOM_DO.idFromName(code.value);
      const result: JoinResult = await (
        env.ROOM_DO.get(id) as unknown as { joinRoom(n: string): Promise<JoinResult> }
      ).joinRoom(nickname.value);
      if (!result.joined) {
        const status =
          result.error === 'ROOM_NOT_FOUND' ? 404 : result.error === 'GAME_STARTED' || result.error === 'ROOM_FULL' || result.error === 'NAME_TAKEN' ? 409 : 400;
        return errorResponse(result.error, status, origin);
      }
      return jsonResponse(
        {
          code: code.value,
          generation: result.generation,
          playerId: result.playerId,
          seatToken: result.seatToken,
          joinOrder: result.joinOrder,
          room: result.settings,
        },
        200,
        origin,
      );
    }

    // N13：POST /api/rooms/<码>/ticket 换发单次短期握手票据（席位令牌经 HTTPS 提交，
    // 不进 WS URL）。认证在 DO 内完成：席位存在 + 令牌摘要匹配 + 当代代际。
    const ticketMatch = /^\/api\/rooms\/([^/]+)\/ticket$/.exec(url.pathname);
    if (ticketMatch !== null && request.method === 'POST') {
      if (origin === null) {
        return errorResponse('BAD_ORIGIN', 403, null);
      }
      const code = validateRoomCode(ticketMatch[1]);
      if (!code.ok) {
        return errorResponse(code.code, 400, origin);
      }
      const limitRaw = Number(env.CREATE_RATE_LIMIT_PER_MIN ?? '30');
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 30;
      const ip = (request.cf as { ip?: string } | undefined)?.ip ?? 'no-cf';
      if (isRateLimited(`ticket|${ip}`, limit, Date.now())) {
        return errorResponse('RATE_LIMITED', 429, origin);
      }
      const body = await readJsonBody(request, origin);
      if (body.response !== null) return body.response;
      const parsed = body.value;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const record = parsed as { playerId?: unknown; seatToken?: unknown };
      const playerId = record.playerId;
      const seatToken = record.seatToken;
      if (typeof playerId !== 'string' || !/^p_[A-Za-z0-9]{6,32}$/.test(playerId) ||
          typeof seatToken !== 'string' || !SEAT_TOKEN_RE.test(seatToken)) {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const id = env.ROOM_DO.idFromName(code.value);
      const result: TicketResult = await (
        env.ROOM_DO.get(id) as unknown as {
          issueTicket(p: string, t: string): Promise<TicketResult>;
        }
      ).issueTicket(playerId, seatToken);
      if (!result.issued) {
        const status = result.error === 'ROOM_NOT_FOUND' ? 404 : 401;
        return errorResponse(result.error, status, origin);
      }
      return jsonResponse({ code: code.value, ticket: result.ticket, expiresAt: result.expiresAt }, 200, origin);
    }

    // N13：GET /ws/<码>?ticket=<单次票据> WS 握手入口。Origin 必检（全局白名单已先行）；
    // 票据单次/过期/代际/席位连接唯一性由 DO 原子消费。N14 将改 Hibernation 接线。
    const wsMatch = /^\/ws\/([^/]+)$/.exec(url.pathname);
    if (wsMatch !== null && request.method === 'GET') {
      if (origin === null) {
        return errorResponse('BAD_ORIGIN', 403, null);
      }
      if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const code = validateRoomCode(wsMatch[1]);
      if (!code.ok) {
        return errorResponse(code.code, 400, origin);
      }
      const ticket = url.searchParams.get('ticket');
      if (ticket === null || ticket.length === 0 || ticket.length > 128) {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const id = env.ROOM_DO.idFromName(code.value);
      const result: ConsumeResult = await (
        env.ROOM_DO.get(id) as unknown as { consumeTicket(t: string): Promise<ConsumeResult> }
      ).consumeTicket(ticket);
      if (!result.ok) {
        const status = result.error === 'SEAT_TAKEN' ? 409 : 401;
        return errorResponse(result.error, status, origin);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      return new Response(null, { status: 101, webSocket: client, headers: corsHeaders(origin, 'GET') });
    }

    return errorResponse('NOT_FOUND', 404, origin, '接口不存在。');
  },
} satisfies ExportedHandler<Env>;
