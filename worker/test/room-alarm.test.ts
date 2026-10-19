// N17：600 秒到期闹钟（DO Alarm 唯一权威触发；假时钟 599999/600000ms 边界；
// 持久化 deadline 重建；幂等；心跳不轮询）。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { MATCH_DURATION_MS } from '../../shared/protocol';
import { RoomDO } from '../src/room';
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

/** 假时钟起点：远离真实 epoch，确保 Date.now 全部来自 fake timers。 */
const T0 = 1_700_000_000_000;

async function readyLobby(capacity: number) {
  vi.useFakeTimers({ now: T0 });
  const { ctx, store, accepted, alarmCalls } = makeFakeCtx();
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
    const attached = await room.attachWebSocket(issued.ticket, ws);
    if (!attached.ok) throw new Error('attach failed');
    states.set(id, state);
    sockets.set(id, ws);
  }
  return { room, ctx, sql: store.sql, accepted, alarmCalls, host: created.playerId, guests: ids.slice(1), ids, states, sockets };
}

function parsed(state: WsState): Record<string, unknown>[] {
  return state.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
}

describe('N17 闹钟调度与 600 秒边界', () => {
  it('startGame 排 startAt 闹钟；开赛重排 deadlineAt=startAt+600000', async () => {
    const { room, host, alarmCalls } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    expect(alarmCalls).toEqual([res.match.startAt]);
    room.advanceToRunning(res.match.startAt);
    expect(alarmCalls).toEqual([res.match.startAt, res.match.deadlineAt]);
    expect(res.match.deadlineAt - res.match.startAt).toBe(MATCH_DURATION_MS);
    vi.useRealTimers();
  });

  it('COUNTDOWN 下 alarm 于 startAt-1 不提前推进，重排 startAt', async () => {
    const { room, host, alarmCalls } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    vi.setSystemTime(res.match.startAt - 1);
    await room.alarm();
    expect(room.getLobbyState()?.state).toBe('COUNTDOWN');
    // N20 起闹钟面协调（handleDeadline + ensureGraceAlarm）各重排一次同一最近时刻
    expect(alarmCalls).toEqual([res.match.startAt, res.match.startAt, res.match.startAt]);
    vi.useRealTimers();
  });

  it('alarm 于 startAt 临界推进 RUNNING 并重排 deadline 闹钟', async () => {
    const { room, host, alarmCalls } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    vi.setSystemTime(res.match.startAt);
    await room.alarm();
    expect(room.getLobbyState()?.state).toBe('RUNNING');
    expect(alarmCalls.at(-1)).toBe(res.match.deadlineAt);
    vi.useRealTimers();
  });

  it('599999ms 不结束：RUNNING 保持并重排 deadline；600000ms 结束并广播 match_end', async () => {
    const { room, host, guests, states } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    room.advanceToRunning(res.match.startAt);
    vi.setSystemTime(res.match.startAt + MATCH_DURATION_MS - 1); // 599999ms
    await room.alarm();
    expect(room.getLobbyState()?.state).toBe('RUNNING'); // 599999ms 不结束
    vi.setSystemTime(res.match.startAt + MATCH_DURATION_MS); // 600000ms 临界
    await room.alarm();
    expect(room.getLobbyState()?.state).toBe('FINISHED'); // 600000ms 结束
    for (const id of [host, ...room.getLobbyState()!.seats.map((s) => s.playerId)]) {
      const msgs = parsed(states.get(id) as WsState);
      const end = msgs.find((m) => m.type === 'match_end');
      expect(end).toBeTruthy();
      expect(end).toEqual({
        v: 1,
        type: 'match_end',
        revision: 1,
        matchId: res.match.matchId,
        reason: 'timeout',
        winners: expect.arrayContaining([host]),
        standings: [],
      });
      // 复审 O2：winners 钉死为冻结名单全体（此刻无淘汰面，全员存活并列）。
      expect(((end as { winners: string[] }).winners ?? []).slice().sort()).toEqual(
        [host, ...guests].slice().sort(),
      );
    }
    vi.useRealTimers();
  });

  it('闹钟幂等：到期后重复 alarm 不再广播 match_end、状态保持 FINISHED', async () => {
    const { room, host, states } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    room.advanceToRunning(res.match.startAt);
    vi.setSystemTime(res.match.deadlineAt);
    await room.alarm();
    await room.alarm();
    await room.alarm();
    const msgs = parsed(states.get(host) as WsState).filter((m) => m.type === 'match_end');
    expect(msgs.length).toBe(1); // 三次 alarm 仅一次终局
    expect(room.getLobbyState()?.state).toBe('FINISHED');
    vi.useRealTimers();
  });

  it('RUNNING 中驱逐→重建且已过 600 秒：构造器即刻终局（不依赖闹钟触发与客户端活动）', async () => {
    const { ctx, host, alarmCalls } = await readyLobby(3);
    const room1 = new RoomDO(ctx as never, {} as never);
    const created = room1.getLobbyState();
    expect(created?.state).toBe('LOBBY');
    // 经 readyLobby 的席位直接开局（room1 与 readyLobby 内实例共享同一库与连接）。
    const res = room1.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    room1.advanceToRunning(res.match.startAt);
    vi.setSystemTime(res.match.startAt + MATCH_DURATION_MS); // 已过期
    const room2 = new RoomDO(ctx as never, {} as never); // 模拟驱逐后重建
    expect(room2.getLobbyState()?.state).toBe('FINISHED'); // 离线不延长
    expect(alarmCalls.at(-1)).toBe(res.match.deadlineAt); // 重建无需再排（已终局）
    vi.useRealTimers();
  });

  it('心跳不轮询：ping→pong 不产生任何 setAlarm 调用', async () => {
    const { room, host, sockets, alarmCalls } = await readyLobby(2);
    const res = room.startGame(host);
    if (!res.started) throw new Error(JSON.stringify(res));
    room.advanceToRunning(res.match.startAt);
    const before = alarmCalls.length;
    const ws = sockets.get(host) as WebSocket;
    room.webSocketMessage(ws, JSON.stringify({ v: 1, type: 'ping', seq: 7, clientTime: T0 }));
    expect(alarmCalls.length).toBe(before); // 心跳不触碰闹钟
    vi.useRealTimers();
  });

  it('反向：LOBBY 无 match_state 时 alarm 无操作且不排闹钟', async () => {
    const { room, alarmCalls } = await readyLobby(2);
    expect(alarmCalls.length).toBe(0);
    await room.alarm();
    expect(alarmCalls.length).toBe(0);
    expect(room.getLobbyState()?.state).toBe('LOBBY');
    vi.useRealTimers();
  });
});
