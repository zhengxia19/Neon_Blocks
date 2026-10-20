// N33：等待大厅服务端接线——room_state/player_joined 广播、ready/settings_update/
// start/leave 的 WS 分派与中文 error 回复（房主权限、准备门槛、开局锁定）。
import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest, RoomStateMsg, ServerMessage } from '../../shared/protocol';
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

const BASE_REQ: CreateRoomRequest = {
  nickname: 'host1',
  capacity: 4,
  randomMode: 'S1',
  startLevel: 1,
};

async function makeRoom(code = '246810') {
  const { ctx, store, accepted } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  const created = await room.createRoom(BASE_REQ, code);
  if (!created.claimed) throw new Error('claim failed');
  return { room, ctx, store, accepted, hostId: created.playerId, hostToken: created.seatToken };
}

/** 换发票据并接管连接（首帧 room_state 计入 state.sent[0]）。 */
async function attach(room: RoomDO, playerId: string, seatToken: string) {
  const issued = await room.issueTicket(playerId, seatToken);
  if (!issued.issued) throw new Error('issue failed');
  const { ws, state } = makeFakeWs();
  const attached = await room.attachWebSocket(issued.ticket, ws);
  if (!attached.ok) throw new Error('attach failed');
  return { ws, state };
}

/** 每连接 seq 严格单调的协议信封发送。 */
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

function roomStates(state: FakeWsState): RoomStateMsg[] {
  return messages(state).filter((m) => m.type === 'room_state') as RoomStateMsg[];
}

describe('N33 大厅 room_state 广播', () => {
  it('正向：连接建立即收首帧 room_state（LOBBY、房间码、房主席位视图）', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const { state } = await attach(room, hostId, hostToken);
    const states = roomStates(state);
    expect(states.length).toBe(1);
    const s = states[0];
    expect(s).toMatchObject({
      v: 1,
      type: 'room_state',
      phase: 'LOBBY',
      roomCode: '246810',
      roomGeneration: 1,
      settings: { capacity: 4, randomMode: 'S1', startLevel: 1 },
      matchId: null,
      startAt: null,
      deadlineAt: null,
    });
    expect(s.players).toEqual([
      {
        playerId: hostId,
        nickname: 'host1',
        seatIndex: 1,
        isHost: true,
        ready: false,
        status: 'lobby',
        score: 0,
        lines: 0,
        level: 1,
      },
    ]);
    expect(typeof s.serverTime).toBe('number');
    expect(typeof s.revision).toBe('number');
  });

  it('正向：ready → 全员收到 room_state（ready=true、status=ready、revision 递增）', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    const before = roomStates(host.state).length;
    makeSender(room, guest.ws)({ type: 'ready' });
    const hostStates = roomStates(host.state);
    const guestStates = roomStates(guest.state);
    expect(hostStates.length).toBe(before + 1);
    const s = hostStates[hostStates.length - 1];
    const guestView = s.players.find((p) => p.nickname === 'guest2');
    expect(guestView).toMatchObject({ ready: true, status: 'ready' });
    // 同一广播批次全员同 revision ⇒ 内容一致。
    expect(guestStates[guestStates.length - 1].revision).toBe(s.revision);
    expect(JSON.stringify(guestStates[guestStates.length - 1].players)).toBe(JSON.stringify(s.players));
    expect(s.revision).toBeGreaterThan(roomStates(guest.state)[0].revision);
  });

  it('正向：房主 settings_update → room_state 更新且全员准备清零', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    const sendHost = makeSender(room, host.ws);
    const sendGuest = makeSender(room, guest.ws);
    sendHost({ type: 'ready' });
    sendGuest({ type: 'ready' });
    sendHost({ type: 'settings_update', capacity: 6, randomMode: 'S3', customSeed: 'abc123', startLevel: 5 });
    const s = roomStates(host.state).at(-1) as RoomStateMsg;
    expect(s.settings).toEqual({ capacity: 6, randomMode: 'S3', customSeed: 'abc123', startLevel: 5 });
    expect(s.players.every((p) => p.ready === false && p.status === 'lobby')).toBe(true);
    // 反向：非法等级（11 > MAX_START_LEVEL）信封层拒绝 BAD_LEVEL，配置不变。
    sendHost({ type: 'settings_update', capacity: 6, randomMode: 'S3', customSeed: 'abc123', startLevel: 11 });
    const errs = messages(host.state).filter((m) => m.type === 'error');
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatchObject({ code: 'BAD_LEVEL', retryable: false });
    expect(room.getLobbyState()!.settings.startLevel).toBe(5);
    // 反向：容量低于在场席位 → error CAPACITY_BELOW_SEATS（服务端裁决）。
    const join3 = await room.joinRoom('guest3');
    if (!join3.joined) throw new Error('join failed');
    sendHost({ type: 'settings_update', capacity: 2, randomMode: 'S3', customSeed: 'abc123', startLevel: 5 });
    const errs2 = messages(host.state).filter((m) => m.type === 'error');
    expect(errs2[1]).toMatchObject({ code: 'CAPACITY_BELOW_SEATS', retryable: false });
    expect(room.getLobbyState()!.settings.capacity).toBe(6);
  });

  it('反向：非房主 settings_update → error NOT_HOST，配置不变', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    makeSender(room, guest.ws)({ type: 'settings_update', capacity: 6, randomMode: 'S1', startLevel: 1 });
    const errs = messages(guest.state).filter((m) => m.type === 'error');
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatchObject({ code: 'NOT_HOST', message: '只有房主可以执行该操作。' });
    expect(room.getLobbyState()!.settings.capacity).toBe(4);
    // 房主侧无多余 room_state（attach 首帧广播 + guest attach 广播 + join 广播）。
    expect(roomStates(host.state).length).toBe(3);
  });

  it('反向：开局门槛——人数不足/未全准备/非房主均回 error（中文目录）', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const sendHost = makeSender(room, host.ws);
    // 仅房主 1 人：人数不足。
    sendHost({ type: 'start' });
    // 加入第二人但无人准备。
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    sendHost({ type: 'start' });
    // 非房主开局。
    makeSender(room, guest.ws)({ type: 'start' });
    const hostErrs = messages(host.state)
      .filter((m) => m.type === 'error')
      .map((m) => (m as { code: string }).code);
    expect(hostErrs).toEqual(['NOT_ENOUGH_PLAYERS', 'NOT_READY']);
    const guestErrs = messages(guest.state).filter((m) => m.type === 'error');
    expect(guestErrs[0]).toMatchObject({ code: 'NOT_HOST' });
    expect(room.getLobbyState()!.state).toBe('LOBBY');
  });

  it('正向：HTTP joinRoom → 已连接席位收 player_joined + room_state', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const msgs = messages(host.state);
    expect(msgs.map((m) => m.type)).toEqual(['room_state', 'player_joined', 'room_state']);
    const joined = msgs[1] as Extract<ServerMessage, { type: 'player_joined' }>;
    expect(joined.player).toMatchObject({
      playerId: join.playerId,
      nickname: 'guest2',
      seatIndex: 2,
      isHost: false,
      ready: false,
      status: 'lobby',
    });
    const s = msgs[2] as RoomStateMsg;
    expect(s.players.map((p) => p.nickname)).toEqual(['host1', 'guest2']);
  });

  it('正向：leave → player_left + room_state；房主退出转让房主', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    const sendHost = makeSender(room, host.ws);
    sendHost({ type: 'leave' });
    const guestMsgs = messages(guest.state);
    const left = guestMsgs.find((m) => m.type === 'player_left') as { playerId: string; reason: string };
    expect(left).toMatchObject({ playerId: hostId, reason: 'left' });
    const s = roomStates(guest.state).at(-1) as RoomStateMsg;
    expect(s.players.length).toBe(1);
    expect(s.players[0]).toMatchObject({ nickname: 'guest2', isHost: true });
    // 反向：离开者席位已删除，旧连接再发 ready → error UNAUTHORIZED。
    sendHost({ type: 'ready' });
    const errs = messages(host.state).filter((m) => m.type === 'error');
    expect(errs[0]).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('正向：最后一人 leave → 房间关闭，不再广播 room_state', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    makeSender(room, host.ws)({ type: 'leave' });
    const types = messages(host.state).map((m) => m.type);
    expect(types).toEqual(['room_state', 'player_left']);
    expect(room.getLobbyState()).toBeNull();
  });

  it('正向：断线 → 剩余连接收 room_state（status=disconnected）', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    room.webSocketClose(guest.ws, 1006, '', false);
    const s = roomStates(host.state).at(-1) as RoomStateMsg;
    const guestView = s.players.find((p) => p.nickname === 'guest2');
    expect(guestView).toMatchObject({ status: 'disconnected' });
  });

  it('正向：重连接管 → 其他席位即时收到 room_state 刷新（复审 P2：清除 disconnected 标记广播）', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    room.webSocketClose(guest.ws, 1006, '', false);
    const before = roomStates(host.state).length;
    const re = await attach(room, join.playerId, join.seatToken);
    // 其他席位收到刷新广播，且 guest 标记已从 disconnected 恢复。
    expect(roomStates(host.state).length).toBe(before + 1);
    const s = roomStates(host.state).at(-1) as RoomStateMsg;
    expect(s.players.find((p) => p.nickname === 'guest2')).toMatchObject({ status: 'lobby' });
    // 重连者自身同样经广播收到首帧（单帧，不重复）。
    expect(roomStates(re.state).length).toBe(1);
  });

  it('反向：开赛后 settings_update → error GAME_STARTED（参数锁定）', async () => {
    const { room, hostId, hostToken } = await makeRoom();
    const host = await attach(room, hostId, hostToken);
    const join = await room.joinRoom('guest2');
    if (!join.joined) throw new Error('join failed');
    const guest = await attach(room, join.playerId, join.seatToken);
    const sendHost = makeSender(room, host.ws);
    sendHost({ type: 'ready' });
    makeSender(room, guest.ws)({ type: 'ready' });
    sendHost({ type: 'start' });
    expect(room.getLobbyState()!.state).toBe('COUNTDOWN');
    sendHost({ type: 'settings_update', capacity: 4, randomMode: 'S1', startLevel: 1 });
    const errs = messages(host.state).filter((m) => m.type === 'error');
    expect(errs[0]).toMatchObject({ code: 'GAME_STARTED', retryable: false });
  });
});
