// N18：淘汰及提前终局裁决（只认当前局 matchId、服务端淘汰时间、最后 1 人胜、
// 0 人同刻并列、重复/已结束事件幂等、退出视为淘汰）。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO, type EliminationResult } from '../src/room';
import { makeFakeCtx, type FakeHibernatableSocket } from './stubs/sqlite-storage';

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

const T0 = 1_700_000_000_000;

/** 就绪大厅 → 开局 → 开赛（RUNNING），返回房间、库、席位与连接状态。 */
async function runningMatch(capacity: number) {
  vi.useFakeTimers({ now: T0 });
  const { ctx, store, alarmCalls } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  const request: CreateRoomRequest = {
    nickname: 'host1',
    capacity,
    randomMode: 'S1',
    startLevel: 1,
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
    await room.attachWebSocket(issued.ticket, ws);
    states.set(id, state);
  }
  const res = room.startGame(created.playerId);
  if (!res.started) throw new Error(JSON.stringify(res));
  room.advanceToRunning(res.match.startAt);
  return {
    room,
    sql: store.sql,
    alarmCalls,
    host: created.playerId,
    ids,
    states,
    matchId: res.match.matchId,
    startAt: res.match.startAt,
    deadlineAt: res.match.deadlineAt,
  };
}

function parsed(state: WsState): Record<string, unknown>[] {
  return state.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function elimRows(sql: ReturnType<typeof makeFakeCtx>['store']['sql']) {
  // 假 sql.exec 无泛型（N15 陷阱）：行按 unknown 读取后显式转换。
  return [
    ...sql.exec(
      'SELECT player_id, eliminated_at, match_id FROM eliminations ORDER BY eliminated_at ASC',
    ),
  ].map((r) => ({
    player_id: String((r as { player_id: unknown }).player_id),
    eliminated_at: Number((r as { eliminated_at: unknown }).eliminated_at),
    match_id: String((r as { match_id: unknown }).match_id),
  }));
}

/** 收窄 EliminationResult 成功分支（失败即抛，测试内快速定位）。 */
function mustElim(r: EliminationResult): Extract<EliminationResult, { eliminated: true }> {
  if (!r.eliminated) throw new Error(JSON.stringify(r));
  return r;
}

describe('N18 淘汰与提前终局', () => {
  it('4 人淘汰序列：逐人出局，最后 1 人立即胜出并广播 survival 终局', async () => {
    const { room, host, ids, states, matchId } = await runningMatch(4);
    const t1 = T0 + 60_000;
    const r1 = room.reportElimination(ids[1], matchId, t1);
    expect(r1).toEqual({ eliminated: true, alreadyEliminated: false, eliminatedAt: t1, matchEnded: false, winners: [] });
    const r2 = mustElim(room.reportElimination(ids[2], matchId, t1 + 1000));
    expect(r2.matchEnded).toBe(false);
    expect(room.getLobbyState()?.state).toBe('RUNNING'); // 还剩 2 人未终局
    const r3 = room.reportElimination(ids[3], matchId, t1 + 2000);
    expect(r3).toEqual({ eliminated: true, alreadyEliminated: false, eliminatedAt: t1 + 2000, matchEnded: true, winners: [host] });
    expect(room.getLobbyState()?.state).toBe('FINISHED'); // 最后 1 人立即胜出
    const msgs = parsed(states.get(host) as WsState);
    expect(msgs.filter((m) => m.type === 'player_left')).toEqual([
      { v: 1, type: 'player_left', revision: expect.any(Number), playerId: ids[1], reason: 'eliminated' },
      { v: 1, type: 'player_left', revision: expect.any(Number), playerId: ids[2], reason: 'eliminated' },
      { v: 1, type: 'player_left', revision: expect.any(Number), playerId: ids[3], reason: 'eliminated' },
    ]);
    const end = msgs.find((m) => m.type === 'match_end');
    expect(end).toEqual({
      v: 1, type: 'match_end', revision: expect.any(Number), matchId, reason: 'survival', winners: [host], standings: [],
    });
    vi.useRealTimers();
  });

  it('2 人与 6 人边界：2 人首淘汰即终局；6 人第 5 次淘汰才终局', async () => {
    const two = await runningMatch(2);
    const r = mustElim(two.room.reportElimination(two.ids[1], two.matchId, T0 + 10_000));
    expect(r.matchEnded).toBe(true);
    expect(r.winners).toEqual([two.host]);
    vi.useRealTimers();
    const six = await runningMatch(6);
    for (let i = 1; i <= 4; i += 1) {
      const ri = mustElim(six.room.reportElimination(six.ids[i], six.matchId, T0 + i * 1000));
      expect(ri.matchEnded).toBe(false); // 还剩 ≥2 人
    }
    const r5 = mustElim(six.room.reportElimination(six.ids[5], six.matchId, T0 + 5000));
    expect(r5.matchEnded).toBe(true);
    expect(r5.winners).toEqual([six.host]);
    vi.useRealTimers();
  });

  it('只认当前局 matchId：陈旧/错误 matchId 拒绝且不入账', async () => {
    const { room, ids, sql, matchId } = await runningMatch(3);
    expect(room.reportElimination(ids[1], 'm_stale0000', T0 + 5000)).toEqual({
      eliminated: false,
      error: 'MATCH_MISMATCH',
    });
    expect(room.reportElimination(ids[1], 'garbage!!', T0 + 5000)).toEqual({
      eliminated: false,
      error: 'MATCH_MISMATCH',
    });
    expect(elimRows(sql).length).toBe(0); // 未接受任何淘汰时间
    const ok = room.reportElimination(ids[1], matchId, T0 + 6000);
    expect(ok.eliminated).toBe(true);
    vi.useRealTimers();
  });

  it('身份校验：非参赛成员与 LOBBY 态事件均拒绝（反向）', async () => {
    const { room, matchId } = await runningMatch(2);
    expect(room.reportElimination('p_nobody', matchId, T0 + 5000)).toEqual({
      eliminated: false,
      error: 'NOT_PARTICIPANT',
    });
    vi.useRealTimers();
    vi.useFakeTimers({ now: T0 });
    const { ctx } = makeFakeCtx();
    const lobby = new RoomDO(ctx as never, {} as never);
    const created = await lobby.createRoom({ nickname: 'h', capacity: 2, randomMode: 'S1', startLevel: 1 });
    if (!created.claimed) throw new Error('claim failed');
    expect(lobby.reportElimination(created.playerId, 'm_whatever', T0)).toEqual({
      eliminated: false,
      error: 'BAD_STATE', // LOBBY 无进行中比赛
    });
    vi.useRealTimers();
  });

  it('重复淘汰事件幂等：返回原服务端时间、不重复广播 player_left', async () => {
    const { room, ids, states, matchId } = await runningMatch(3);
    const first = mustElim(room.reportElimination(ids[1], matchId, T0 + 60_000));
    const dup = room.reportElimination(ids[1], matchId, T0 + 999_999); // 更晚 now 不改写
    expect(dup).toEqual({ eliminated: true, alreadyEliminated: true, eliminatedAt: T0 + 60_000, matchEnded: false, winners: [] });
    expect(first.eliminatedAt).toBe(T0 + 60_000);
    const left = parsed(states.get(ids[2]) as WsState).filter((m) => m.type === 'player_left');
    expect(left.length).toBe(1); // 两次事件仅一次广播
    vi.useRealTimers();
  });

  it('已结束事件幂等：终局后再报淘汰 BAD_STATE，不追加 match_end', async () => {
    const { room, host, ids, states, matchId } = await runningMatch(2);
    room.reportElimination(ids[1], matchId, T0 + 30_000); // 即刻终局
    const after = room.reportElimination(host, matchId, T0 + 40_000);
    expect(after).toEqual({ eliminated: false, error: 'BAD_STATE' });
    const ends = parsed(states.get(host) as WsState).filter((m) => m.type === 'match_end');
    expect(ends.length).toBe(1);
    expect(room.getLobbyState()?.state).toBe('FINISHED');
    vi.useRealTimers();
  });

  it('0 人同刻出局可并列：同一结算批次两人同刻淘汰 → winners 并列两人', async () => {
    const { room, ids, matchId } = await runningMatch(2);
    const t = T0 + 120_000;
    const b = room.reportEliminations(ids, matchId, t); // 同批次同刻（方案 §1.7）
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error('batch failed');
    expect(b.accepted.slice().sort()).toEqual(ids.slice().sort());
    expect(b.matchEnded).toBe(true);
    expect(b.winners.slice().sort()).toEqual(ids.slice().sort()); // 0 存活同刻并列
    expect(room.getLobbyState()?.state).toBe('FINISHED');
    vi.useRealTimers();
  });

  it('0 人出局并列组=最晚淘汰时刻组：较早批次出局者不入 winners', async () => {
    const { room, host, ids, matchId } = await runningMatch(4);
    const b1 = room.reportEliminations([ids[1], ids[2]], matchId, T0 + 100_000);
    expect(b1.ok && b1.matchEnded).toBe(false); // 还剩 host 与 ids[3]
    const b2 = room.reportEliminations([host, ids[3]], matchId, T0 + 100_001);
    expect(b2.ok).toBe(true);
    if (!b2.ok) throw new Error('batch failed');
    expect(b2.matchEnded).toBe(true);
    expect(b2.winners.slice().sort()).toEqual([host, ids[3]].sort()); // 最晚时刻组并列
    vi.useRealTimers();
  });

  it('禁止客户端指定淘汰时间：入库 eliminated_at 恒为服务端接收时刻', async () => {
    const { room, ids, sql, matchId } = await runningMatch(2);
    const serverNow = T0 + 45_000;
    room.reportElimination(ids[1], matchId, serverNow);
    const rows = elimRows(sql);
    expect(rows).toEqual([{ player_id: ids[1], eliminated_at: serverNow, match_id: matchId }]);
    vi.useRealTimers();
  });

  it('比赛中退出视为淘汰：leaveRoom 入账并参与裁决（N15 复审 O2）', async () => {
    const { room, host, ids, sql, matchId } = await runningMatch(3);
    const left = room.leaveRoom(ids[1]);
    expect(left.left).toBe(true);
    const rows = elimRows(sql);
    expect(rows.length).toBe(1); // 退出者以服务端时刻入账
    expect(rows[0].player_id).toBe(ids[1]);
    // 退出者已入账：再淘汰一人 → 最后 1 人（host）胜出
    const r = mustElim(room.reportElimination(ids[2], matchId, T0 + 200_000));
    expect(r.matchEnded).toBe(true);
    expect(r.winners).toEqual([host]);
    vi.useRealTimers();
  });

  it('超时终局胜者=存活者：淘汰 1 人后到期，winners 不含被淘汰者', async () => {
    const { room, host, ids, states, matchId, deadlineAt } = await runningMatch(3);
    room.reportElimination(ids[2], matchId, T0 + 90_000);
    vi.setSystemTime(deadlineAt);
    await room.alarm();
    expect(room.getLobbyState()?.state).toBe('FINISHED');
    const end = parsed(states.get(host) as WsState).find((m) => m.type === 'match_end');
    expect(end).toEqual({
      v: 1, type: 'match_end', revision: expect.any(Number), matchId, reason: 'timeout',
      winners: expect.arrayContaining([host, ids[1]]), standings: [],
    });
    expect(((end as { winners: string[] }).winners ?? []).length).toBe(2); // 存活 2 人并列
    vi.useRealTimers();
  });

  it('下一局清空淘汰：nextRound 后重新开局可再次淘汰同一人', async () => {
    const { room, host, ids, matchId } = await runningMatch(2);
    room.reportElimination(ids[1], matchId, T0 + 30_000); // 终局
    const nr = room.nextRound(host);
    if (!nr.ok) throw new Error('nextRound failed');
    for (const id of ids) room.setReady(id, true);
    const res2 = room.startGame(host);
    if (!res2.started) throw new Error('restart failed');
    room.advanceToRunning(res2.match.startAt); // 新一局须 RUNNING 才可淘汰
    expect(res2.match.matchId).not.toBe(matchId);
    const r = room.reportElimination(ids[1], res2.match.matchId, T0 + 400_000);
    expect(r).toEqual({ eliminated: true, alreadyEliminated: false, eliminatedAt: T0 + 400_000, matchEnded: true, winners: [host] });
    vi.useRealTimers();
  });
});
