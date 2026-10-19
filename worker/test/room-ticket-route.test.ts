// N13：POST /api/rooms/<码>/ticket 与 GET /ws/<码> 路由（fetch 级，fake DO）。
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { __resetCreateRateWindow, type Env } from '../src/index';
import type { TicketResult } from '../src/room';
import type { RoomNamespaceLike } from '../src/room-store';

const PROD = 'https://zhengxia19.github.io';

function makeFakeNs(handlers?: {
  issue?: (p: string, t: string) => Promise<TicketResult>;
  handshake?: (req: Request) => Promise<Response>;
}) {
  const calls: unknown[][] = [];
  const ns: RoomNamespaceLike = {
    idFromName: (code) => ({ toString: () => `do-${code}` }),
    get: (id) => ({
      createRoom: async () => {
        throw new Error('unused');
      },
      joinRoom: async () => {
        throw new Error('unused');
      },
      issueTicket: async (p: string, t: string) => {
        calls.push(['issue', String(id), p, t]);
        return handlers?.issue
          ? handlers.issue(p, t)
          : { issued: true, ticket: 'a'.repeat(32), expiresAt: Date.now() + 30_000 };
      },
      fetch: async (req: Request) => {
        calls.push(['handshake', String(id), req.url, (req as unknown as { webSocket?: unknown }).webSocket]);
        return handlers?.handshake
          ? handlers.handshake(req)
          : new Response('ok', { status: 200 });
      },
    }),
  };
  return { ns, calls };
}

function makeEnv(ns: RoomNamespaceLike): Env {
  return {
    ROOM_DO: ns as unknown as Env['ROOM_DO'],
    ALLOWED_ORIGINS: PROD,
    CREATE_RATE_LIMIT_PER_MIN: '30',
  };
}

function post(path: string, body: unknown, origin: string | null = PROD): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers['origin'] = origin;
  return new Request(`https://api.example${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_BODY = { playerId: 'p_abc123def456', seatToken: 'b'.repeat(64) };

beforeEach(() => {
  __resetCreateRateWindow();
});

describe('N13 ticket 路由', () => {
  it('正向：200 白名单 {code,ticket,expiresAt}，DO 收到解析后参数', async () => {
    const { ns, calls } = makeFakeNs();
    const res = await worker.fetch(post('/api/rooms/123456/ticket', VALID_BODY), makeEnv(ns));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'expiresAt', 'ticket']);
    expect(body.code).toBe('123456');
    expect(calls).toEqual([['issue', 'do-123456', 'p_abc123def456', 'b'.repeat(64)]]);
  });

  it('反向：非法参数/码/Origin/超大体 → 400/403/413 且 0 DO 调用', async () => {
    const cases: Array<[string, unknown, string | null, number, string]> = [
      ['/api/rooms/123456/ticket', { playerId: 'bad', seatToken: 'b'.repeat(64) }, PROD, 400, 'BAD_MESSAGE'],
      ['/api/rooms/123456/ticket', { playerId: 'p_abc123def456', seatToken: 'short' }, PROD, 400, 'BAD_MESSAGE'],
      ['/api/rooms/099999/ticket', VALID_BODY, PROD, 400, 'BAD_ROOM_CODE'],
      ['/api/rooms/123456/ticket', VALID_BODY, null, 403, 'BAD_ORIGIN'],
      ['/api/rooms/123456/ticket', JSON.stringify({ ...VALID_BODY, pad: 'x'.repeat(5000) }), PROD, 413, 'TOO_LARGE'],
    ];
    for (const [path, body, origin, status, code] of cases) {
      const { ns, calls } = makeFakeNs();
      const res = await worker.fetch(post(path, body, origin), makeEnv(ns));
      expect(res.status).toBe(status);
      expect(((await res.json()) as Record<string, unknown>).error).toBe(code);
      expect(calls.length).toBe(0);
    }
  });

  it('DO 拒绝映射：ROOM_NOT_FOUND→404、UNAUTHORIZED→401', async () => {
    const a = makeFakeNs({ issue: async () => ({ issued: false, error: 'ROOM_NOT_FOUND' }) });
    const resA = await worker.fetch(post('/api/rooms/123456/ticket', VALID_BODY), makeEnv(a.ns));
    expect(resA.status).toBe(404);
    const b = makeFakeNs({ issue: async () => ({ issued: false, error: 'UNAUTHORIZED' }) });
    const resB = await worker.fetch(post('/api/rooms/123456/ticket', VALID_BODY), makeEnv(b.ns));
    expect(resB.status).toBe(401);
    expect(((await resB.json()) as Record<string, unknown>).error).toBe('UNAUTHORIZED');
  });
});

describe('N13 ws 握手入口路由', () => {
  function wsRequest(query: string, upgrade = 'websocket', origin: string | null = PROD, wsKey = true): Request {
    const headers: Record<string, string> = {};
    if (upgrade !== '') headers['upgrade'] = upgrade;
    if (wsKey) headers['sec-websocket-key'] = 'k'.repeat(24); // N22：升级头完整性
    if (origin !== null) headers['origin'] = origin;
    return new Request(`https://api.example/ws/123456${query}`, { method: 'GET', headers });
  }

  it('反向：缺 upgrade/缺 ticket/非法码/缺 Origin/缺 Sec-WebSocket-Key → 400/403 且 0 DO 调用', async () => {
    const cases: Array<[Request, number, string]> = [
      [wsRequest('?ticket=aa', ''), 400, 'BAD_MESSAGE'],
      [wsRequest(''), 400, 'BAD_MESSAGE'],
      [wsRequest('?ticket='), 400, 'BAD_MESSAGE'],
      [wsRequest('?ticket=' + 'a'.repeat(200)), 400, 'BAD_MESSAGE'],
      [wsRequest('?ticket=aa', 'websocket', PROD, false), 400, 'BAD_MESSAGE'],
    ];
    for (const [req, status, code] of cases) {
      const { ns, calls } = makeFakeNs();
      const res = await worker.fetch(req, makeEnv(ns));
      expect(res.status).toBe(status);
      expect(((await res.json()) as Record<string, unknown>).error).toBe(code);
      expect(calls.length).toBe(0);
    }
    const noOrigin = makeFakeNs();
    const resNo = await worker.fetch(wsRequest('?ticket=aa', 'websocket', null), makeEnv(noOrigin.ns));
    expect(resNo.status).toBe(403);
    expect(noOrigin.calls.length).toBe(0);
  });

  it('票据拒绝映射：REPLAY/EXPIRED/STALE/UNAUTHORIZED→401（N22 后无 SEAT_TAKEN 死支）', async () => {
    const errors: Array<[string, number]> = [
      ['TOKEN_REPLAY', 401],
      ['TOKEN_EXPIRED', 401],
      ['GENERATION_STALE', 401],
      ['UNAUTHORIZED', 401],
    ];
    for (const [err, status] of errors) {
      const { ns, calls } = makeFakeNs({
        handshake: async () =>
          new Response(JSON.stringify({ error: err }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      });
      const res = await worker.fetch(wsRequest('?ticket=aa'), makeEnv(ns));
      expect(res.status).toBe(status);
      expect(((await res.json()) as Record<string, unknown>).error).toBe(err);
      expect(calls.length).toBe(1);
      // 升级请求原样转发：DO 收到的 URL 即含单次票据。
      expect(String(calls[0][2])).toContain('ticket=aa');
    }
  });
});
