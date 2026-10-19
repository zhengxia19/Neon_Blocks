// N20：断线宽限与单席位重连（29.999s 可恢复、30s 超限淘汰参赛者、旧 socket
// 替换不互伤、席位数据存续、联网比赛不停表、与 30 分钟清理互不混同）。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx, type FakeHibernatableSocket } from './stubs/sqlite-storage';

interface WsState {
  sent: string[];
  attachment: unknown;
  closed: { code?: number } | null;
}

function makeFakeWs(): { ws: WebSocket; state: WsState } {
  const state: WsState = { sent: [], attachment: null, closed: null };
  const ws: FakeHibernatableSocket = {
    send: (m: string) => state.sent.push(m),
    close: (code?: number) => {
      state.closed = { code };
    },
    serializeAttachment: (a: unknown) => {
      state.attachment = a;
      return JSON.stringify(a);
    },
    deserializeAttachment: () => state.attachment,
  };
  return { ws: ws as unknown as WebSocket, state };
}

const T0 = 1_700_000_000_000;

/** 就绪大厅 → 开局；phase=RUNNING 时推进到开赛。返回房间、库、席位与连接对象。 */
async function startedMatch(capacity: number, phase: 'COUNTDOWN' | 'RUNNING') {
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
  const sockets = new Map<string, WebSocket>();
  const states = new Map<string, WsState>();
  for (const id of ids) {
    const { ws, state } = makeFakeWs();
    const issued = await room.issueTicket(id, tokens.get(id) as string);
    if (!issued.issued) throw new Error('ticket failed');
    await room.attachWebSocket(issued.ticket, ws);
    sockets.set(id, ws);
    states.set(id, state);
  }
  const res = room.startGame(created.playerId);
  if (!res.started) throw new Error(JSON.stringify(res));
  if (phase === 'RUNNING') room.advanceToRunning(res.match.startAt);
  return {
    room,
    ctx,
    store,
    sql: store.sql,
    alarmCalls,
    tokens,
    host: created.playerId,
    ids,
    sockets,
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
  return [
    ...sql.exec('SELECT player_id, eliminated_at FROM eliminations ORDER BY eliminated_at ASC'),
  ].map((r) => ({
    player_id: String((r as { player_id: unknown }).player_id),
    eliminated_at: Number((r as { eliminated_at: unknown }).eliminated_at),
  }));
}

function disconnectedAtOf(room: RoomDO, playerId: string): number | null | undefined {
  const seat = room.getLobbyState()?.seats.find((s) => s.playerId === playerId);
  return seat?.disconnectedAt;
}

describe('N20 断线宽限与单席位重连', () => {
  it('RUNNING 断线：记录服务端断线时刻并把闹钟提前到宽限到期（早于 deadline）', async () => {
    const m = await startedMatch(4, 'RUNNING');
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    expect(disconnectedAtOf(m.room, m.ids[1])).toBe(T0);
    expect(m.alarmCalls.at(-1)).toBe(T0 + 30_000); // 宽限闹钟早于 deadline，取更早者
    vi.useRealTimers();
  });

  it('29.999 秒可恢复：闹钟无淘汰，重连清空标记后 30 秒整也不淘汰', async () => {
    const m = await startedMatch(3, 'RUNNING');
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    vi.setSystemTime(T0 + 29_999);
    await m.room.alarm();
    expect(elimRows(m.sql)).toEqual([]);
    // 重连（刷新流程：换发新票据 + 新 socket 接管）
    const issued = await m.room.issueTicket(m.ids[1], m.tokens.get(m.ids[1]) as string);
    if (!issued.issued) throw new Error('ticket failed');
    const second = makeFakeWs();
    expect((await m.room.attachWebSocket(issued.ticket, second.ws)).ok).toBe(true);
    expect(disconnectedAtOf(m.room, m.ids[1])).toBeNull();
    vi.setSystemTime(T0 + 30_000);
    await m.room.alarm();
    expect(elimRows(m.sql)).toEqual([]); // 已恢复：宽限闹钟空转（幂等）
    vi.useRealTimers();
  });

  it('30 秒超限：参赛者按服务端时刻淘汰并广播 grace_expired；席位数据存续', async () => {
    const m = await startedMatch(4, 'RUNNING');
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    vi.setSystemTime(T0 + 30_000);
    await m.room.alarm();
    expect(elimRows(m.sql)).toEqual([{ player_id: m.ids[1], eliminated_at: T0 + 30_000 }]);
    // 其余 3 席位各收到一次（断线席位在假 accepted 中仍收一份，真实 Hibernation 会移除）
    for (const id of [m.host, m.ids[2], m.ids[3]]) {
      const mine = parsed(m.states.get(id) as WsState).filter(
        (x) => x.type === 'player_left' && x.reason === 'grace_expired',
      );
      expect(mine).toEqual([
        { v: 1, type: 'player_left', revision: 1, playerId: m.ids[1], reason: 'grace_expired' },
      ]);
    }
    // 席位存续（≠30 分钟房间清理）：房间仍占用、席位仍在、断线标记保留。
    const lobby = m.room.getLobbyState();
    expect(lobby?.seats.length).toBe(4);
    expect(disconnectedAtOf(m.room, m.ids[1])).toBe(T0);
    vi.useRealTimers();
  });

  it('重复宽限到期闹钟幂等：单次淘汰入账、单次广播', async () => {
    const m = await startedMatch(3, 'RUNNING');
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    vi.setSystemTime(T0 + 30_000);
    await m.room.alarm();
    await m.room.alarm();
    expect(elimRows(m.sql).length).toBe(1);
    const mine = parsed(m.states.get(m.host) as WsState).filter(
      (x) => x.type === 'player_left' && x.reason === 'grace_expired',
    );
    expect(mine.length).toBe(1); // 双闹钟只广播一次
    vi.useRealTimers();
  });

  it('旧 socket 替换：新连接接管关闭旧 socket，旧 close 事件不误伤新声明', async () => {
    const m = await startedMatch(3, 'RUNNING');
    const oldWs = m.sockets.get(m.ids[1]) as WebSocket;
    const issued = await m.room.issueTicket(m.ids[1], m.tokens.get(m.ids[1]) as string);
    if (!issued.issued) throw new Error('ticket failed');
    const second = makeFakeWs();
    expect((await m.room.attachWebSocket(issued.ticket, second.ws)).ok).toBe(true);
    expect(m.states.get(m.ids[1])?.closed?.code).toBe(4003); // 旧 socket 被替换关闭
    // 旧 socket 的迟到 close 事件（conn_id 核验）：不标记断线、不释放新声明
    m.room.webSocketClose(oldWs, 1006, '', false);
    expect(disconnectedAtOf(m.room, m.ids[1])).toBeNull();
    const rows = [...m.sql.exec('SELECT conn_id FROM seat_conns WHERE player_id = ?', m.ids[1])];
    expect(rows.length).toBe(1); // 新声明仍在
    // 新 socket 真断线才标记
    m.room.webSocketClose(second.ws, 1006, '', false);
    expect(disconnectedAtOf(m.room, m.ids[1])).toBe(T0);
    vi.useRealTimers();
  });

  it('刷新不增加新玩家：断线后凭原令牌重连，席位数与身份不变', async () => {
    const m = await startedMatch(3, 'RUNNING');
    m.room.webSocketClose(m.sockets.get(m.ids[2]) as WebSocket, 1006, '', false);
    const issued = await m.room.issueTicket(m.ids[2], m.tokens.get(m.ids[2]) as string);
    if (!issued.issued) throw new Error('ticket failed');
    const res = await m.room.attachWebSocket(issued.ticket, makeFakeWs().ws);
    expect(res.ok && res.playerId).toBe(m.ids[2]);
    expect(m.room.getLobbyState()?.seats.length).toBe(3);
    expect(m.room.getLobbyState()?.seats.map((s) => s.playerId)).toEqual(m.ids);
    vi.useRealTimers();
  });

  it('LOBBY 非参赛者断线：不排宽限闹钟、不淘汰，席位存续', async () => {
    vi.useFakeTimers({ now: T0 });
    const f = makeFakeCtx();
    const r = new RoomDO(f.ctx as never, {} as never);
    const c = await r.createRoom({ nickname: 'h', capacity: 2, randomMode: 'S1', startLevel: 1 });
    if (!c.claimed) throw new Error('claim');
    const { ws } = makeFakeWs();
    const t = await r.issueTicket(c.playerId, c.seatToken);
    if (!t.issued) throw new Error('ticket');
    await r.attachWebSocket(t.ticket, ws);
    r.webSocketClose(ws, 1006, '', false);
    await r.alarm();
    expect(f.alarmCalls).toEqual([]); // LOBBY 无闹钟（非参赛者不排宽限）
    expect(r.getLobbyState()?.seats.length).toBe(1); // 席位存续至到期/离开（N21 清理）
    vi.useRealTimers();
  });

  it('不停表：断线不改变 deadline，超时终局存活者含断线未超宽限者', async () => {
    const m = await startedMatch(3, 'RUNNING');
    vi.setSystemTime(m.deadlineAt - 1000);
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    expect(m.alarmCalls.at(-1)).toBe(m.deadlineAt); // 宽限闹钟更晚 → 不覆盖 deadline
    vi.setSystemTime(m.deadlineAt);
    await m.room.alarm();
    expect(m.room.getLobbyState()?.state).toBe('FINISHED');
    expect(elimRows(m.sql)).toEqual([]); // 未超宽限：不淘汰
    const end = parsed(m.states.get(m.host) as WsState).find((x) => x.type === 'match_end');
    expect(end?.reason).toBe('timeout');
    expect((end?.winners as string[]).slice().sort()).toEqual(m.ids.slice().sort());
    vi.useRealTimers();
  });

  it('COUNTDOWN 断线链：startAt 先开赛，宽限到期时刻再裁决淘汰', async () => {
    const m = await startedMatch(3, 'COUNTDOWN');
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    expect(m.alarmCalls.at(-1)).toBe(m.startAt); // startAt 更早 → 不被宽限闹钟覆盖
    vi.setSystemTime(m.startAt);
    await m.room.alarm(); // → RUNNING + 重排；宽限未到 → 排宽限闹钟
    expect(m.room.getLobbyState()?.state).toBe('RUNNING');
    expect(m.alarmCalls.at(-1)).toBe(T0 + 30_000);
    vi.setSystemTime(T0 + 30_000);
    await m.room.alarm();
    expect(elimRows(m.sql)).toEqual([{ player_id: m.ids[1], eliminated_at: T0 + 30_000 }]);
    vi.useRealTimers();
  });

  it('驱逐重建：断线超宽限在构造期即刻淘汰（闹钟丢失也权威）', async () => {
    const m = await startedMatch(3, 'RUNNING');
    m.room.webSocketClose(m.sockets.get(m.ids[1]) as WebSocket, 1006, '', false);
    vi.setSystemTime(T0 + 30_001);
    const revived = new RoomDO(
      {
        storage: { sql: m.sql, setAlarm: () => {}, getAlarm: () => undefined, deleteAlarm: () => {} },
        acceptWebSocket: () => {},
        getWebSockets: () => [],
      } as never,
      {} as never,
    );
    void revived;
    expect(elimRows(m.sql)).toEqual([{ player_id: m.ids[1], eliminated_at: T0 + 30_001 }]);
    vi.useRealTimers();
  });
});
