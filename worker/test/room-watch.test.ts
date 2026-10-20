// N30：自动观战目标切换——目标仅在排行榜 revision 发布/房间状态改变时经
// N29 纯函数重估（按入站事件合并、不新增定时器）；切换 ≤1 秒内稳定；
// watch_target 逐观看者单发；旧目标待补帧即弃；淘汰者仍可为目标/观看者；
// 公共排行榜不因目标而变（各席位收到的 entries 逐字段一致）。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';
import { EMPTY_BOARD, makeFakeWs, T0, type WsState } from './room-routing-helpers';

function snapPayload(seq: number, score: number, lines: number) {
  return {
    seq,
    board: EMPTY_BOARD,
    active: null,
    score,
    lines,
    level: 1,
    status: 'running',
  };
}

function snapMsg(seq: number, score = 100 * seq, lines = seq): string {
  return JSON.stringify({
    v: 1,
    type: 'snapshot',
    seq,
    snapshot: snapPayload(seq, score, lines),
  });
}

/** 就绪大厅 → 开局 → RUNNING（假时钟停在 T0，startAt=T0+3000）。
 * clearSent=false 保留开局广播（首榜 + 首个自动目标断言面）。 */
async function runningMatch(capacity: number, clearSent = true) {
  vi.useFakeTimers({ now: T0 });
  const { ctx } = makeFakeCtx();
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
  room.advanceToRunning(res.match.startAt);
  if (clearSent) {
    for (const st of states.values()) st.sent.length = 0;
  }
  return {
    room,
    host: created.playerId,
    ids,
    states,
    sockets,
    matchId: res.match.matchId,
    startAt: res.match.startAt,
  };
}

function parsed(state: WsState): Record<string, unknown>[] {
  return state.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function watchTargetsOf(state: WsState): Record<string, unknown>[] {
  return parsed(state).filter((m) => m.type === 'watch_target');
}

function remoteSnaps(state: WsState): Record<string, unknown>[] {
  return parsed(state).filter((m) => m.type === 'remote_snapshot');
}

function scoreboardsOf(state: WsState): Record<string, unknown>[] {
  return parsed(state).filter((m) => m.type === 'scoreboard');
}

describe('N30 自动观战目标切换', () => {
  it('开局首榜发布同事件下发自动目标；各席位 scoreboard entries 逐字段一致', async () => {
    const { room, ids, states } = await runningMatch(3, false);
    void room;
    // 全零分（N29 规则 2）：ids[0]→ids[1]，ids[1]、ids[2]→ids[0]。
    const expected = [ids[1], ids[0], ids[0]];
    const entryJsons: string[] = [];
    for (const [index, id] of ids.entries()) {
      const msgs = parsed(states.get(id) as WsState);
      // N33：attach 走全量广播——先连接的席位每有一次后续 attach 多收一条 room_state。
      const lead = ids.length - index;
      expect(msgs.map((m) => m.type)).toEqual([
        ...new Array<string>(lead).fill('room_state'),
        'countdown',
        'match_start',
        'scoreboard',
        'watch_target',
      ]);
      expect(msgs[lead + 3]).toEqual({
        v: 1,
        type: 'watch_target',
        revision: expect.any(Number),
        targetPlayerId: expected[index],
      });
      const boards = scoreboardsOf(states.get(id) as WsState);
      expect(boards.length).toBe(1);
      entryJsons.push(JSON.stringify(boards[0].entries));
    }
    // 公共排行榜与目标无关：三份 entries 完全一致。
    expect(entryJsons[1]).toBe(entryJsons[0]);
    expect(entryJsons[2]).toBe(entryJsons[0]);
    vi.useRealTimers();
  });

  it('验收 A：A/B/C 各看不同对象时，各席位收到的榜单仍逐字段一致', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    // 成绩 A=100 < B=200 < C=300 → A→B、B→C、C→A（规则 1 + 规则 2）。
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 100, 1));
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 200, 2));
    room.webSocketMessage(sockets.get(ids[2]) as never, snapMsg(1, 300, 3));
    vi.advanceTimersByTime(3500); // 事件挂起的合并定时器到点（startAt+500）
    const expected = [ids[1], ids[2], ids[0]];
    const entryJsons: string[] = [];
    for (const [index, id] of ids.entries()) {
      const wt = watchTargetsOf(states.get(id) as WsState);
      // 仅目标改变者收到 watch_target：A（本就 ids[1]）与 C（本就 ids[0]）不变，仅 B 变化。
      if (index === 1) {
        expect(wt).toEqual([
          { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: expected[index] },
        ]);
      } else {
        expect(wt.length).toBe(0);
      }
      const boards = scoreboardsOf(states.get(id) as WsState);
      expect(boards.length).toBe(1); // 本轮发布（首榜已在 fixture 中清空）
      entryJsons.push(JSON.stringify(boards[0].entries));
    }
    expect(entryJsons[1]).toBe(entryJsons[0]);
    expect(entryJsons[2]).toBe(entryJsons[0]);
    // 切换后路由：各席位只收自身新目标流。
    for (const st of states.values()) st.sent.length = 0;
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(2, 100, 1));
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(2, 200, 2));
    room.webSocketMessage(sockets.get(ids[2]) as never, snapMsg(2, 300, 3));
    for (const [index, id] of ids.entries()) {
      const snaps = remoteSnaps(states.get(id) as WsState);
      expect(snaps.length).toBe(1);
      expect(snaps[0]).toMatchObject({ targetPlayerId: expected[index], snapshot: { seq: 2 } });
    }
    vi.useRealTimers();
  });

  it('切换 ≤1 秒稳定：随合并定时器到点即达（≤500ms），全程不新增定时器', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    // C 冲到 300 分：A、B 的目标改为 C；C 的目标仍为 ids[0]（不变）。
    room.webSocketMessage(sockets.get(ids[2]) as never, snapMsg(1, 300, 3));
    expect(vi.getTimerCount()).toBe(1); // 仅 #sbTimer：目标重估不新增定时器
    vi.advanceTimersByTime(3499); // 未到合并点（startAt+500-1）
    expect(watchTargetsOf(states.get(ids[0]) as WsState).length).toBe(0);
    expect(watchTargetsOf(states.get(ids[1]) as WsState).length).toBe(0);
    vi.advanceTimersByTime(1); // 恰在事件后 500ms（≤1 秒）发布并切换
    expect(watchTargetsOf(states.get(ids[0]) as WsState)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[2] },
    ]);
    expect(watchTargetsOf(states.get(ids[1]) as WsState)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[2] },
    ]);
    expect(watchTargetsOf(states.get(ids[2]) as WsState).length).toBe(0); // 目标未变不通知
    expect(vi.getTimerCount()).toBe(0); // 一次性定时器已消化，无常驻定时器
    vi.useRealTimers();
  });

  it('验收 B：目标切换即弃旧目标待补帧（背压槽清空），旧目标后续帧不再入流', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    const stA = states.get(ids[0]) as WsState;
    stA.bufferedAmount = 20_000; // A 慢连接：旧目标 B 的帧进入背压单槽
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 100, 1));
    expect(room.pipelineStats().outSlots).toBe(1);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(5, 500, 5));
    vi.advanceTimersByTime(3500); // 发布 → 重估：A 目标 B→C（变化）
    expect(watchTargetsOf(stA)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[2] },
    ]);
    // 旧目标 B 的排队帧被丢弃：槽归零。
    expect(room.pipelineStats().outSlots).toBe(0);
    stA.bufferedAmount = 0;
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(2, 100, 1)); // 旧目标后续帧
    room.webSocketMessage(sockets.get(ids[2]) as never, snapMsg(1, 0, 0)); // 新目标帧
    const snaps = remoteSnaps(stA);
    // 旧目标帧（seq1 排队 + seq2 后续）全部被丢弃：只剩新目标 C 的 1 帧。
    expect(snaps.length).toBe(1);
    expect(snaps[0]).toMatchObject({ targetPlayerId: ids[2], snapshot: { seq: 1 } });
    vi.useRealTimers();
  });

  it('淘汰者仍可为目标（冻结最后一帧补发）与观看者（仍收 watch_target）', async () => {
    const { room, ids, states, sockets, matchId } = await runningMatch(3);
    // B 留下一帧（score 0）后被淘汰（保留席位，成绩冻结）。
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 0, 0));
    expect(room.reportElimination(ids[1], matchId, T0 + 1_000)).toMatchObject({ eliminated: true });
    // 淘汰不改成绩 → 目标不变 → 无 watch_target（榜单状态变化仍发布）。
    expect(watchTargetsOf(states.get(ids[0]) as WsState).length).toBe(0);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 100, 1));
    vi.advanceTimersByTime(1_500); // 合并点到点（T0+1500）：A=100 目标仍 B（并列最低按加入序）
    expect(watchTargetsOf(states.get(ids[0]) as WsState).length).toBe(0);
    room.webSocketMessage(sockets.get(ids[2]) as never, snapMsg(1, 200, 2));
    vi.advanceTimersByTime(500); // A→C；C→B（淘汰者仍为目标）
    expect(watchTargetsOf(states.get(ids[0]) as WsState)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[2] },
    ]);
    const stC = states.get(ids[2]) as WsState;
    // C 的新目标为被淘汰的 B：watch_target 后紧随冻结最后一帧补发。
    expect(watchTargetsOf(stC)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[1] },
    ]);
    const backfills = remoteSnaps(stC).filter((m) => m.targetPlayerId === ids[1]);
    expect(backfills.length).toBe(1);
    expect(backfills[0]).toMatchObject({ snapshot: { seq: 1 } }); // 冻结的最后一帧即时补发
    // 淘汰者作为观看者：A 升到 300 → B 的目标 A→C → B 仍收到 watch_target。
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(2, 300, 2));
    vi.advanceTimersByTime(500);
    expect(watchTargetsOf(states.get(ids[1]) as WsState)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[2] },
    ]);
    // 淘汰目标不再产生新帧（N25 拒收其快照）：观看者保持已收的冻结最后一帧。
    for (const st of states.values()) st.sent.length = 0;
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(2, 0, 0));
    expect(remoteSnaps(states.get(ids[0]) as WsState).length).toBe(0);
    expect(remoteSnaps(states.get(ids[2]) as WsState).length).toBe(0);
    vi.useRealTimers();
  });

  it('手动 setWatchTarget 为临时覆盖：下一次榜单发布按自动算法重估覆盖', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    expect(room.setWatchTarget(ids[0], ids[2]).ok).toBe(true); // 手动覆盖自动目标 ids[1]
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1, 100, 1));
    vi.advanceTimersByTime(3_500); // 合并点到点：自动重估 A(0) 的刚好更高为 B(100) → 覆盖手动目标
    expect(watchTargetsOf(states.get(ids[0]) as WsState)).toEqual([
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[2] },
      { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: ids[1] },
    ]);
    void sockets;
    vi.useRealTimers();
  });

  it('反向：榜单未发布（entries 去重/无变化）则不重估、不通知', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 100, 1));
    vi.advanceTimersByTime(3_500); // 合并点到点：发布一次，目标不变（A→B 仍成立）→ 无 watch_target
    expect(watchTargetsOf(states.get(ids[0]) as WsState).length).toBe(0);
    expect(scoreboardsOf(states.get(ids[0]) as WsState).length).toBe(1);
    // 完全相同的快照重发：陈旧 seq 直接丢弃；即便入账 entries 去重也不发布。
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 100, 1));
    vi.advanceTimersByTime(1_000);
    expect(scoreboardsOf(states.get(ids[0]) as WsState).length).toBe(1);
    expect(watchTargetsOf(states.get(ids[0]) as WsState).length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    void sockets;
    vi.useRealTimers();
  });

  it('驱逐+延迟开赛：首榜被空槽守卫跳过仍全量下发 watch_target，随快照入账自纠', async () => {
    // 复审 P2-1（N30）：DO 驱逐后闹钟延迟 600ms 开赛——N28 空槽守卫跳过 0 分假榜，
    // 但目标映射必须建立并通知（全零基线），否则服务端按新映射路由而客户端从未
    // 收到 watch_target，弃帧致对手棋盘空白。
    vi.useFakeTimers({ now: T0 });
    const { ctx } = makeFakeCtx();
    const room = new RoomDO(ctx as never, {} as never);
    const created = await room.createRoom({ nickname: 'host1', capacity: 3, randomMode: 'S1', startLevel: 1 });
    if (!created.claimed) throw new Error('claim failed');
    const ids = [created.playerId];
    const tokens = new Map<string, string>([[created.playerId, created.seatToken]]);
    for (let i = 1; i < 3; i += 1) {
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
    // 驱逐：新实例（内存槽/映射全空），闹钟延迟 600ms 才开赛。
    const room2 = new RoomDO(ctx as never, {} as never);
    for (const st of states.values()) st.sent.length = 0;
    expect(room2.advanceToRunning(res.match.startAt + 600).started).toBe(true);
    const expected = [ids[1], ids[0], ids[0]]; // 全零基线（N29 规则 2）
    for (const [index, id] of ids.entries()) {
      expect(scoreboardsOf(states.get(id) as WsState).length).toBe(0); // 假榜仍被守卫跳过
      expect(watchTargetsOf(states.get(id) as WsState)).toEqual([
        { v: 1, type: 'watch_target', revision: expect.any(Number), targetPlayerId: expected[index] },
      ]);
    }
    // 快照入账即发真榜；基线目标已正确 ⇒ 不重复通知；路由立即生效（单流）。
    room2.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1, 100, 1));
    expect(scoreboardsOf(states.get(ids[0]) as WsState).length).toBe(1);
    for (const id of ids) {
      expect(watchTargetsOf(states.get(id) as WsState).length).toBe(1); // 无重复
    }
    expect(remoteSnaps(states.get(ids[1]) as WsState).length).toBe(1); // ids[1]/ids[2] 观看 ids[0]
    expect(remoteSnaps(states.get(ids[2]) as WsState).length).toBe(1);
    expect(remoteSnaps(states.get(ids[0]) as WsState).length).toBe(0); // ids[0] 观看 ids[1]（无帧）
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
