// N22：HTTP 防滥用加固——分端点限流桶、试码冷却、有界窗口表、Retry-After、
// 生产创建开关、升级头完整性（fetch 级，fake DO 命名空间）。
import { beforeEach, describe, expect, it } from 'vitest';
import worker, {
  __rateWindowBucketCount,
  __resetCreateRateWindow,
  type Env,
} from '../src/index';
import type { CreateClaim, JoinResult, TicketResult } from '../src/room';
import type { RoomNamespaceLike } from '../src/room-store';

const PROD = 'https://zhengxia19.github.io';
const VALID = { nickname: 'host1', capacity: 4, randomMode: 'S1', startLevel: 1 };

function makeFakeNs(opts?: {
  join?: () => Promise<JoinResult>;
  handshakeStatus?: number;
  handshakeError?: string;
}) {
  const calls: string[] = [];
  const ns: RoomNamespaceLike = {
    idFromName: (code) => ({ toString: () => `do-${code}` }),
    get: () => ({
      createRoom: async (): Promise<CreateClaim> => {
        calls.push('create');
        return {
          claimed: true,
          generation: 1,
          playerId: 'p_abc123',
          seatToken: 'a'.repeat(64),
          settings: { capacity: 4, randomMode: 'S1', startLevel: 1 },
        };
      },
      joinRoom: async (): Promise<JoinResult> => {
        calls.push('join');
        return opts?.join
          ? opts.join()
          : {
              joined: true,
              generation: 1,
              playerId: 'p_abc123def456',
              seatToken: 'b'.repeat(64),
              joinOrder: 1,
              settings: { capacity: 4, randomMode: 'S1', startLevel: 1 },
            };
      },
      issueTicket: async (): Promise<TicketResult> => {
        calls.push('ticket');
        return { issued: true, ticket: 'a'.repeat(32), expiresAt: Date.now() + 30_000 };
      },
      fetch: async (): Promise<Response> => {
        calls.push('ws');
        if (opts?.handshakeError !== undefined) {
          return new Response(JSON.stringify({ error: opts.handshakeError }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: opts?.handshakeStatus ?? 101 });
      },
    }),
  };
  return { ns, calls };
}

function makeEnv(ns: RoomNamespaceLike, extra: Partial<Env> = {}): Env {
  return {
    ROOM_DO: ns as unknown as Env['ROOM_DO'],
    ALLOWED_ORIGINS: PROD,
    ...extra,
  };
}

function post(path: string, body: unknown, ip?: string): Request {
  const req = new Request(`https://api.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PROD },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (ip !== undefined) Object.defineProperty(req, 'cf', { value: { ip } });
  return req;
}

function wsReq(ip?: string): Request {
  const req = new Request('https://api.example/ws/123456?ticket=' + 'a'.repeat(32), {
    method: 'GET',
    headers: { origin: PROD, upgrade: 'websocket', 'sec-websocket-key': 'k'.repeat(24) },
  });
  if (ip !== undefined) Object.defineProperty(req, 'cf', { value: { ip } });
  return req;
}

beforeEach(() => {
  __resetCreateRateWindow();
});

describe('N22 分端点限流桶', () => {
  it('创建超限 → 429 + Retry-After（1–60 秒），DO 调用冻结', async () => {
    const { ns, calls } = makeFakeNs();
    const env = makeEnv(ns, { CREATE_RATE_LIMIT_PER_MIN: '2' });
    const r1 = await worker.fetch(post('/api/rooms', VALID), env);
    const r2 = await worker.fetch(post('/api/rooms', VALID), env);
    const r3 = await worker.fetch(post('/api/rooms', VALID), env);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r3.status).toBe(429);
    expect(((await r3.json()) as Record<string, unknown>).error).toBe('RATE_LIMITED');
    const ra = Number(r3.headers.get('retry-after'));
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
    expect(calls.length).toBe(2);
  });

  it('桶相互独立：创建桶耗尽不影响 join/ticket（各自限额）', async () => {
    const { ns, calls } = makeFakeNs();
    const env = makeEnv(ns, { CREATE_RATE_LIMIT_PER_MIN: '1' });
    expect((await worker.fetch(post('/api/rooms', VALID), env)).status).toBe(201);
    expect((await worker.fetch(post('/api/rooms', VALID), env)).status).toBe(429);
    expect((await worker.fetch(post('/api/rooms/123456/join', { nickname: 'g1' }), env)).status).toBe(200);
    expect(
      (
        await worker.fetch(
          post('/api/rooms/123456/ticket', { playerId: 'p_abc123def456', seatToken: 'b'.repeat(64) }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(calls.filter((c) => c === 'create').length).toBe(1);
  });

  it('非法限额环境变量回退缺省（防误配放大）', async () => {
    const { ns } = makeFakeNs();
    const env = makeEnv(ns, { CREATE_RATE_LIMIT_PER_MIN: '0' });
    // 缺省 30：第 2 次仍应放行
    expect((await worker.fetch(post('/api/rooms', VALID), env)).status).toBe(201);
    expect((await worker.fetch(post('/api/rooms', VALID), env)).status).toBe(201);
  });
});

describe('N22 试码冷却', () => {
  const joinMissing = () =>
    Promise.resolve({ joined: false, error: 'ROOM_NOT_FOUND' } as JoinResult);

  it('对不存在房间的 join 失败达预算 → 冷却 429，DO 调用冻结', async () => {
    const { ns, calls } = makeFakeNs({ join: joinMissing });
    const env = makeEnv(ns, { CODE_PROBE_LIMIT_PER_MIN: '2' });
    expect((await worker.fetch(post('/api/rooms/111111/join', { nickname: 'g1' }), env)).status).toBe(404);
    expect((await worker.fetch(post('/api/rooms/222222/join', { nickname: 'g1' }), env)).status).toBe(404);
    const r3 = await worker.fetch(post('/api/rooms/333333/join', { nickname: 'g1' }), env);
    expect(r3.status).toBe(429);
    expect(((await r3.json()) as Record<string, unknown>).error).toBe('RATE_LIMITED');
    expect(calls.filter((c) => c === 'join').length).toBe(2); // 第 3 次未触达 DO
  });

  it('成功 join 不消耗试码额度；坏码消耗额度', async () => {
    const { ns } = makeFakeNs(); // join 成功
    const env = makeEnv(ns, { CODE_PROBE_LIMIT_PER_MIN: '2' });
    for (let i = 0; i < 5; i++) {
      expect((await worker.fetch(post('/api/rooms/123456/join', { nickname: 'g1' }), env)).status).toBe(200);
    }
    // 坏码 ×2 消耗预算 → 下一次合法码 join 被冷却
    expect((await worker.fetch(post('/api/rooms/099999/join', { nickname: 'g1' }), env)).status).toBe(400);
    expect((await worker.fetch(post('/api/rooms/abcdef/join', { nickname: 'g1' }), env)).status).toBe(400);
    expect((await worker.fetch(post('/api/rooms/123456/join', { nickname: 'g1' }), env)).status).toBe(429);
  });

  it('ws 握手失败消耗试码预算（跨端点共享冷却）', async () => {
    const { ns } = makeFakeNs({ handshakeError: 'TOKEN_REPLAY', join: joinMissing });
    const env = makeEnv(ns, { CODE_PROBE_LIMIT_PER_MIN: '2' });
    expect((await worker.fetch(wsReq(), env)).status).toBe(401);
    expect((await worker.fetch(wsReq(), env)).status).toBe(401);
    const r = await worker.fetch(post('/api/rooms/111111/join', { nickname: 'g1' }), env);
    expect(r.status).toBe(429); // join 被 ws 探测耗尽的预算冷却
  });
});

describe('N22 有界窗口表（禁止无限增长进程级 Map）', () => {
  it('4100 个不同 IP 各创建一次：桶数封顶 4096，最旧桶按插入序淘汰后可再创建', async () => {
    const { ns } = makeFakeNs();
    const env = makeEnv(ns, { CREATE_RATE_LIMIT_PER_MIN: '1' });
    for (let i = 0; i < 4100; i++) {
      const res = await worker.fetch(post('/api/rooms', VALID, `10.0.${i >> 8}.${i & 255}`), env);
      expect(res.status).toBe(201);
    }
    expect(__rateWindowBucketCount()).toBeLessThanOrEqual(4096);
    // 最早 IP 的桶已被淘汰 → 重新放行（有限状态，非永久封禁）
    expect((await worker.fetch(post('/api/rooms', VALID, '10.0.0.0'), env)).status).toBe(201);
  });
});

describe('N22 生产创建开关与升级头', () => {
  it('PUBLIC_CREATE_ENABLED="false" → 503 CREATE_DISABLED 且 0 DO 调用；缺省放行', async () => {
    const { ns, calls } = makeFakeNs();
    const off = makeEnv(ns, { PUBLIC_CREATE_ENABLED: 'false' });
    const res = await worker.fetch(post('/api/rooms', VALID), off);
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('CREATE_DISABLED');
    expect(calls.length).toBe(0);
    const on = makeEnv(ns);
    expect((await worker.fetch(post('/api/rooms', VALID), on)).status).toBe(201);
  });

  it('OPTIONS 预检：允许 Origin → 204 + 预检头；非法 Origin → 403', async () => {
    const { ns } = makeFakeNs();
    const env = makeEnv(ns);
    const pre = await worker.fetch(
      new Request('https://api.example/api/rooms', {
        method: 'OPTIONS',
        headers: { origin: PROD, 'access-control-request-method': 'POST' },
      }),
      env,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-origin')).toBe(PROD);
    const bad = await worker.fetch(
      new Request('https://api.example/api/rooms', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
      env,
    );
    expect(bad.status).toBe(403);
  });
});
