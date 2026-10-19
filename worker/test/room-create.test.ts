// N10：POST /api/rooms 创建接口与最低防滥用门槛（fetch 级，fake DO 命名空间）。
import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import worker, { __resetCreateRateWindow, type Env } from '../src/index';
import type { CreateClaim } from '../src/room';
import type { RoomNamespaceLike } from '../src/room-store';

const PROD = 'https://zhengxia19.github.io';

/** fake DO：记录 createRoom 调用（用于断言门槛在创建 DO 前生效）。 */
function makeFakeNs(onCreate: (code: string, req: CreateRoomRequest) => CreateClaim) {
  const calls: string[] = [];
  const ns: RoomNamespaceLike = {
    idFromName: (code) => ({ toString: () => `do-${code}` }),
    get: (id) => ({
      createRoom: async (req: CreateRoomRequest) => {
        const code = String(id).replace(/^do-/, '');
        calls.push(code);
        expect(req.nickname).toBe('host1');
        return onCreate(code, req);
      },
      joinRoom: async () => {
        throw new Error('unused in create tests');
      },
    }),
  };
  return { ns, calls };
}

function makeEnv(ns: RoomNamespaceLike, rateLimit = '30'): Env {
  return {
    ROOM_DO: ns as unknown as Env['ROOM_DO'],
    ALLOWED_ORIGINS: PROD,
    CREATE_RATE_LIMIT_PER_MIN: rateLimit,
  };
}

function createRequest(body: unknown, origin: string | null = PROD): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers['origin'] = origin;
  return new Request('https://api.example/api/rooms', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { nickname: 'host1', capacity: 4, randomMode: 'S1', startLevel: 1 };

function okClaim(_code: string, req: CreateRoomRequest): CreateClaim {
  return {
    claimed: true,
    generation: 1,
    playerId: 'p_abc123',
    seatToken: 'a'.repeat(64),
    settings: {
      capacity: req.capacity,
      randomMode: req.randomMode,
      startLevel: req.startLevel,
      ...(req.customSeed !== undefined ? { customSeed: req.customSeed } : {}),
    },
  };
}

beforeEach(() => {
  __resetCreateRateWindow();
});

describe('N10 POST /api/rooms 正向', () => {
  it('合法创建 → 201，出站白名单字段 + 强随机席位令牌，不回显内部摘要', async () => {
    const { ns } = makeFakeNs(okClaim);
    const res = await worker.fetch(createRequest(VALID), makeEnv(ns));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'generation', 'playerId', 'room', 'seatToken']);
    expect(body.code).toMatch(/^[1-9][0-9]{5}$/);
    expect(body.generation).toBe(1);
    expect(body.seatToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(body.room).toEqual({ capacity: 4, randomMode: 'S1', startLevel: 1 });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('hash'); // 禁止回显内部摘要
    expect(raw).not.toContain('do-'); // 不回显 DO id
  });

  it('S3 自定义种子合法；未知字段丢弃不影响创建', async () => {
    const { ns, calls } = makeFakeNs(okClaim);
    const res = await worker.fetch(
      createRequest({ ...VALID, randomMode: 'S3', customSeed: 'seed42', evilField: 'x'.repeat(50) }),
      makeEnv(ns),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.room).toEqual({ capacity: 4, randomMode: 'S3', startLevel: 1, customSeed: 'seed42' });
    expect(JSON.stringify(body)).not.toContain('evilField');
    expect(calls.length).toBe(1);
  });
});

describe('N10 POST /api/rooms 反向（4xx/413/429/403，且不创建 DO）', () => {
  async function rejected(body: unknown, origin: string | null, envRate?: string) {
    const { ns, calls } = makeFakeNs(okClaim);
    const res = await worker.fetch(createRequest(body, origin), makeEnv(ns, envRate));
    return { res, calls };
  }

  it('非法参数 → 400 + 精确错误码', async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...VALID, nickname: '中文昵称' }, 'BAD_NICKNAME'],
      [{ ...VALID, capacity: 7 }, 'BAD_CAPACITY'],
      [{ ...VALID, startLevel: 11 }, 'BAD_LEVEL'],
      [{ ...VALID, randomMode: 'S4' }, 'BAD_MODE'],
      [{ ...VALID, randomMode: 'S3' }, 'BAD_SEED'], // S3 缺种子
      [{ ...VALID, customSeed: 'x' }, 'BAD_SEED'], // S1 带种子
      ['{not json', 'BAD_MESSAGE'],
    ];
    for (const [body, code] of cases) {
      const { res, calls } = await rejected(body, PROD);
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as Record<string, unknown>;
      expect(parsed.error).toBe(code);
      expect(calls.length).toBe(0); // 参数非法不创建 DO
    }
  });

  it('超大请求体 → 413 TOO_LARGE（声明与实际字节两路都拦），不创建 DO', async () => {
    const big = JSON.stringify({ ...VALID, nickname: 'a'.repeat(5000) });
    const { res, calls } = await rejected(big, PROD);
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('TOO_LARGE');
    expect(calls.length).toBe(0);
    // content-length 声明超限：小 body 也先拒（不读 body 不创建 DO）。
    const { ns, calls: calls2 } = makeFakeNs(okClaim);
    const req = new Request('https://api.example/api/rooms', {
      method: 'POST',
      headers: { origin: PROD, 'content-length': '999999' },
      body: '{}',
    });
    const res2 = await worker.fetch(req, makeEnv(ns));
    expect(res2.status).toBe(413);
    expect(calls2.length).toBe(0);
  });

  it('创建类请求缺 Origin 或非法 Origin → 403，不创建 DO', async () => {
    const missing = await rejected(VALID, null);
    expect(missing.res.status).toBe(403);
    expect(((await missing.res.json()) as Record<string, unknown>).error).toBe('BAD_ORIGIN');
    expect(missing.calls.length).toBe(0);
    const evil = await rejected(VALID, 'https://evil.example');
    expect(evil.res.status).toBe(403);
    expect(evil.calls.length).toBe(0);
  });

  it('超过创建频率门槛 → 429 RATE_LIMITED，且不再创建 DO', async () => {
    const { ns, calls } = makeFakeNs(okClaim);
    const env = makeEnv(ns, '2');
    const r1 = await worker.fetch(createRequest(VALID), env);
    const r2 = await worker.fetch(createRequest(VALID), env);
    const r3 = await worker.fetch(createRequest(VALID), env);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r3.status).toBe(429);
    expect(((await r3.json()) as Record<string, unknown>).error).toBe('RATE_LIMITED');
    expect(calls.length).toBe(2); // 第 3 次被门槛拦下，未触达 DO
  });
});
