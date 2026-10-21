// N26：服务端单目标快照路由——自动目标订阅（N30 起为 N29 算法，开局全零分
// 时 ids[0]→ids[1]、其余→ids[0]）、仅向观察该玩家的连接投递、切换目标即时
// 补发最后一帧、扇出 O(N) 非 O(N²)、订阅随席位/局清理。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';
import { EMPTY_BOARD, makeFakeWs, T0, type WsState } from './room-routing-helpers';

function snapPayload(seq: number) {
  return {
    seq,
    board: EMPTY_BOARD,
    active: null,
    score: 100 * seq,
    lines: seq,
    level: 1,
    status: 'running',
  };
}

function snapMsg(seq: number): string {
  return JSON.stringify({ v: 1, type: 'snapshot', seq, snapshot: snapPayload(seq) });
}

/** 就绪大厅 → 开局 → RUNNING，并为每个席位挂好 Hibernation 连接。
 * leaveIdxBeforeRunning：在倒计时到点前让该序号席位离开（P2-2 场景）。 */
async function runningMatch(capacity: number, leaveIdxBeforeRunning?: number) {
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
  if (leaveIdxBeforeRunning !== undefined) {
    if (!room.leaveRoom(ids[leaveIdxBeforeRunning]).left) throw new Error('leave failed');
  }
  room.advanceToRunning(res.match.startAt);
  // 开局广播不属于本任务断言面：清空出站记录。
  for (const st of states.values()) st.sent.length = 0;
  return {
    room,
    ctx,
    host: created.playerId,
    ids,
    states,
    sockets,
    matchId: res.match.matchId,
  };
}

function parsed(state: WsState): Record<string, unknown>[] {
  return state.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function remoteSnaps(state: WsState): Record<string, unknown>[] {
  return parsed(state).filter((m) => m.type === 'remote_snapshot');
}

describe('N26 单目标快照路由', () => {
  it('自动目标订阅：快照只投递给观察该玩家的席位，其余零收流', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    // 开局全零分（N29 规则 2）：ids[0] 观察 ids[1]，ids[1..5] 均观察 ids[0]。
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    for (let i = 1; i < 6; i += 1) {
      expect(remoteSnaps(states.get(ids[i]) as WsState).length).toBe(1);
      expect(remoteSnaps(states.get(ids[i]) as WsState)[0]).toMatchObject({
        v: 1,
        type: 'remote_snapshot',
        targetPlayerId: ids[0],
      });
    }
    expect(remoteSnaps(states.get(ids[0]) as WsState).length).toBe(0); // 其目标为 ids[1]
    void room;
    vi.useRealTimers();
  });

  it('6 人 × 15 帧：转发总量 = N×帧数（O(N) 非 O(N²)），每席位只收自身目标流', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    for (let seq = 1; seq <= 15; seq += 1) {
      for (const id of ids) room.webSocketMessage(sockets.get(id) as never, snapMsg(seq));
      // N42：出站 ≤5Hz 门控——按真实 publisher 节奏（250ms）推进时钟。
      vi.advanceTimersByTime(250);
    }
    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      const snaps = remoteSnaps(states.get(ids[i]) as WsState);
      total += snaps.length;
      // 每席位至多一条目标流：全部帧来自其自动目标（开局全零分：ids[0]→ids[1]，其余→ids[0]）。
      expect(snaps.length).toBe(15);
      const expectedTarget = i === 0 ? ids[1] : ids[0];
      for (const m of snaps) expect(m.targetPlayerId).toBe(expectedTarget);
    }
    expect(total).toBe(6 * 15); // 若 O(N²) 全发则为 6×6×15=540
    vi.useRealTimers();
  });

  it('切换目标：即时补发 watch_target + 目标最后一帧，旧目标流即停', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    for (const seq of [1, 2, 3]) {
      room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(seq));
      vi.advanceTimersByTime(250); // N42：真实 5Hz 节奏（出站门控不误伤）
    }
    // ids[2] 的自动目标本就是 ids[0]：清空记录后手动切换（同目标仍即时下发）。
    const st2 = states.get(ids[2]) as WsState;
    st2.sent.length = 0;
    const res = room.setWatchTarget(ids[2], ids[0]);
    expect(res.ok).toBe(true);
    const msgs = parsed(st2);
    expect(msgs[0]).toMatchObject({ type: 'watch_target', targetPlayerId: ids[0] });
    expect(msgs[1]).toMatchObject({
      type: 'remote_snapshot',
      targetPlayerId: ids[0],
      snapshot: { seq: 3, score: 300 }, // 最后一帧即时补发
    });
    // 新目标后续帧多观察者（ids[1..5] 均观察 ids[0]）同收；旧目标 ids[3] 的帧不再进 ids[2]。
    vi.advanceTimersByTime(250); // N42：补发帧刷新门控时戳，250ms 后新帧放行
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(4));
    room.webSocketMessage(sockets.get(ids[3]) as never, snapMsg(1));
    expect(remoteSnaps(st2).map((m) => m.targetPlayerId)).toEqual([ids[0], ids[0]]);
    // ids[5] 自动观察 ids[0]：seq1..3（切换前）+ seq4（切换后）共 4 帧。
    expect(remoteSnaps(states.get(ids[5]) as WsState).length).toBe(4);
    vi.useRealTimers();
  });

  it('切到无帧目标：只发 watch_target 不补帧；后续帧开始进流', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    const res = room.setWatchTarget(ids[1], ids[4]);
    expect(res.ok).toBe(true);
    const st1 = states.get(ids[1]) as WsState;
    expect(parsed(st1)).toEqual([
      expect.objectContaining({ type: 'watch_target', targetPlayerId: ids[4] }),
    ]);
    room.webSocketMessage(sockets.get(ids[4]) as never, snapMsg(1));
    expect(remoteSnaps(st1).length).toBe(1);
    vi.useRealTimers();
  });

  it('反向：自观察/非名单目标/非 RUNNING 均拒绝且订阅不变', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    expect(room.setWatchTarget(ids[0], ids[0])).toEqual({ ok: false, error: 'INVALID_TARGET' });
    expect(room.setWatchTarget(ids[0], 'ghost_player')).toEqual({
      ok: false,
      error: 'INVALID_TARGET',
    });
    // 订阅未变：ids[0] 的快照仍只进其自动观察者（ids[1..5]），ids[0] 自身零收流。
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    expect(remoteSnaps(states.get(ids[5]) as WsState).length).toBe(1);
    expect(remoteSnaps(states.get(ids[2]) as WsState).length).toBe(1);
    expect(remoteSnaps(states.get(ids[0]) as WsState).length).toBe(0);
    vi.useRealTimers();
    const lobby = new RoomDO(makeFakeCtx().ctx as never, {} as never);
    expect(lobby.setWatchTarget('p1', 'p2')).toEqual({ ok: false, error: 'BAD_STATE' });
  });

  it('跨局：nextRound 重开后订阅环重建、上局帧不残留补发', async () => {
    const { room, host, ids, states, sockets } = await runningMatch(6);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    expect(room.pipelineStats().watchTargets).toBe(6);
    expect(room.finishGame().finished).toBe(true);
    const nr = room.nextRound(host);
    expect(nr.ok).toBe(true);
    expect(room.pipelineStats().watchTargets).toBe(0);
    for (const id of ids) room.setReady(id, true);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    room.advanceToRunning(res.match.startAt);
    expect(room.pipelineStats().watchTargets).toBe(6);
    // 上局快照已清：切目标只发 watch_target，不补陈旧帧。
    expect(room.setWatchTarget(ids[2], ids[0]).ok).toBe(true);
    const st2 = states.get(ids[2]) as WsState;
    st2.sent.length = 0;
    room.setWatchTarget(ids[2], ids[1]);
    expect(parsed(st2)).toEqual([
      expect.objectContaining({ type: 'watch_target', targetPlayerId: ids[1] }),
    ]);
    vi.useRealTimers();
  });

  it('背压整合：慢观察者入单槽丢旧保新，回落后先补最新帧', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    const st5 = states.get(ids[5]) as WsState;
    st5.bufferedAmount = 20_000;
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    vi.advanceTimersByTime(250); // N42：真实 5Hz 节奏（出站门控不误伤）
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(2));
    expect(remoteSnaps(st5).length).toBe(0);
    expect(room.pipelineStats().outSlots).toBe(1);
    st5.bufferedAmount = 0;
    vi.advanceTimersByTime(250);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(3));
    const snaps = remoteSnaps(st5);
    expect(snaps.map((m) => (m.snapshot as { seq: number }).seq)).toEqual([2, 3]);
    expect(room.pipelineStats().outSlots).toBe(0);
    vi.useRealTimers();
  });

  it('leaveRoom 摘除订阅：离开者不再作为观察者计入扇出', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    expect(room.leaveRoom(ids[5]).left).toBe(true);
    expect(room.pipelineStats().watchTargets).toBe(5);
    for (const st of states.values()) st.sent.length = 0;
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    // ids[1..4] 自动观察 ids[0]；ids[0]（目标 ids[1]）与已离席 ids[5] 零收流。
    for (let i = 1; i <= 4; i += 1) {
      expect(remoteSnaps(states.get(ids[i]) as WsState).length).toBe(1);
    }
    expect(remoteSnaps(states.get(ids[0]) as WsState).length).toBe(0);
    expect(remoteSnaps(states.get(ids[5]) as WsState).length).toBe(0);
    vi.useRealTimers();
  });

  it('P2-1：DO 驱逐重建后惰性重建订阅环，路由恢复（SQLite 态保留）', async () => {
    const { ctx, ids, states, sockets } = await runningMatch(6);
    // 模拟驱逐：同一存储上新实例——内存映射归零，SQLite 席位/局态保留。
    const room2 = new RoomDO(ctx as never, {} as never);
    expect(room2.pipelineStats().watchTargets).toBe(0);
    room2.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    expect(remoteSnaps(states.get(ids[5]) as WsState).length).toBe(1);
    expect(room2.pipelineStats().watchTargets).toBe(6);
    vi.useRealTimers();
  });

  it('P2-2：COUNTDOWN 离席不占环位——存活者路由不指向幽灵目标', async () => {
    // 倒计时到点前 ids[2] 离开（不淘汰、无连接）：环只对 roster∩现存席位构建。
    const { room, ids, states, sockets } = await runningMatch(3, 2);
    // 修复前环为 0→1、1→2(幽灵)、2→0：ids[1] 的目标是幽灵，整局零收流。
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1));
    expect(remoteSnaps(states.get(ids[0]) as WsState).length).toBe(1);
    expect(room.pipelineStats().watchTargets).toBe(2);
    vi.useRealTimers();
  });

  it('N42 出站 ≤5Hz 门控：同刻多帧只放行首帧；窗口滑过后恢复；补发帧不受门控', async () => {
    const { room, ids, states, sockets } = await runningMatch(3);
    // 开局全零分：ids[1]、ids[2] 均自动观察 ids[0]。恶意席位同刻连发 5 帧。
    for (const seq of [1, 2, 3, 4, 5]) {
      room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(seq));
    }
    const st1 = states.get(ids[1]) as WsState;
    // 负例：门控丢弃同窗内的 2..5 帧（快照为最新态语义，无信息损失）。
    expect(remoteSnaps(st1).map((m) => (m.snapshot as { seq: number }).seq)).toEqual([1]);
    // 补发帧不受门控：门控窗口未滑过（仍为 T0），setWatchTarget 仍即时补发最新帧。
    const st2 = states.get(ids[2]) as WsState;
    st2.sent.length = 0;
    expect(room.setWatchTarget(ids[2], ids[0]).ok).toBe(true);
    expect(remoteSnaps(st2).map((m) => (m.snapshot as { seq: number }).seq)).toEqual([5]);
    // 正例：窗口滑过（200ms）后新帧恢复放行。
    vi.advanceTimersByTime(200);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(6));
    expect(remoteSnaps(st1).map((m) => (m.snapshot as { seq: number }).seq)).toEqual([1, 6]);
    expect(remoteSnaps(st2).map((m) => (m.snapshot as { seq: number }).seq)).toEqual([5, 6]);
    // 有界性：门控时戳为 connId 级 Map（≤连接数），随连接终结清理（N25 用例已证）。
    vi.useRealTimers();
  });

  it('N42 背压槽定时器补发：缓冲回落后无新帧也送达槽内最新帧；仍超限则不投递', async () => {
    const { room, ids, states, sockets } = await runningMatch(6);
    const st5 = states.get(ids[5]) as WsState;
    st5.bufferedAmount = 20_000; // 慢观察者：帧入单槽
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    expect(remoteSnaps(st5).length).toBe(0);
    expect(room.pipelineStats().outSlots).toBe(1);
    // 负例：定时器到点但缓冲仍超限 → 不投递（重新入槽等待下一窗口）。
    vi.advanceTimersByTime(500);
    expect(remoteSnaps(st5).length).toBe(0);
    expect(room.pipelineStats().outSlots).toBe(1);
    // 正例：缓冲回落（无新帧到达）→ 定时器到点补发槽内最新帧，槽归零。
    st5.bufferedAmount = 0;
    vi.advanceTimersByTime(500);
    expect(remoteSnaps(st5).map((m) => (m.snapshot as { seq: number }).seq)).toEqual([1]);
    expect(room.pipelineStats().outSlots).toBe(0);
    vi.useRealTimers();
  });
});
