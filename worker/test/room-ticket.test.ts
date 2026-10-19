// N13：握手票据签发/消费（DO 直测，node:sqlite 桩）。
import { describe, expect, it } from 'vitest';
import { RoomDO, TICKET_TTL_MS } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';

function makeRoom() {
  const { ctx, store } = makeFakeCtx();
  return { room: new RoomDO(ctx as never, {} as never), store };
}

async function makeSeat() {
  const { room, store } = makeRoom();
  const created = await room.createRoom({ nickname: 'host1', capacity: 2, randomMode: 'S1', startLevel: 1 });
  if (!created.claimed) throw new Error('claim failed');
  return { room, store, playerId: created.playerId, seatToken: created.seatToken };
}

describe('N13 票据签发', () => {
  it('正向：正确令牌换发 30s 单次票据', async () => {
    const { room, playerId, seatToken } = await makeSeat();
    const res = await room.issueTicket(playerId, seatToken);
    expect(res.issued).toBe(true);
    if (!res.issued) return;
    expect(res.ticket).toMatch(/^[a-f0-9]{32}$/);
    expect(res.expiresAt - Date.now()).toBeGreaterThan(TICKET_TTL_MS - 5000);
  });

  it('反向：错误令牌/未知席位/未占用 → 拒绝', async () => {
    const { room, playerId } = await makeSeat();
    expect(await room.issueTicket(playerId, 'wrong-token')).toEqual({ issued: false, error: 'UNAUTHORIZED' });
    expect(await room.issueTicket('p_nobody', 'x'.repeat(64))).toEqual({ issued: false, error: 'UNAUTHORIZED' });
    const fresh = makeRoom();
    expect(await fresh.room.issueTicket('p_any', 'x'.repeat(64))).toEqual({ issued: false, error: 'ROOM_NOT_FOUND' });
  });
});

describe('N13 票据消费正向', () => {
  it('消费成功：回报席位与代际；重放 → TOKEN_REPLAY', async () => {
    const { room, playerId, seatToken } = await makeSeat();
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    const first = await room.consumeTicket(issued.ticket);
    expect(first).toEqual({ ok: true, playerId, generation: 1 });
    expect(await room.consumeTicket(issued.ticket)).toEqual({ ok: false, error: 'TOKEN_REPLAY' });
  });

  it('并发消费同一票据：恰一个成功，另一个 TOKEN_REPLAY', async () => {
    const { room, playerId, seatToken } = await makeSeat();
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    const results = await Promise.all([room.consumeTicket(issued.ticket), room.consumeTicket(issued.ticket)]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok)[0]).toEqual({ ok: false, error: 'TOKEN_REPLAY' });
  });
});

describe('N13 票据消费反向', () => {
  it('过期票据 → TOKEN_EXPIRED', async () => {
    const { room, store, playerId, seatToken } = await makeSeat();
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    store.db.prepare('UPDATE ws_tickets SET expires_at = ?').run(Date.now() - 1000);
    expect(await room.consumeTicket(issued.ticket)).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });

  it('旧世代票据 → GENERATION_STALE（房间关闭重占后）', async () => {
    const { room, playerId, seatToken } = await makeSeat();
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    room.leaveRoom(playerId); // 最后一人离开 → 业务态关闭
    const again = await room.createRoom({ nickname: 'host1', capacity: 2, randomMode: 'S1', startLevel: 1 });
    expect(again.claimed).toBe(true);
    expect(await room.consumeTicket(issued.ticket)).toEqual({ ok: false, error: 'GENERATION_STALE' });
  });

  it('每席位仅一条活动连接声明：再签票据消费 → SEAT_TAKEN', async () => {
    const { room, playerId, seatToken } = await makeSeat();
    const t1 = await room.issueTicket(playerId, seatToken);
    if (!t1.issued) throw new Error('issue failed');
    expect((await room.consumeTicket(t1.ticket)).ok).toBe(true);
    const t2 = await room.issueTicket(playerId, seatToken);
    if (!t2.issued) throw new Error('issue failed');
    expect(await room.consumeTicket(t2.ticket)).toEqual({ ok: false, error: 'SEAT_TAKEN' });
  });

  it('席位已退出后票据 → UNAUTHORIZED', async () => {
    const { room, playerId, seatToken } = await makeSeat();
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    room.leaveRoom(playerId);
    // 席位清空后房间关闭：票据行仍在（未过期），代际仍为 1 → 关闭态判 GENERATION_STALE；
    // 多席位场景：另一人留守时退出者票据 → UNAUTHORIZED。
    const multi = await makeRoom2Seat();
    const t = await multi.room.issueTicket(multi.guestId, multi.guestToken);
    if (!t.issued) throw new Error('issue failed');
    multi.room.leaveRoom(multi.guestId);
    expect(await multi.room.consumeTicket(t.ticket)).toEqual({ ok: false, error: 'UNAUTHORIZED' });
  });

  it('未知票据字符串 → TOKEN_REPLAY', async () => {
    const { room } = await makeSeat();
    expect(await room.consumeTicket('deadbeefdeadbeefdeadbeefdeadbeef')).toEqual({
      ok: false,
      error: 'TOKEN_REPLAY',
    });
  });
});

async function makeRoom2Seat() {
  const { room } = makeRoom();
  const created = await room.createRoom({ nickname: 'host1', capacity: 3, randomMode: 'S1', startLevel: 1 });
  if (!created.claimed) throw new Error('claim failed');
  const joined = await room.joinRoom('guest1');
  if (!joined.joined) throw new Error('join failed');
  return { room, hostId: created.playerId, guestId: joined.playerId, guestToken: joined.seatToken };
}
