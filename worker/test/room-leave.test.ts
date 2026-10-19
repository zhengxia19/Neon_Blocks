// N12：席位快照、主动退出与房主转让（DO 直测，node:sqlite 桩）。
import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';

function makeRoom() {
  const { ctx } = makeFakeCtx();
  return new RoomDO(ctx as never, {} as never);
}

function req(capacity: number, nickname = 'host1'): CreateRoomRequest {
  return { nickname, capacity, randomMode: 'S1', startLevel: 1 };
}

async function makeLobby(capacity: number) {
  const room = makeRoom();
  const created = await room.createRoom(req(capacity));
  if (!created.claimed) throw new Error('claim failed');
  const guests: string[] = [];
  for (let i = 1; i < capacity; i += 1) {
    const joined = await room.joinRoom(`g${i}`);
    if (!joined.joined) throw new Error('join failed');
    guests.push(joined.playerId);
  }
  return { room, host: created.playerId, guests };
}

function hostsOf(room: RoomDO) {
  return room.getSeats().filter((s) => s.isHost);
}

describe('N12 退出与房主转让正向', () => {
  it('房主退出：新房主唯一且为最小加入序号存活者', async () => {
    const { room, host, guests } = await makeLobby(4);
    const res = room.leaveRoom(host);
    expect(res).toEqual({ left: true, newHostPlayerId: guests[0], roomClosed: false, generation: 1 });
    const seats = room.getSeats();
    expect(seats.length).toBe(3);
    expect(hostsOf(room)).toEqual([
      { playerId: guests[0], nickname: 'g1', isHost: true, joinOrder: 2 },
    ]);
    expect(seats.map((s) => s.joinOrder)).toEqual([2, 3, 4]);
  });

  it('非房主退出：房主不变，退出者席位释放且旧凭据失效', async () => {
    const { room, host, guests } = await makeLobby(3);
    const res = room.leaveRoom(guests[0]);
    expect(res).toEqual({ left: true, newHostPlayerId: null, roomClosed: false, generation: 1 });
    expect(hostsOf(room).map((s) => s.playerId)).toEqual([host]);
    expect(room.getSeats().some((s) => s.playerId === guests[0])).toBe(false);
    expect(room.leaveRoom(guests[0])).toEqual({ left: false, error: 'UNAUTHORIZED' });
  });

  it('房主连续转让：新房主再退出，转让至下一最小序号', async () => {
    const { room, host, guests } = await makeLobby(3);
    room.leaveRoom(host);
    const res = room.leaveRoom(guests[0]);
    expect(res.left).toBe(true);
    if (!res.left) return;
    expect(res.newHostPlayerId).toBe(guests[1]);
    expect(hostsOf(room).map((s) => s.playerId)).toEqual([guests[1]]);
  });

  it('最后一人主动离开：立即关闭业务态，再加入 ROOM_NOT_FOUND，重占代际 +1 且席位清空', async () => {
    const { room, host } = await makeLobby(2);
    room.leaveRoom(host);
    const res = room.leaveRoom((hostsOf(room)[0] ?? { playerId: '' }).playerId);
    expect(res).toEqual({ left: true, newHostPlayerId: null, roomClosed: true, generation: 1 });
    expect(room.getSeats().length).toBe(0);
    expect(await room.joinRoom('later')).toEqual({ joined: false, error: 'ROOM_NOT_FOUND' });
    const again = await room.createRoom(req(2, 'host1'));
    expect(again.claimed).toBe(true);
    if (!again.claimed) return;
    expect(again.generation).toBe(2);
    expect(room.getSeats().length).toBe(1);
  });
});

describe('N12 退出反向', () => {
  it('未知席位 → UNAUTHORIZED 且席位不变', async () => {
    const { room, host } = await makeLobby(3);
    expect(room.leaveRoom('p_nobody')).toEqual({ left: false, error: 'UNAUTHORIZED' });
    expect(room.getSeats().length).toBe(3);
    expect(hostsOf(room).map((s) => s.playerId)).toEqual([host]);
  });

  it('未占用房间退出 → ROOM_NOT_FOUND', () => {
    const room = makeRoom();
    expect(room.leaveRoom('p_any')).toEqual({ left: false, error: 'ROOM_NOT_FOUND' });
  });

  it('不变量：任意退出后房主恒唯一（逐一退出至空）', async () => {
    const { room, host, guests } = await makeLobby(4);
    const order = [host, ...guests];
    for (let i = 0; i < order.length; i += 1) {
      room.leaveRoom(order[i]);
      const remaining = order.length - i - 1;
      expect(hostsOf(room).length).toBe(remaining > 0 ? 1 : 0);
    }
  });
});
