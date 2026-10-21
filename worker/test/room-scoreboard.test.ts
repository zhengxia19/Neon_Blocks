// N28：排行榜 dirty 批处理与发布——事件时间戳门控 ≤2Hz、无常驻定时器/每变更
// Alarm、静默窗单定时器合并、关键状态（淘汰/终局）立即广播、零写库、
// 全员同一份 entries+revision、revision 房间级单调。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { COUNTDOWN_MS, type CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';
import type { WsState } from './room-routing-helpers';
import { makeFakeWs, T0, EMPTY_BOARD } from './room-routing-helpers';

function snapMsg(seq: number, score: number, lines: number): string {
  return JSON.stringify({
    v: 1,
    type: 'snapshot',
    seq,
    snapshot: { seq, board: EMPTY_BOARD, active: null, score, lines, level: 1, status: 'running' },
  });
}

/** 就绪大厅 → 开局 → 假时钟推进到 startAt → RUNNING（首榜已发布）。 */
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
  const sockets = new Map<string, WebSocket>();
  for (const id of ids) {
    const { ws, state } = makeFakeWs();
    const issued = await room.issueTicket(id, tokens.get(id) as string);
    if (!issued.issued) throw new Error('ticket failed');
    await room.attachWebSocket(issued.ticket, ws);
    states.set(id, state);
    sockets.set(id, ws);
  }
  const res = room.startGame(created.playerId);
  if (!res.started) throw new Error(JSON.stringify(res));
  // 假时钟推进到 startAt（模拟 N17 Alarm 到点），临界 now === startAt 开局。
  vi.advanceTimersByTime(COUNTDOWN_MS);
  const adv = room.advanceToRunning();
  if (!adv.started) throw new Error(JSON.stringify(adv));
  return {
    room,
    ctx,
    store,
    alarmCalls,
    host: created.playerId,
    ids,
    tokens,
    states,
    sockets,
    matchId: res.match.matchId,
  };
}

function parsed(state: WsState): Record<string, unknown>[] {
  return state.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function scoreboards(state: WsState): Record<string, unknown>[] {
  return parsed(state).filter((m) => m.type === 'scoreboard');
}

function tableRowCounts(db: { prepare(q: string): { all(...p: unknown[]): unknown[] } }): number {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  let total = 0;
  for (const t of tables) {
    total += (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).all() as { c: number }[])[0].c;
  }
  return total;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('N28 排行榜 dirty 批处理与发布', () => {
  it('开局首榜：全员收到同一份零分榜单（rank 全并列 1）', async () => {
    const { ids, states } = await runningMatch(6);
    const first = scoreboards(states.get(ids[0]) as WsState);
    expect(first.length).toBe(1);
    const entries = first[0].entries as Record<string, unknown>[];
    expect(entries.length).toBe(6);
    expect(entries.every((e) => e.score === 0 && e.rank === 1 && e.status === 'playing')).toBe(true);
    // 全员同一份：逐字段一致（含 revision）。
    for (const id of ids) {
      expect(scoreboards(states.get(id) as WsState)).toEqual(first);
    }
  });

  it('6 人 5Hz×5s 快照压力：榜单广播 ≤2Hz（含首榜 ≤11 条）且全员一致', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    // 5 秒内每人 25 帧（200ms 间隔，分数每帧变化）=150 帧。
    for (let k = 1; k <= 25; k += 1) {
      vi.advanceTimersByTime(200);
      ids.forEach((id, i) => {
        room.webSocketMessage(sockets.get(id) as never, snapMsg(k, k * 100 + i, k));
      });
    }
    for (const id of ids) {
      const boards = scoreboards(states.get(id) as WsState);
      expect(boards.length).toBeLessThanOrEqual(11); // 首榜 + 5s×2Hz
      expect(boards.length).toBeGreaterThanOrEqual(9); // 确在持续发布（非饿死）
    }
    // 最新一帧：末帧变化在窗口外补发（再推 500ms 到点），分数最高者居首且全员一致。
    vi.advanceTimersByTime(500);
    const last = scoreboards(states.get(ids[0]) as WsState).at(-1) as Record<string, unknown>;
    const entries = last.entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ playerId: ids[5], score: 25 * 100 + 5, rank: 1 });
    for (const id of ids) {
      expect(scoreboards(states.get(id) as WsState).at(-1)).toEqual(last);
    }
  });

  it('无待发送变化不唤醒：seq 递增但成绩不变 → 零新广播、零定时器', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    for (let k = 1; k <= 10; k += 1) {
      vi.advanceTimersByTime(200);
      // 成绩与首榜（全 0）一致：入账标脏但发布时内容无变化 → 去重跳过。
      room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(k, 0, 0));
    }
    expect(scoreboards(states.get(ids[0]) as WsState).length).toBe(1); // 仅首榜
    expect(scoreboards(states.get(ids[1]) as WsState).length).toBe(1);
    expect(vi.getTimerCount()).toBe(0); // 无常驻定时器、无空转唤醒
    // 负向对照：距上次发布已超窗（2s），成绩一变立即发布（不挂定时器空等）。
    const n = scoreboards(states.get(ids[0]) as WsState).length;
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(11, 600, 6));
    expect(scoreboards(states.get(ids[0]) as WsState).length).toBe(n + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('静默窗合并：窗内多次变化只挂 1 个定时器，到点一次发布最新值', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    vi.advanceTimersByTime(100); // 距首榜 100ms（静默窗内）
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 100, 1));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 200, 2));
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(2, 300, 3)); // 同窗再变
    expect(vi.getTimerCount()).toBe(1); // 不重复挂、不重置窗口
    const before = scoreboards(states.get(ids[2]) as WsState).length;
    vi.advanceTimersByTime(400); // 到点（首榜+500ms）
    const boards = scoreboards(states.get(ids[2]) as WsState);
    expect(boards.length).toBe(before + 1); // 只发一次
    const entries = boards.at(-1)?.entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ playerId: ids[0], score: 300 }); // 合并后最新值
    expect(vi.getTimerCount()).toBe(0);
  });

  it('淘汰=关键状态：静默窗内立即广播，死人留榜分数冻结', async () => {
    const { room, ids, states, sockets, matchId } = await runningMatch(3);
    vi.advanceTimersByTime(100);
    // 先给 ids[1] 入账一个成绩帧（淘汰后该分数应冻结留榜）。
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 420, 4));
    const before = scoreboards(states.get(ids[2]) as WsState).length;
    room.reportElimination(ids[1], matchId, Date.now());
    const boards = scoreboards(states.get(ids[2]) as WsState);
    expect(boards.length).toBe(before + 1); // 未推进时钟即已发布
    const entries = boards.at(-1)?.entries as Record<string, unknown>[];
    const dead = entries.find((e) => e.playerId === ids[1]);
    expect(dead).toMatchObject({ status: 'eliminated', score: 420 }); // 留榜、分数冻结
    expect(entries.length).toBe(3); // 死人不出榜
  });

  it('快照压力+发布全程零写库（spy 语句级：无 UPDATE/DELETE，INSERT 仅幂等 ensure）', async () => {
    const { room, ids, store, sockets, alarmCalls } = await runningMatch(6);
    const rows0 = tableRowCounts(store.db);
    const alarm0 = alarmCalls.length; // startGame 已排 1 个 deadline Alarm
    // 复审 P2-2：行数对比抓不到 UPDATE——spy sql.exec 做语句级断言。
    const stmts: string[] = [];
    const sqlObj = store.sql;
    const origExec = sqlObj.exec.bind(sqlObj);
    (sqlObj as { exec: (q: string, ...b: unknown[]) => unknown }).exec = (q, ...b) => {
      stmts.push(q);
      return origExec(q, ...b);
    };
    for (let k = 1; k <= 10; k += 1) {
      vi.advanceTimersByTime(200);
      ids.forEach((id, i) => {
        room.webSocketMessage(sockets.get(id) as never, snapMsg(k, k * 10 + i, k));
      });
    }
    expect(stmts.length).toBeGreaterThan(0); // spy 生效（负向对照）
    expect(stmts.filter((q) => /^\s*(UPDATE|DELETE|REPLACE)/i.test(q))).toEqual([]);
    for (const q of stmts.filter((q) => /INSERT/i.test(q))) {
      expect(q).toMatch(/INSERT OR IGNORE INTO room_meta/i); // 仅幂等 ensureRow
    }
    expect(tableRowCounts(store.db)).toBe(rows0);
    expect(alarmCalls.length).toBe(alarm0); // 复审 O-4：批处理不新增 Alarm
  });

  it('revision 房间级单调：榜单广播逐批递增且全员同 revision', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    for (let k = 1; k <= 6; k += 1) {
      vi.advanceTimersByTime(200);
      room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(k, k * 100, k));
    }
    const boards = scoreboards(states.get(ids[1]) as WsState);
    const revs = boards.map((b) => b.revision as number);
    expect(revs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < revs.length; i += 1) expect(revs[i] as number).toBeGreaterThan(revs[i - 1] as number);
    for (const id of ids) expect(scoreboards(states.get(id) as WsState)).toEqual(boards);
  });

  it('终局立即发布最终榜（得分降序不切换）；被淘汰者后续快照不再触发', async () => {
    const { room, ids, states, sockets, matchId } = await runningMatch(3);
    // 三人分别入账 100/200/300 分。
    ids.forEach((id, i) => {
      room.webSocketMessage(sockets.get(id) as never, snapMsg(1, (i + 1) * 100, i + 1));
    });
    const before = scoreboards(states.get(ids[2]) as WsState).length;
    const batch = room.reportEliminations([ids[0], ids[1]], matchId, Date.now());
    expect(batch.ok && batch.matchEnded).toBe(true);
    const boards = scoreboards(states.get(ids[2]) as WsState);
    expect(boards.length).toBe(before + 1); // 终局关键状态：立即（未推进时钟）
    const entries = boards.at(-1)?.entries as Record<string, unknown>[];
    expect(entries.map((e) => e.score)).toEqual([300, 200, 100]); // 仍得分降序不切换
    expect(entries.map((e) => e.status)).toEqual(['playing', 'eliminated', 'eliminated']);
    // 负向：被淘汰者快照被入账层拒绝，不再触发榜单。
    const n = scoreboards(states.get(ids[2]) as WsState).length;
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(2, 9999, 9));
    expect(scoreboards(states.get(ids[2]) as WsState).length).toBe(n);
  });

  it('跨局作废批处理：nextRound 清 dirty/定时器，新局首榜分数归零', async () => {
    const { room, host, ids, states, sockets, matchId } = await runningMatch(3);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 700, 7));
    expect(room.pipelineStats().sbTimerPending).toBe(true); // 静默窗内挂起
    room.finishGame();
    const nr = room.nextRound(host);
    expect(nr.ok).toBe(true);
    expect(room.pipelineStats().sbTimerPending).toBe(false);
    expect(room.pipelineStats().sbDirty).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // 陈旧定时器已取消（不补发上局榜）
    const before = scoreboards(states.get(ids[1]) as WsState).length;
    // 重开一局：ready→start→到点 RUNNING。
    for (const id of ids) room.setReady(id, true);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    vi.advanceTimersByTime(COUNTDOWN_MS);
    expect(room.advanceToRunning().started).toBe(true);
    const boards = scoreboards(states.get(ids[1]) as WsState);
    expect(boards.length).toBe(before + 1);
    const entries = boards.at(-1)?.entries as Record<string, unknown>[];
    expect(entries.every((e) => e.score === 0)).toBe(true); // 上局成绩不残留
    void matchId;
  });

  it('DO 驱逐重建：槽空且已开球过窗则跳过发布（0 分假榜不覆盖正确榜）；入账后重建真榜', async () => {
    const { room, ctx, ids, states, sockets, matchId } = await runningMatch(3);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 700, 7));
    vi.advanceTimersByTime(500); // 到点发布 700 分真榜
    const boardsBefore = scoreboards(states.get(ids[1]) as WsState).length;
    expect(
      (scoreboards(states.get(ids[1]) as WsState).at(-1)?.entries as Record<string, unknown>[])[0],
    ).toMatchObject({ playerId: ids[0], score: 700 });
    // 模拟驱逐：同一 ctx 重建实例（内存槽/批处理态全归零）。
    const room2 = new RoomDO(ctx as never, {} as never);
    // 负向：非快照事件（淘汰立即通道）此刻槽全空且 now-startAt=3500≥500 → 跳过，
    // 不得发布全员 0 分假榜覆盖客户端已显示的正确榜。
    room2.reportElimination(ids[1], matchId, Date.now());
    expect(scoreboards(states.get(ids[1]) as WsState).length).toBe(boardsBefore);
    // 正向对照：快照入账槽非空 → 立即发布含真实成绩的榜。
    room2.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 900, 9));
    const boards = scoreboards(states.get(ids[1]) as WsState);
    expect(boards.length).toBe(boardsBefore + 1);
    const entries = boards.at(-1)?.entries as Record<string, unknown>[];
    expect(entries.find((e) => e.playerId === ids[0])).toMatchObject({ score: 900 });
  });

  it('N44：局中重连 attach 单发补发当前榜（同内容同 revision，他人零新广播）', async () => {
    const { room, host, ids, tokens, states, sockets } = await runningMatch(2);
    // 先发布一份非零真榜（补发应给最新已发布榜，而非零分首榜）。
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 500, 5));
    vi.advanceTimersByTime(500); // 静默窗到点，真榜已发布
    const lastBoard = scoreboards(states.get(host) as WsState).at(-1) as Record<string, unknown>;
    expect((lastBoard.entries as Record<string, unknown>[])[0]).toMatchObject({ score: 500 });
    const hostBefore = scoreboards(states.get(host) as WsState).length;
    // 复现跨网竞态：旧连接尚未 close 处理，新票据 + 新连接先 attach（全程无状态变化）。
    const issued = await room.issueTicket(ids[1], tokens.get(ids[1]) as string);
    if (!issued.issued) throw new Error('ticket failed');
    const { ws: ws2, state: state2 } = makeFakeWs();
    await room.attachWebSocket(issued.ticket, ws2);
    // 正向：新连接 attach 即收到当前榜，内容与最新已发布榜逐字段一致（含 revision）。
    const boards = scoreboards(state2);
    expect(boards.length).toBe(1);
    expect(boards[0]).toEqual(lastBoard);
    // 负向：补发是单发——不占新 revision、他人无新榜单广播。
    expect(scoreboards(states.get(host) as WsState).length).toBe(hostBefore);
  });

  it('N44 负向：大厅 attach（无已发布榜）与驱逐重建后 attach 均不补发', async () => {
    vi.useFakeTimers({ now: T0 });
    const { ctx } = makeFakeCtx();
    const room = new RoomDO(ctx as never, {} as never);
    const created = await room.createRoom({
      nickname: 'host1',
      capacity: 2,
      randomMode: 'S1',
      startLevel: 1,
    });
    if (!created.claimed) throw new Error('claim failed');
    const { ws, state } = makeFakeWs();
    const issued = await room.issueTicket(created.playerId, created.seatToken);
    if (!issued.issued) throw new Error('ticket failed');
    await room.attachWebSocket(issued.ticket, ws);
    expect(scoreboards(state).length).toBe(0); // 大厅无榜可补
    // 驱逐重建：内存已发布榜归零 → attach 不补发（等下次快照入账自然广播真榜）。
    const { room: room2, ctx: ctx2, ids, tokens } = await runningMatch(2);
    vi.advanceTimersByTime(1000); // 开球已过发布守卫窗（模拟局中驱逐时刻）
    const room3 = new RoomDO(ctx2 as never, {} as never);
    const issued2 = await room3.issueTicket(ids[1], tokens.get(ids[1]) as string);
    if (!issued2.issued) throw new Error('ticket failed');
    const { ws: ws3, state: state3 } = makeFakeWs();
    await room3.attachWebSocket(issued2.ticket, ws3);
    expect(scoreboards(state3).length).toBe(0);
    void room2;
  });
});
