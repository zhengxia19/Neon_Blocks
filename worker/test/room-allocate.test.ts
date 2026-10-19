import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import type { CreateClaim } from '../src/room';
import {
  MAX_CLAIM_ATTEMPTS,
  ROOM_CODE_MAX,
  ROOM_CODE_MIN,
  allocateRoomCode,
  randomRoomCode,
  type RoomNamespaceLike,
} from '../src/room-store';

const REQ: CreateRoomRequest = {
  nickname: 'host1',
  capacity: 4,
  randomMode: 'S1',
  startLevel: 1,
};

function claimed(generation: number): CreateClaim {
  return {
    claimed: true,
    generation,
    playerId: `p_gen${generation}`,
    seatToken: 't'.repeat(64),
    settings: { capacity: 4, randomMode: 'S1', startLevel: 1 },
  };
}

/** 可编排的 fake 命名空间：按脚本返回占用结果，并记录尝试次数与占用的码。 */
function fakeNamespace(script: (code: string, attempt: number) => CreateClaim): {
  ns: RoomNamespaceLike;
  attempts: () => number;
  claimedCodes: () => string[];
} {
  let attempt = 0;
  const claimedCodes: string[] = [];
  const ns: RoomNamespaceLike = {
    idFromName: (code) => ({ toString: () => `do-${code}` }),
    get: (id) => ({
      createRoom: async (req) => {
        attempt += 1;
        const code = String(id).replace(/^do-/, '');
        expect(req).toEqual(REQ);
        const result = script(code, attempt);
        if (result.claimed) claimedCodes.push(code);
        return result;
      },
      joinRoom: async () => {
        throw new Error('unused in allocate tests');
      },
      issueTicket: async () => {
        throw new Error('unused in allocate tests');
      },
      consumeTicket: async () => {
        throw new Error('unused in allocate tests');
      },
    }),
  };
  return { ns, attempts: () => attempt, claimedCodes: () => claimedCodes };
}

describe('N09/N10 房间码随机与分配重试', () => {
  it('正向：randomRoomCode 2000 次全部落在 100000–999999 且为 6 位', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = randomRoomCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      const n = Number(code);
      expect(n).toBeGreaterThanOrEqual(ROOM_CODE_MIN);
      expect(n).toBeLessThanOrEqual(ROOM_CODE_MAX);
      codes.add(code);
    }
    // 90 万码空间取 2000 个：碰撞应极少（生日界 <~2.3，经验上 <10）。
    expect(codes.size).toBeGreaterThan(1985);
  });

  it('正向：首次候选即创建成功，返回码/DO id/代际/席位凭据', async () => {
    const { ns, attempts } = fakeNamespace(() => claimed(1));
    const result = await allocateRoomCode(ns, REQ);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.generation).toBe(1);
      expect(result.playerId).toBe('p_gen1');
      expect(result.id).toBe(`do-${result.code}`);
    }
    expect(attempts()).toBe(1);
  });

  it('正向：候选被占用后换码重试成功（第 4 次命中）', async () => {
    const { ns, attempts } = fakeNamespace((_code, attempt) =>
      attempt < 4 ? { claimed: false, generation: 7 } : claimed(8),
    );
    const result = await allocateRoomCode(ns, REQ);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.generation).toBe(8);
    expect(attempts()).toBe(4);
  });

  it('反向：候选全部冲突 → 尝试上限后返回可控错误 ROOM_CODE_EXHAUSTED', async () => {
    const { ns, attempts } = fakeNamespace(() => ({ claimed: false, generation: 3 }));
    const result = await allocateRoomCode(ns, REQ);
    expect(result).toEqual({ ok: false, error: 'ROOM_CODE_EXHAUSTED', attempts: MAX_CLAIM_ATTEMPTS });
    expect(attempts()).toBe(MAX_CLAIM_ATTEMPTS);
  });

  it('反向：1000 次分配无重复同时有效码（fake DO 拒绝重复占用）', async () => {
    const occupied = new Set<string>();
    const { ns, claimedCodes } = fakeNamespace((code) =>
      occupied.has(code)
        ? { claimed: false, generation: 1 }
        : (occupied.add(code), claimed(1)),
    );
    for (let i = 0; i < 1000; i += 1) {
      const result = await allocateRoomCode(ns, REQ);
      expect(result.ok).toBe(true);
    }
    expect(new Set(claimedCodes()).size).toBe(1000);
  });
});
