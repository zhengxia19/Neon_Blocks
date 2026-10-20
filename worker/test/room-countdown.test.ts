// N16：统一倒计时与开局种子派生（服务器权威 startAt/deadlineAt/主种子/席位派生；
// 提前开始拒绝与临界时刻确认；一次性 countdown/match_start 广播，不逐秒广播）。
import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest, RandomMode } from '../../shared/protocol';
import {
  COUNTDOWN_MS,
  MATCH_DURATION_MS,
  bag7Sequence,
  deriveSeatSeed,
  normalizeSeed32,
} from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx, type FakeHibernatableSocket } from './stubs/sqlite-storage';

type Sql = ReturnType<typeof makeFakeCtx>['store']['sql'];

interface WsState {
  sent: string[];
  attachment: unknown;
}

function makeFakeWs(): { ws: WebSocket; state: WsState } {
  const state: WsState = { sent: [], attachment: null };
  const ws: FakeHibernatableSocket = {
    send: (m: string) => state.sent.push(m),
    close: () => {},
    serializeAttachment: (a: unknown) => {
      state.attachment = a;
      return JSON.stringify(a);
    },
    deserializeAttachment: () => state.attachment,
  };
  return { ws: ws as unknown as WebSocket, state };
}

/** 建房+加入至 capacity 满、全员准备，并为每个席位挂上 Hibernation 假连接。 */
async function readyLobby(capacity: number, mode: RandomMode = 'S1', customSeed?: string) {
  const { ctx, store } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  const request: CreateRoomRequest = {
    nickname: 'host1',
    capacity,
    randomMode: mode,
    startLevel: 2,
    ...(customSeed !== undefined ? { customSeed } : {}),
  };
  const created = await room.createRoom(request);
  if (!created.claimed) throw new Error('claim failed');
  const ids = [created.playerId];
  const tokens = new Map<string, string>([[created.playerId, created.seatToken]]);
  for (let i = 1; i < capacity; i += 1) {
    const joined = await room.joinRoom(`g${i}`);
    if (!joined.joined) throw new Error('join failed');
    ids.push(joined.playerId);
    tokens.set(joined.playerId, joined.seatToken);
  }
  for (const id of ids) room.setReady(id, true);
  const states = new Map<string, WsState>();
  for (const id of ids) {
    const { ws, state } = makeFakeWs();
    const issued = await room.issueTicket(id, tokens.get(id) as string);
    if (!issued.issued) throw new Error('ticket failed');
    const attached = await room.attachWebSocket(issued.ticket, ws);
    if (!attached.ok) throw new Error('attach failed');
    states.set(id, state);
  }
  return { room, sql: store.sql, host: created.playerId, guests: ids.slice(1), ids, states };
}

function masterSeedOf(sql: Sql): number {
  return Number([...sql.exec('SELECT master_seed FROM match_state WHERE id = 1')][0].master_seed);
}

describe('N16 开局信息服务器权威与三模式种子派生', () => {
  it('S1：startAt/deadlineAt/算法版本/matchId 权威下发，全员同种子且与库内主种子一致', async () => {
    const { room, sql, host, guests } = await readyLobby(3);
    const before = Date.now();
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    expect(res.match.matchId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(res.match.rngAlgo).toBe('xorshift32-bag7-v1');
    expect(res.match.startAt).toBeGreaterThanOrEqual(before + COUNTDOWN_MS);
    expect(res.match.startAt).toBeLessThanOrEqual(Date.now() + COUNTDOWN_MS);
    expect(res.match.deadlineAt).toBe(res.match.startAt + MATCH_DURATION_MS);
    const master = masterSeedOf(sql);
    expect(master).toBeGreaterThan(0);
    expect(Object.keys(res.match.seatSeeds).sort()).toEqual([...[host, ...guests]].sort());
    expect(Object.values(res.match.seatSeeds).every((s) => s === master)).toBe(true);
    // 跨客户端约定牌序：同种子 → 同序列
    const seqA = bag7Sequence(res.match.seatSeeds[host], 10);
    const seqB = bag7Sequence(res.match.seatSeeds[guests[0]], 10);
    expect(seqA).toEqual(seqB);
    // getMatchInfo 与 match_start 载荷同源
    const infoH = room.getMatchInfo(host);
    const infoG = room.getMatchInfo(guests[0]);
    expect(infoH?.matchId).toBe(res.match.matchId);
    expect(infoH?.startAt).toBe(res.match.startAt);
    expect(infoH?.deadlineAt).toBe(res.match.deadlineAt);
    expect(infoH?.seatSeed).toBe(master);
    expect(infoG?.seatSeed).toBe(master);
    expect(infoH?.seatIndex).toBe(1);
    expect(infoG?.seatIndex).toBe(2);
    expect(infoH?.startLevel).toBe(2);
  });

  it('S2：按席位派生独立种子（可重现但牌序不同），与共享函数计算一致', async () => {
    const { room, sql, host, guests } = await readyLobby(3, 'S2');
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    const master = masterSeedOf(sql);
    const all = [host, ...guests];
    for (const id of all) {
      expect(res.match.seatSeeds[id]).toBe(deriveSeatSeed(master, id));
      expect(room.getMatchInfo(id)?.seatSeed).toBe(deriveSeatSeed(master, id));
    }
    expect(new Set(all.map((id) => res.match.seatSeeds[id])).size).toBe(3);
    expect(bag7Sequence(res.match.seatSeeds[host], 10)).not.toEqual(
      bag7Sequence(res.match.seatSeeds[guests[0]], 10),
    );
  });

  it('S3：房主种子经固定哈希归一化（金样本），跨房间可复盘', async () => {
    const a = await readyLobby(2, 'S3', 'seed42');
    const ra = a.room.startGame(a.host);
    if (!ra.started) throw new Error(JSON.stringify(ra));
    expect(normalizeSeed32('seed42')).toBe(1672157454);
    expect(masterSeedOf(a.sql)).toBe(1672157454);
    expect(Object.values(ra.match.seatSeeds).every((s) => s === 1672157454)).toBe(true);
    const b = await readyLobby(2, 'S3', 'seed42');
    b.room.startGame(b.host);
    expect(masterSeedOf(b.sql)).toBe(masterSeedOf(a.sql)); // 同房主种子 → 同主种子
  });

  it('开局前无 match 信息；未知席位查询为 null', async () => {
    const { room, host } = await readyLobby(2);
    expect(room.getMatchInfo(host)).toBeNull();
    expect(room.advanceToRunning(Date.now() + 9_999_999)).toEqual({
      started: false,
      error: 'BAD_STATE',
    });
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    expect(room.getMatchInfo('p_nobody')).toBeNull();
  });
});

describe('N16 COUNTDOWN→RUNNING 临界时刻与提前开始拒绝', () => {
  it('startAt-1 拒绝（TOO_EARLY 且状态不变）；startAt 临界允许；再次调用 BAD_STATE', async () => {
    const { room, host } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    const { startAt, deadlineAt, matchId } = res.match;
    expect(room.advanceToRunning(startAt - 1)).toEqual({ started: false, error: 'TOO_EARLY' });
    expect(room.getLobbyState()?.state).toBe('COUNTDOWN'); // 提前开始不改状态
    expect(room.advanceToRunning(startAt)).toEqual({
      started: true,
      matchId,
      startAt,
      deadlineAt,
    });
    expect(room.advanceToRunning(startAt + 1)).toEqual({ started: false, error: 'BAD_STATE' });
  });

  it('一次性广播：startGame 后每连接恰 1 条 countdown；确认后每连接 1 条 match_start（按席位载荷）', async () => {    const { room, sql, host, guests, states } = await readyLobby(3, 'S2');
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    const master = masterSeedOf(sql);
    const all = [host, ...guests];
    for (const id of all) {
      const msgs = states.get(id)!.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
      expect(msgs.length).toBe(1); // 不逐秒广播：仅一条
      expect(msgs[0]).toEqual({
        v: 1,
        type: 'countdown',
        revision: expect.any(Number), // N28：房间级单调 revision
        matchId: res.match.matchId,
        startAt: res.match.startAt,
        deadlineAt: res.match.deadlineAt,
      });
    }
    room.advanceToRunning(res.match.startAt);
    for (const [index, id] of all.entries()) {
      const msgs = states.get(id)!.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
      expect(msgs.length).toBe(3); // countdown + match_start + N28 首榜
      expect(msgs[1]).toEqual({
        v: 1,
        type: 'match_start',
        revision: expect.any(Number),
        matchId: res.match.matchId,
        startAt: res.match.startAt,
        deadlineAt: res.match.deadlineAt,
        rngAlgo: 'xorshift32-bag7-v1',
        seatSeed: deriveSeatSeed(master, id),
        seatIndex: index + 1,
        startLevel: 2,
      });
      expect(msgs[2]).toMatchObject({ type: 'scoreboard' });
    }
  });

  it('下一局不残留上局 match 信息：nextRound 清 match_state，重新开局产生新 matchId（复审 O1）', async () => {
    const { room, host } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    expect(room.advanceToRunning(res.match.startAt).started).toBe(true);
    expect(room.finishGame()).toEqual({ finished: true });
    expect(room.getMatchInfo(host)?.matchId).toBe(res.match.matchId); // FINISHED 仍可查
    expect(room.nextRound(host)).toMatchObject({ ok: true });
    expect(room.getMatchInfo(host)).toBeNull(); // LOBBY 下无陈旧信息
    for (const id of [host, ...room.getLobbyState()!.seats.map((s) => s.playerId)]) {
      room.setReady(id, true);
    }
    const res2 = room.startGame(host);
    if (!res2.started) throw new Error(JSON.stringify(res2));
    expect(res2.match.matchId).not.toBe(res.match.matchId);
    expect(res2.match.startAt).toBeGreaterThanOrEqual(res.match.startAt);
  });
});
