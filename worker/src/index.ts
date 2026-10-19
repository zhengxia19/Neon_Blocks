/**
 * Worker HTTP 入口（N10 创建 + N11 加入 + N13 票据 + N14 升级；N22 防滥用加固）。
 * 边界：Worker 只做 HTTP / 升级 / 限流 / 路由，不实现游戏物理。
 * 门槛顺序（清单 N10「在正式创建 DO 前」）：来源校验 → 创建开关 → 创建频率 →
 * 请求体字节 → 参数校验 → 才分配/创建 DO。
 * N22：分端点独立限流桶（创建/加入/换票）、试码失败冷却桶、有界窗口表
 * （固定容量插入序淘汰，禁止无限增长进程级 Map）、429 带 Retry-After、
 * 生产创建开关 PUBLIC_CREATE_ENABLED。跨实例分布式 IP 限流依赖 Cloudflare
 * Rate Limiting Rules（配置与依赖记录见 evidence/multiplayer/N22 与部署文档）。
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
import type { JoinResult, TicketResult } from './room';
import { allocateRoomCode, type RoomNamespaceLike } from './room-store';

// Wrangler 要求 DO 类从入口模块导出（N08 绑定校验）。
export { RoomDO } from './room';

/** 运行时绑定（wrangler.jsonc 声明）。 */
export interface Env {
  ROOM_DO: DurableObjectNamespace;
  /** 逗号分隔的正式 Origin 白名单。 */
  ALLOWED_ORIGINS: string;
  /** 每 IP 每分钟创建房间上限（N22 分端点桶之一）。缺省 30。 */
  CREATE_RATE_LIMIT_PER_MIN?: string;
  /** 每 IP 每分钟加入上限（N22）。缺省 30。 */
  JOIN_RATE_LIMIT_PER_MIN?: string;
  /** 每 IP 每分钟换票上限（N22）。缺省 60。 */
  TICKET_RATE_LIMIT_PER_MIN?: string;
  /** 每 IP 每分钟试码失败预算：join/ticket/ws 对不存在房间或坏码的失败合计（N22）。缺省 20。 */
  CODE_PROBE_LIMIT_PER_MIN?: string;
  /** "false" 时公开创建返回 503 CREATE_DISABLED（N22 生产开关：分布式 IP 限流未落实前的兜底）。缺省启用。 */
  PUBLIC_CREATE_ENABLED?: string;
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
  extraHeaders?: Record<string, string>,
): Response {
  const message = messageOverride ?? describeError(code).message;
  const res = jsonResponse({ error: code, message }, status, origin);
  if (extraHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraHeaders)) res.headers.set(k, v);
  }
  return res;
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

// —— N22 限流：单实例 60s 滑动窗口，分端点独立桶 + 试码失败桶。
// 有界性（清单 N22「禁止无限增长进程级 Map」）：桶数固定上限 MAX_RATE_BUCKETS，
// 超限按插入序淘汰最旧桶（Map 保持插入序 → 确定性有限状态）；每桶命中数 ≤ 该端点
// 限额（被限请求不再追加，惩罚不延长窗口）。跨实例/跨地域的全局 IP 限流无法由
// Worker 进程内设施保证——生产依赖 Cloudflare Rate Limiting Rules（配置与依赖
// 记录见 evidence/multiplayer/N22/rate-limit-rules.md）；免费计划无法支撑时，
// 以 PUBLIC_CREATE_ENABLED="false" 禁用公开创建直至替代机制落实。
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 4096;
const rateWindow = new Map<string, number[]>();

/** 测试钩子：清空全部限流桶。 */
export function __resetCreateRateWindow(): void {
  rateWindow.clear();
}

/** 测试钩子：当前桶数（验证有界淘汰）。 */
export function __rateWindowBucketCount(): number {
  return rateWindow.size;
}

function rateCheck(
  bucketKey: string,
  limitPerMin: number,
  now: number,
): { limited: false } | { limited: true; retryAfterSec: number } {
  const cutoff = now - RATE_WINDOW_MS;
  let hits = rateWindow.get(bucketKey);
  if (hits === undefined) {
    if (rateWindow.size >= MAX_RATE_BUCKETS) {
      const oldest = rateWindow.keys().next();
      if (!oldest.done) rateWindow.delete(oldest.value);
    }
    hits = [];
    rateWindow.set(bucketKey, hits);
  } else {
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
  }
  if (hits.length >= limitPerMin) {
    return {
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((hits[0] + RATE_WINDOW_MS - now) / 1000)),
    };
  }
  hits.push(now);
  return { limited: false };
}

/** 环境变量正整数解析（非法值回退缺省，防误配放大限额）。 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? String(fallback));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function clientIp(request: Request): string {
  return (request.cf as { ip?: string } | undefined)?.ip ?? 'no-cf';
}

/** 试码预算核验（不消费额度）：窗口内失败次数已达预算则拦下后续试码类请求。 */
function probeExceeded(bucketKey: string, limitPerMin: number, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const hits = rateWindow.get(bucketKey);
  if (hits === undefined) return false;
  while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
  return hits.length >= limitPerMin;
}

/** 记一次试码失败（消费额度；达预算后不再追加，桶有界）。 */
function probeHit(bucketKey: string, limitPerMin: number, now: number): void {
  rateCheck(bucketKey, limitPerMin, now);
}

/** 429 统一响应（带 Retry-After 秒数）。 */
function rateLimitedResponse(
  origin: string | null,
  retryAfterSec: number,
): Response {
  return errorResponse('RATE_LIMITED', 429, origin, undefined, {
    'retry-after': String(retryAfterSec),
  });
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
      // N22 生产开关：分布式 IP 限流落实前，可禁用公开创建（503）作兜底。
      if (env.PUBLIC_CREATE_ENABLED === 'false') {
        return errorResponse('CREATE_DISABLED', 503, origin);
      }
      const ip = clientIp(request);
      const createLimit = positiveInt(env.CREATE_RATE_LIMIT_PER_MIN, 30);
      const limited = rateCheck(`create|${ip}`, createLimit, Date.now());
      if (limited.limited) {
        return rateLimitedResponse(origin, limited.retryAfterSec);
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
      const ip = clientIp(request);
      const probeLimit = positiveInt(env.CODE_PROBE_LIMIT_PER_MIN, 20);
      const code = validateRoomCode(joinMatch[1]);
      if (!code.ok) {
        probeHit(`probe|${ip}`, probeLimit, Date.now()); // 坏码同样消耗试码预算
        return errorResponse(code.code, 400, origin);
      }
      const joinLimit = positiveInt(env.JOIN_RATE_LIMIT_PER_MIN, 30);
      const joinLimited = rateCheck(`join|${ip}`, joinLimit, Date.now());
      if (joinLimited.limited) {
        return rateLimitedResponse(origin, joinLimited.retryAfterSec);
      }
      // N22 试码冷却：窗口内对不存在房间的失败加入已达预算 → 冷却（正常好友
      // 低频加入不误拒；成功加入不消耗试码额度）。
      if (probeExceeded(`probe|${ip}`, probeLimit, Date.now())) {
        return rateLimitedResponse(origin, RATE_WINDOW_MS / 1000);
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
        if (result.error === 'ROOM_NOT_FOUND') {
          probeHit(`probe|${ip}`, probeLimit, Date.now()); // 试不存在的码计一次失败
        }
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
      const ip = clientIp(request);
      const probeLimit = positiveInt(env.CODE_PROBE_LIMIT_PER_MIN, 20);
      const code = validateRoomCode(ticketMatch[1]);
      if (!code.ok) {
        probeHit(`probe|${ip}`, probeLimit, Date.now());
        return errorResponse(code.code, 400, origin);
      }
      const ticketLimit = positiveInt(env.TICKET_RATE_LIMIT_PER_MIN, 60);
      const ticketLimited = rateCheck(`ticket|${ip}`, ticketLimit, Date.now());
      if (ticketLimited.limited) {
        return rateLimitedResponse(origin, ticketLimited.retryAfterSec);
      }
      if (probeExceeded(`probe|${ip}`, probeLimit, Date.now())) {
        return rateLimitedResponse(origin, RATE_WINDOW_MS / 1000);
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
        if (result.error === 'ROOM_NOT_FOUND') {
          probeHit(`probe|${ip}`, probeLimit, Date.now());
        }
        const status = result.error === 'ROOM_NOT_FOUND' ? 404 : 401;
        return errorResponse(result.error, status, origin);
      }
      return jsonResponse({ code: code.value, ticket: result.ticket, expiresAt: result.expiresAt }, 200, origin);
    }

    // N14：GET /ws/<码>?ticket=<单次票据> WS 握手入口（Hibernation）。Origin 必检
    // （全局白名单已先行）；升级请求原样转发给 DO：生产运行时把 server 端连接挂
    // 在 request.webSocket 上；本地 dev（miniflare loopback）不附加该属性，DO 会
    // 自建连接对并把 client 端随 101 回传。fetch 入口不再 accept()（禁止混用）。
    const wsMatch = /^\/ws\/([^/]+)$/.exec(url.pathname);
    if (wsMatch !== null && request.method === 'GET') {
      if (origin === null) {
        return errorResponse('BAD_ORIGIN', 403, null);
      }
      if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      // N22（N13-O2）：升级头完整性——缺 Sec-WebSocket-Key 不是合法握手。
      if ((request.headers.get('sec-websocket-key') ?? '').trim() === '') {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const ip = clientIp(request);
      const probeLimit = positiveInt(env.CODE_PROBE_LIMIT_PER_MIN, 20);
      const code = validateRoomCode(wsMatch[1]);
      if (!code.ok) {
        probeHit(`probe|${ip}`, probeLimit, Date.now());
        return errorResponse(code.code, 400, origin);
      }
      if (probeExceeded(`probe|${ip}`, probeLimit, Date.now())) {
        return rateLimitedResponse(origin, RATE_WINDOW_MS / 1000);
      }
      const ticket = url.searchParams.get('ticket');
      if (ticket === null || ticket.length === 0 || ticket.length > 128) {
        return errorResponse('BAD_MESSAGE', 400, origin);
      }
      const id = env.ROOM_DO.idFromName(code.value);
      const sub = await (
        env.ROOM_DO.get(id) as unknown as { fetch(r: Request): Promise<Response> }
      ).fetch(request);
      if (sub.status === 101) {
        // 握手成功：101 由运行时完成（WS 握手不受 CORS 约束，无需补头）。
        return sub;
      }
      const parsed = (await sub.json().catch(() => null)) as { error?: string } | null;
      const fail = parsed?.error ?? 'TOKEN_REPLAY';
      // 伪造/重放票据的握手尝试计入试码预算（握手探测与试码同源防滥用）。
      probeHit(`probe|${ip}`, probeLimit, Date.now());
      // N22：SEAT_TAKEN 死支清理——N20 起票据消费为替换语义（旧连接以 4003 关闭），
      // HTTP 层不再出现 409 SEAT_TAKEN。
      const status = fail === 'BAD_MESSAGE' ? 400 : fail === 'ROOM_NOT_FOUND' ? 404 : 401;
      return errorResponse(fail, status, origin);
    }

    return errorResponse('NOT_FOUND', 404, origin, '接口不存在。');
  },
} satisfies ExportedHandler<Env>;
