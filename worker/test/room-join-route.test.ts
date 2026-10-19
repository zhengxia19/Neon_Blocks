// N11：POST /api/rooms/<码>/join 路由与错误映射（fetch 级，fake DO 命名空间）。
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { __resetCreateRateWindow, type Env } from '../src/index';
import type { JoinResult } from '../src/room';
import type { RoomNamespaceLike } from '../src/room-store';

const PROD = 'https://zhengxia19.github.io';

function makeFakeNs(joinImpl: (code: string, nickname: string) => Promise<JoinResult>) {
  const calls: Array<{ code: string; nickname: string }> = [];
  const ns: RoomNamespaceLike = {
    idFromName: (code) => ({ toString: () => `do-${code}` }),
    get: (id) => ({
      createRoom: async () => {
        throw new Error('unused in join tests');
      },
      joinRoom: async (nickname: string) => {
        const code = String(id).replace(/^do-/, '');
        calls.push({ code, nickname });
        return joinImpl(code, nickname);
      },
      issueTicket: async () => {
        throw new Error('unused in join tests');
      },
      fetch: async () => {
        throw new Error('unused in join tests');
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

function joinRequest(code: string, body: unknown, origin: string | null = PROD): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers['origin'] = origin;
  return new Request(`https://api.example/api/rooms/${code}/join`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const okJoin: JoinResult = {
  joined: true,
  generation: 2,
  playerId: 'p_def456',
  seatToken: 'b'.repeat(64),
  joinOrder: 2,
  settings: { capacity: 4, randomMode: 'S1', startLevel: 1 },
};

beforeEach(() => {
  __resetCreateRateWindow();
});

describe('N11 join 路由正向', () => {
  it('合法加入 → 200 白名单字段，不回显内部摘要', async () => {
    const { ns, calls } = makeFakeNs(async () => okJoin);
    const res = await worker.fetch(joinRequest('123456', { nickname: 'guestA' }), makeEnv(ns));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'generation',
      'joinOrder',
      'playerId',
      'room',
      'seatToken',
    ]);
    expect(body.code).toBe('123456');
    expect(body.generation).toBe(2);
    expect(body.joinOrder).toBe(2);
    expect(body.seatToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('hash');
    expect(raw).not.toContain('do-');
    expect(calls).toEqual([{ code: '123456', nickname: 'guestA' }]);
  });
});

describe('N11 join 路由反向', () => {
  it('房间码非法 → 400 BAD_ROOM_CODE，不触达 DO', async () => {
    const { ns, calls } = makeFakeNs(async () => okJoin);
    for (const code of ['099999', '12345', 'abcdef']) {
      const res = await worker.fetch(joinRequest(code, { nickname: 'g' }), makeEnv(ns));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).error).toBe('BAD_ROOM_CODE');
    }
    expect(calls.length).toBe(0);
  });

  it('昵称非法/体非法 → 400 精确码，不触达 DO', async () => {
    const cases: Array<[unknown, string]> = [
      [{ nickname: '中文昵称' }, 'BAD_NICKNAME'],
      [{ nickname: 'a'.repeat(17) }, 'BAD_NICKNAME'],
      [{}, 'BAD_NICKNAME'],
      ['{oops', 'BAD_MESSAGE'],
      ['[1,2]', 'BAD_MESSAGE'],
    ];
    for (const [body, code] of cases) {
      const { ns, calls } = makeFakeNs(async () => okJoin);
      const res = await worker.fetch(joinRequest('123456', body), makeEnv(ns));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).error).toBe(code);
      expect(calls.length).toBe(0);
    }
  });

  it('超大 body → 413；缺/非法 Origin → 403；均不触达 DO', async () => {
    const big = JSON.stringify({ nickname: 'g'.repeat(5000) });
    const a = makeFakeNs(async () => okJoin);
    const resA = await worker.fetch(joinRequest('123456', big), makeEnv(a.ns));
    expect(resA.status).toBe(413);
    expect(((await resA.json()) as Record<string, unknown>).error).toBe('TOO_LARGE');
    expect(a.calls.length).toBe(0);
    const b = makeFakeNs(async () => okJoin);
    const resB = await worker.fetch(joinRequest('123456', { nickname: 'g' }, null), makeEnv(b.ns));
    expect(resB.status).toBe(403);
    const c = makeFakeNs(async () => okJoin);
    const resC = await worker.fetch(joinRequest('123456', { nickname: 'g' }, 'https://evil.example'), makeEnv(c.ns));
    expect(resC.status).toBe(403);
    expect(b.calls.length + c.calls.length).toBe(0);
  });

  it('DO 拒绝映射：ROOM_NOT_FOUND→404、ROOM_FULL/NAME_TAKEN/GAME_STARTED→409', async () => {
    const cases: Array<[JoinResult, number, string]> = [
      [{ joined: false, error: 'ROOM_NOT_FOUND' }, 404, 'ROOM_NOT_FOUND'],
      [{ joined: false, error: 'ROOM_FULL' }, 409, 'ROOM_FULL'],
      [{ joined: false, error: 'NAME_TAKEN' }, 409, 'NAME_TAKEN'],
      [{ joined: false, error: 'GAME_STARTED' }, 409, 'GAME_STARTED'],
    ];
    for (const [result, status, code] of cases) {
      const { ns } = makeFakeNs(async () => result);
      const res = await worker.fetch(joinRequest('654321', { nickname: 'g' }), makeEnv(ns));
      expect(res.status).toBe(status);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe(code);
      expect(typeof body.message).toBe('string'); // 目录内中文文案
    }
  });
});
