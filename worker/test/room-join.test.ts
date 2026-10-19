// N11：RoomDO.joinRoom 直测（node:sqlite 适配 SqlStorage，见 stubs/sqlite-storage.ts）。
import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';

function makeRoom() {
  const { ctx, store } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  return { room, store };
}

function req(capacity: number, nickname = 'host1'): CreateRoomRequest {
  return { nickname, capacity, randomMode: 'S1', startLevel: 1 };
}

describe('N11 joinRoom 正向', () => {
  it('大厅加入成功：joinOrder/令牌/代际/配置回传', async () => {
    const { room } = makeRoom();
    const created = await room.createRoom({
      nickname: 'host1',
      capacity: 3,
      randomMode: 'S3',
      startLevel: 5,
      customSeed: 'seed42',
    });
    expect(created.claimed).toBe(true);
    if (!created.claimed) return;
    const joined = await room.joinRoom('guestA');
    expect(joined.joined).toBe(true);
    if (!joined.joined) return;
    expect(joined.joinOrder).toBe(2);
    expect(joined.generation).toBe(created.generation);
    expect(joined.seatToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(joined.playerId).not.toBe(created.playerId);
    expect(joined.settings).toEqual({
      capacity: 3,
      randomMode: 'S3',
      startLevel: 5,
      customSeed: 'seed42',
    });
  });

  it('容量 2–6 逐一：加入至满员全成功，满员后拒绝', async () => {
    for (let capacity = 2; capacity <= 6; capacity += 1) {
      const { room } = makeRoom();
      const created = await room.createRoom(req(capacity));
      expect(created.claimed).toBe(true);
      for (let i = 1; i < capacity; i += 1) {
        const joined = await room.joinRoom(`g${i}`);
        expect(joined.joined).toBe(true);
        if (joined.joined) expect(joined.joinOrder).toBe(i + 1);
      }
      const full = await room.joinRoom('overflow');
      expect(full).toEqual({ joined: false, error: 'ROOM_FULL' });
    }
  });

  it('并发抢最后席位：两个 joinRoom 交错只有一人成功（清单 N11 验收）', async () => {
    const { room } = makeRoom();
    await room.createRoom(req(2));
    const results = await Promise.all([room.joinRoom('racerX'), room.joinRoom('racerY')]);
    const wins = results.filter((r) => r.joined);
    expect(wins.length).toBe(1);
    const loss = results.find((r) => !r.joined);
    expect(loss).toEqual({ joined: false, error: 'ROOM_FULL' });
  });
});

describe('N11 joinRoom 反向', () => {
  it('昵称大小写不敏感冲突 → NAME_TAKEN；不同名允许', async () => {
    const { room } = makeRoom();
    await room.createRoom(req(4, 'ABc'));
    expect(await room.joinRoom('abc')).toEqual({ joined: false, error: 'NAME_TAKEN' });
    expect(await room.joinRoom('Abc9')).toEqual(
      expect.objectContaining({ joined: true }),
    );
  });

  it('未占用/已释放房间 → ROOM_NOT_FOUND', async () => {
    const { room } = makeRoom();
    expect(await room.joinRoom('lonely')).toEqual({ joined: false, error: 'ROOM_NOT_FOUND' });
    const created = await room.createRoom(req(2));
    expect(created.claimed).toBe(true);
    room.release();
    expect(await room.joinRoom('after')).toEqual({ joined: false, error: 'ROOM_NOT_FOUND' });
  });

  it('非大厅状态（已开赛）加入 → GAME_STARTED', async () => {
    const { room, store } = makeRoom();
    await room.createRoom(req(3));
    store.db.prepare("UPDATE room_config SET state = 'RUNNING' WHERE id = 1").run();
    expect(await room.joinRoom('late')).toEqual({ joined: false, error: 'GAME_STARTED' });
  });

  it('复用码不继承旧席位：释放再创建后旧昵称可再用，代际 +1', async () => {
    const { room } = makeRoom();
    const first = await room.createRoom(req(3, 'host1'));
    const guest = await room.joinRoom('guestZ');
    expect(guest.joined).toBe(true);
    room.release();
    const second = await room.createRoom(req(3, 'host1'));
    expect(second.claimed).toBe(true);
    if (!first.claimed || !second.claimed) return;
    expect(second.generation).toBe(first.generation + 1);
    const again = await room.joinRoom('guestZ');
    expect(again.joined).toBe(true);
  });
});
