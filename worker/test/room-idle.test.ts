// N21：房间空置与到期清理（全员主动离开立即释放；全员意外断开记录空置起点、
// 最迟 30 分钟释放；29 分 59 秒业务记录仍在但不复活已淘汰比赛；重连取消空置；
// 倒计时/比赛/宽限闹钟不被空房闹钟覆盖；取消后旧 token 无效）。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { DISCONNECT_GRACE_MS, EMPTY_ROOM_TTL_MS } from '../../shared/protocol';
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

/** 就绪大厅（全员已挂 Hibernation 连接）。 */
async function readyLobby(capacity: number) {
  vi.useFakeTimers({ now: T0 });
  const { ctx, store, accepted, alarmCalls, deleteCalls, getAlarmAt } = makeFakeCtx();
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
  return {
    room,
    ctx,
    store,
    sql: store.sql,
    accepted,
    alarmCalls,
    deleteCalls,
    getAlarmAt,
    tokens,
    host: created.playerId,
    ids,
    sockets,
    states,
  };
}

/** 就绪大厅 → 开局；phase=RUNNING 时推进到开赛。 */
async function startedMatch(capacity: number, phase: 'COUNTDOWN' | 'RUNNING') {
  const m = await readyLobby(capacity);
  const res = m.room.startGame(m.host);
  if (!res.started) throw new Error(JSON.stringify(res));
  if (phase === 'RUNNING') m.room.advanceToRunning(res.match.startAt);
  return {
    ...m,
    matchId: res.match.matchId,
    startAt: res.match.startAt,
    deadlineAt: res.match.deadlineAt,
  };
}

/** 意外断开模拟：平台先把 socket 移出 Hibernation 登记，再触发 DO close 事件。 */
function dropSocket(room: RoomDO, ws: WebSocket): void {
  (ws as unknown as FakeHibernatableSocket).close(1006);
  room.webSocketClose(ws, 1006, '', false);
}

function idleSince(sql: ReturnType<typeof makeFakeCtx>['store']['sql']): number | null {
  const row = sql.exec('SELECT idle_since FROM room_meta WHERE id = 1').one() as {
    idle_since: unknown;
  };
  return row.idle_since === null || row.idle_since === undefined ? null : Number(row.idle_since);
}

function countRows(sql: ReturnType<typeof makeFakeCtx>['store']['sql'], table: string): number {
  const row = sql.exec(`SELECT COUNT(*) AS c FROM ${table}`).one() as { c: unknown };
  return Number(row.c);
}

describe('N21 全员主动离开：立即释放', () => {
  it('最后一人离开即清空业务数据、取消闹钟，旧席位令牌失效', async () => {
    const m = await readyLobby(2);
    const guest = m.ids[1] as string;
    const r1 = m.room.leaveRoom(m.host); // 房主离开 → 转让
    if (!r1.left) throw new Error(JSON.stringify(r1));
    expect(r1.roomClosed).toBe(false);
    const r2 = m.room.leaveRoom(guest); // 最后一人离开 → 立即释放
    if (!r2.left) throw new Error(JSON.stringify(r2));
    expect(r2.roomClosed).toBe(true);
    expect(m.room.getLobbyState()).toBeNull();
    expect(countRows(m.sql, 'seats')).toBe(0);
    expect(countRows(m.sql, 'room_config')).toBe(0);
    expect(countRows(m.sql, 'seat_conns')).toBe(0);
    expect(m.deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(m.getAlarmAt()).toBeUndefined();
    const t = await m.room.issueTicket(guest, m.tokens.get(guest) as string);
    expect(t.issued).toBe(false);
    if (!t.issued) expect(t.error).toBe('ROOM_NOT_FOUND'); // 旧 token 无效
  });
});

describe('N21 全员意外断开：空置起点与 30 分钟到期清理', () => {
  it('LOBBY 全员断开：记录空置起点并排 30 分钟空房闹钟', async () => {
    const m = await readyLobby(2);
    for (const id of m.ids) dropSocket(m.room, m.sockets.get(id) as WebSocket);
    expect(idleSince(m.sql)).toBe(T0);
    expect(m.alarmCalls.at(-1)).toBe(T0 + EMPTY_ROOM_TTL_MS);
  });

  it('无人 29 分 59 秒业务记录仍在；30 分钟整清理业务数据且旧 token 无效', async () => {
    const m = await readyLobby(2);
    for (const id of m.ids) dropSocket(m.room, m.sockets.get(id) as WebSocket);
    vi.setSystemTime(T0 + EMPTY_ROOM_TTL_MS - 1); // 29:59
    await m.room.alarm();
    expect(m.room.getLobbyState()).not.toBeNull();
    expect(countRows(m.sql, 'seats')).toBe(2);
    expect(m.alarmCalls.at(-1)).toBe(T0 + EMPTY_ROOM_TTL_MS); // 重排同一最近时刻
    vi.setSystemTime(T0 + EMPTY_ROOM_TTL_MS); // 30:00 整
    await m.room.alarm();
    expect(m.room.getLobbyState()).toBeNull();
    expect(countRows(m.sql, 'seats')).toBe(0);
    expect(countRows(m.sql, 'room_config')).toBe(0);
    expect(countRows(m.sql, 'match_roster')).toBe(0);
    const t = await m.room.issueTicket(m.ids[1] as string, m.tokens.get(m.ids[1] as string) as string);
    expect(t.issued).toBe(false);
    if (!t.issued) expect(t.error).toBe('ROOM_NOT_FOUND');
  });

  it('30 分钟内重连取消空置：到期闹钟触发不释放房间', async () => {
    const m = await readyLobby(2);
    for (const id of m.ids) dropSocket(m.room, m.sockets.get(id) as WebSocket);
    expect(idleSince(m.sql)).toBe(T0);
    const guest = m.ids[1] as string;
    const issued = await m.room.issueTicket(guest, m.tokens.get(guest) as string);
    if (!issued.issued) throw new Error('ticket failed');
    const { ws } = makeFakeWs();
    const attached = await m.room.attachWebSocket(issued.ticket, ws);
    expect(attached.ok).toBe(true);
    expect(idleSince(m.sql)).toBeNull(); // 活动连接恢复即清空空置起点
    vi.setSystemTime(T0 + EMPTY_ROOM_TTL_MS);
    await m.room.alarm();
    expect(m.room.getLobbyState()).not.toBeNull();
    expect(countRows(m.sql, 'seats')).toBe(2);
  });

  it('RUNNING 全员断开：宽限闹钟优先不被空房闹钟覆盖；终局后空房闹钟接管；29:59 不复活比赛', async () => {
    const m = await startedMatch(2, 'RUNNING');
    for (const id of m.ids) dropSocket(m.room, m.sockets.get(id) as WebSocket);
    // 最近候选是 30 秒宽限（非 30 分钟空房）：deadline/宽限闹钟不被覆盖。
    expect(m.alarmCalls.at(-1)).toBe(T0 + DISCONNECT_GRACE_MS);
    vi.setSystemTime(T0 + DISCONNECT_GRACE_MS);
    await m.room.alarm(); // 全员宽限淘汰 → 提前终局（0 存活并列）
    const elim = [...m.sql.exec('SELECT player_id FROM eliminations')];
    expect(elim.length).toBe(2);
    expect(m.room.getLobbyState()?.state).toBe('FINISHED');
    expect(m.alarmCalls.at(-1)).toBe(T0 + EMPTY_ROOM_TTL_MS); // 空房闹钟接管
    vi.setSystemTime(T0 + EMPTY_ROOM_TTL_MS - 1);
    await m.room.alarm();
    expect(m.room.getLobbyState()).not.toBeNull(); // 29:59 业务记录仍在
    const rep = m.room.reportEliminations([m.host], m.matchId);
    expect(rep.ok).toBe(false);
    if (!rep.ok) expect(rep.error).toBe('BAD_STATE'); // 超 30 秒者不可复活比赛
    vi.setSystemTime(T0 + EMPTY_ROOM_TTL_MS);
    await m.room.alarm();
    expect(m.room.getLobbyState()).toBeNull(); // 30 分钟到期清理
  });

  it('倒计时闹钟不被空房闹钟覆盖；开赛→宽限→空房闹钟逐级接管', async () => {
    const m = await startedMatch(2, 'COUNTDOWN');
    for (const id of m.ids) dropSocket(m.room, m.sockets.get(id) as WebSocket);
    expect(m.alarmCalls.at(-1)).toBe(m.startAt); // 最近候选仍是 startAt
    expect(m.alarmCalls).not.toContain(T0 + EMPTY_ROOM_TTL_MS); // 空房闹钟未挤占
    vi.setSystemTime(m.startAt);
    await m.room.alarm(); // COUNTDOWN→RUNNING；宽限成为最近候选
    expect(m.alarmCalls.at(-1)).toBe(T0 + DISCONNECT_GRACE_MS);
    vi.setSystemTime(T0 + DISCONNECT_GRACE_MS);
    await m.room.alarm(); // 宽限淘汰全员 → 终局 → 空房闹钟接管
    expect(m.alarmCalls.at(-1)).toBe(T0 + EMPTY_ROOM_TTL_MS);
  });

  it('驱逐重建：空置已到期则构造器即刻释放业务数据', async () => {
    const m = await readyLobby(2);
    for (const id of m.ids) dropSocket(m.room, m.sockets.get(id) as WebSocket);
    vi.setSystemTime(T0 + EMPTY_ROOM_TTL_MS + 1);
    new RoomDO(m.ctx as never, {} as never); // 重建即核验（闹钟可能随驱逐丢失）
    expect(m.room.getLobbyState()).toBeNull();
    expect(countRows(m.sql, 'seats')).toBe(0);
  });

  it('反向：多席位仅一人断开不记空置、不排空房闹钟', async () => {
    const m = await readyLobby(3);
    dropSocket(m.room, m.sockets.get(m.ids[1] as string) as WebSocket);
    expect(idleSince(m.sql)).toBeNull();
    expect(m.alarmCalls).not.toContain(T0 + EMPTY_ROOM_TTL_MS);
  });
});

describe('N21 提前终局取消残留闹钟（N18 复审 O1）', () => {
  it('淘汰触发提前终局后 deleteAlarm 取消残留 deadline 闹钟', async () => {
    const m = await startedMatch(2, 'RUNNING');
    expect(m.getAlarmAt()).toBe(m.deadlineAt); // startGame/开赛已排 deadline
    const rep = m.room.reportEliminations([m.ids[1] as string], m.matchId);
    if (!rep.ok) throw new Error(JSON.stringify(rep));
    expect(rep.matchEnded).toBe(true);
    expect(m.deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(m.getAlarmAt()).toBeUndefined(); // 无残留待触发闹钟
  });
});
