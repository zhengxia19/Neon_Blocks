// N39-a：下一局触发 WS 分派——终局阶段 start = 房主下一局（FINISHED→LOBBY）成功
// 广播 room_state；非房主 NOT_HOST、回到 LOBBY 后 start 恢复常规开局门槛语义。
// （§7.2 C→S 白名单无独立下一局消息，语义由服务端按房间阶段裁决。）
import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest, ErrorMsg, RoomStateMsg, ServerMessage } from '../../shared/protocol';
import { ERROR_CATALOG } from '../../shared/errors';
import { RoomDO } from '../src/room';
import { makeFakeCtx, type FakeHibernatableSocket } from './stubs/sqlite-storage';

interface FakeWsState {
  sent: string[];
  closed: { code: number; reason: string } | null;
  attachment: unknown;
}

function makeFakeWs(): { ws: WebSocket; state: FakeWsState } {
  const state: FakeWsState = { sent: [], closed: null, attachment: null };
  const ws: FakeHibernatableSocket = {
    send: (m: string) => state.sent.push(m),
    close: (code = 1005, reason = '') => {
      state.closed = { code, reason };
    },
    serializeAttachment: (a: unknown) => {
      state.attachment = a;
      return JSON.stringify(a);
    },
    deserializeAttachment: () => state.attachment,
  };
  return { ws: ws as unknown as WebSocket, state };
}

const BASE_REQ: CreateRoomRequest = { nickname: 'host1', capacity: 4, randomMode: 'S1', startLevel: 1 };

async function makeRoom(code = '135790') {
  const { ctx, store } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  const created = await room.createRoom(BASE_REQ, code);
  if (!created.claimed) throw new Error('claim failed');
  return { room, sql: store.sql, hostId: created.playerId, hostToken: created.seatToken };
}

async function attach(room: RoomDO, playerId: string, seatToken: string) {
  const issued = await room.issueTicket(playerId, seatToken);
  if (!issued.issued) throw new Error('issue failed');
  const { ws, state } = makeFakeWs();
  const attached = await room.attachWebSocket(issued.ticket, ws);
  if (!attached.ok) throw new Error('attach failed');
  return { ws, state };
}

function makeSender(room: RoomDO, ws: WebSocket) {
  let seq = 0;
  return (msg: Record<string, unknown>): void => {
    seq += 1;
    room.webSocketMessage(ws, JSON.stringify({ v: 1, seq, ...msg }));
  };
}

function messages(state: FakeWsState): ServerMessage[] {
  return state.sent.map((m) => JSON.parse(m) as ServerMessage);
}

function lastRoomState(state: FakeWsState): RoomStateMsg {
  const list = messages(state).filter((m) => m.type === 'room_state') as RoomStateMsg[];
  return list[list.length - 1];
}

/** 建房→双人连接→WS 准备开局→置 RUNNING→finishGame 终局（match_end 已广播）。 */
async function makeFinishedMatch() {
  const { room, sql, hostId, hostToken } = await makeRoom();
  const host = await attach(room, hostId, hostToken);
  const join = await room.joinRoom('guest2');
  if (!join.joined) throw new Error('join failed');
  const guest = await attach(room, join.playerId, join.seatToken);
  const sendHost = makeSender(room, host.ws);
  const sendGuest = makeSender(room, guest.ws);
  sendHost({ type: 'ready' });
  sendGuest({ type: 'ready' });
  sendHost({ type: 'start' });
  sql.exec("UPDATE room_config SET state = 'RUNNING' WHERE id = 1");
  expect(room.finishGame()).toEqual({ finished: true });
  return { room, sql, host, guest, sendHost, sendGuest, guestId: join.playerId };
}

describe('N39-a 终局阶段 start = 下一局 WS 分派', () => {
  it('正向：终局后房主 start → 全员收到 room_state（LOBBY、matchId 清空、准备清零）', async () => {
    const { room, host, guest, sendHost } = await makeFinishedMatch();
    const before = messages(guest.state).filter((m) => m.type === 'room_state').length;
    sendHost({ type: 'start' });
    const s = lastRoomState(guest.state);
    expect(messages(guest.state).filter((m) => m.type === 'room_state').length).toBe(before + 1);
    expect(s).toMatchObject({ phase: 'LOBBY', matchId: null, startAt: null, deadlineAt: null });
    expect(s.players.every((p) => p.ready === false && p.status === 'lobby')).toBe(true);
    // 全员同一份（同 revision 同内容）。
    const hs = lastRoomState(host.state);
    expect(hs.revision).toBe(s.revision);
    expect(JSON.stringify(hs.players)).toBe(JSON.stringify(s.players));
    expect(room.getLobbyState()?.state).toBe('LOBBY');
    // 下一局可再准备再开局（generation 不变、席位保留）。
    sendHost({ type: 'ready' });
    expect(room.getLobbyState()?.seats.some((seat) => seat.isReady)).toBe(true);
    // 回到 LOBBY 后 start 恢复常规开局门槛（未全员准备 → NOT_READY，非下一局语义）。
    sendHost({ type: 'start' });
    const errs = messages(host.state).filter((m) => m.type === 'error') as ErrorMsg[];
    expect(errs.at(-1)).toMatchObject({ code: 'NOT_READY' });
    expect(room.getLobbyState()?.state).toBe('LOBBY');
  });

  it('反向：终局阶段非房主 start → error NOT_HOST（中文目录），状态保持 FINISHED', async () => {
    const { room, guest, sendGuest } = await makeFinishedMatch();
    sendGuest({ type: 'start' });
    const errs = messages(guest.state).filter((m) => m.type === 'error') as ErrorMsg[];
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatchObject({ code: 'NOT_HOST', retryable: false });
    expect(errs[0].message).toBe(ERROR_CATALOG.NOT_HOST.message);
    expect(room.getLobbyState()?.state).toBe('FINISHED');
  });

  it('反向：终局阶段房主 start 成功后再次 start（已 LOBBY）不会重复清场', async () => {
    const { room, host, sendHost } = await makeFinishedMatch();
    sendHost({ type: 'start' }); // 下一局 → LOBBY
    sendHost({ type: 'ready' });
    sendHost({ type: 'start' }); // LOBBY 未全员准备 → NOT_READY，准备状态不被再清
    expect(room.getLobbyState()?.seats.some((seat) => seat.isReady)).toBe(true);
    expect(room.getLobbyState()?.state).toBe('LOBBY');
    expect(messages(host.state).filter((m) => m.type === 'error').length).toBe(1);
  });
});
