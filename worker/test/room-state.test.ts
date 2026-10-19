// N15：会话状态机（LOBBY→COUNTDOWN→RUNNING→FINISHED→LOBBY）与准备（DO 直测，node:sqlite 桩）。
import { describe, expect, it } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx } from './stubs/sqlite-storage';

function makeRoom() {
  const { ctx, store } = makeFakeCtx();
  return { room: new RoomDO(ctx as never, {} as never), sql: store.sql };
}

function req(capacity: number, nickname = 'host1'): CreateRoomRequest {
  return { nickname, capacity, randomMode: 'S1', startLevel: 1 };
}

/** 建房并加入 capacity-1 名客人，全员准备（房主也需准备，方案 §3.4）。 */
async function makeReadyLobby(capacity: number) {
  const { room, sql } = makeRoom();
  const created = await room.createRoom(req(capacity));
  if (!created.claimed) throw new Error('claim failed');
  const ids = [created.playerId];
  for (let i = 1; i < capacity; i += 1) {
    const joined = await room.joinRoom(`g${i}`);
    if (!joined.joined) throw new Error('join failed');
    ids.push(joined.playerId);
  }
  for (const id of ids) room.setReady(id, true);
  return { room, sql, host: created.playerId, guests: ids.slice(1), ids };
}

function setState(sql: ReturnType<typeof makeFakeCtx>['store']['sql'], state: string) {
  sql.exec('UPDATE room_config SET state = ? WHERE id = 1', state);
}

describe('N15 配置更新正向与准备失效', () => {
  it('房主改配置成功：新配置回显并持久化（含 customSeed 设置/清除）', async () => {
    const { room, host } = await makeReadyLobby(2);
    const res = room.updateConfig(host, { randomMode: 'S2', startLevel: 5, customSeed: 'seed42' });
    expect(res).toEqual({
      updated: true,
      settings: { capacity: 2, randomMode: 'S2', startLevel: 5, customSeed: 'seed42' },
      readyReset: true,
      generation: 1,
    });
    const snap = room.getLobbyState();
    expect(snap?.settings).toEqual({ capacity: 2, randomMode: 'S2', startLevel: 5, customSeed: 'seed42' });
    const cleared = room.updateConfig(host, { customSeed: null });
    expect(cleared.updated && cleared.settings.customSeed === undefined).toBe(true);
  });

  it('改配置后已有准备全部失效（含房主），重新准备前开局失败', async () => {
    const { room, host, ids } = await makeReadyLobby(2);
    expect(room.getLobbyState()?.seats.every((s) => s.isReady)).toBe(true);
    room.updateConfig(host, { startLevel: 3 });
    expect(room.getLobbyState()?.seats.every((s) => !s.isReady)).toBe(true);
    expect(room.startGame(host)).toEqual({ started: false, error: 'PLAYERS_NOT_READY' });
    for (const id of ids) room.setReady(id, true);
    expect(room.startGame(host).started).toBe(true);
  });

  it('非房主/未知席位改配置失败且配置不变', async () => {
    const { room, guests, host } = await makeReadyLobby(2);
    expect(room.updateConfig(guests[0], { startLevel: 9 })).toEqual({ updated: false, error: 'NOT_HOST' });
    expect(room.updateConfig('p_nobody', { startLevel: 9 })).toEqual({ updated: false, error: 'UNAUTHORIZED' });
    expect(room.getLobbyState()?.settings.startLevel).toBe(1);
    expect(room.getLobbyState()?.seats.every((s) => s.isReady)).toBe(true); // 失败不改准备
    expect(host).toBeTruthy();
  });

  it('非法字段与容量低于在场席位被拒绝（边界与创建入口同源）', async () => {
    const { room, host, sql } = await makeReadyLobby(3);
    const bad: Array<Record<string, unknown>> = [
      { capacity: 7 },
      { capacity: 1 },
      { capacity: 2.5 },
      { startLevel: 0 },
      { startLevel: 11 },
      { randomMode: 'S4' },
      { customSeed: '' },
      { customSeed: 'x'.repeat(33) },
      { customSeed: 'bad seed!' },
    ];
    for (const patch of bad) {
      expect(room.updateConfig(host, patch as never)).toEqual({ updated: false, error: 'BAD_CONFIG' });
    }
    // 在场 3 席：容量降到 2 拒绝，降到 3 允许。
    expect(room.updateConfig(host, { capacity: 2 })).toEqual({ updated: false, error: 'CAPACITY_BELOW_SEATS' });
    expect(room.updateConfig(host, { capacity: 3 }).updated).toBe(true);
    expect(room.getLobbyState()?.settings.capacity).toBe(3);
    expect(sql).toBeTruthy();
  });
});

describe('N15 准备与开局门槛', () => {
  it('准备/取消准备正向；未知席位与未占用拒绝', async () => {
    const { room, guests } = await makeReadyLobby(2);
    expect(room.setReady(guests[0], false)).toEqual({ ok: true, isReady: false, generation: 1 });
    expect(room.getLobbyState()?.seats.find((s) => s.playerId === guests[0])?.isReady).toBe(false);
    expect(room.setReady('p_nobody', true)).toEqual({ ok: false, error: 'UNAUTHORIZED' });
    const { room: empty } = makeRoom();
    expect(empty.setReady('p_x', true)).toEqual({ ok: false, error: 'ROOM_NOT_FOUND' });
  });

  it('全员准备开局成功：LOBBY→COUNTDOWN、名单与参数冻结、开赛后加入/改参/准备全拒绝', async () => {
    const { room, host, guests } = await makeReadyLobby(2);
    const res = room.startGame(host);
    expect(res.started).toBe(true);
    if (!res.started) return;
    expect(res.roster.map((s) => [s.nickname, s.isHost, s.joinOrder])).toEqual([
      ['host1', true, 1],
      ['g1', false, 2],
    ]);
    expect(room.getLobbyState()?.state).toBe('COUNTDOWN');
    // 开赛后：非法加入、改参数、准备、再次开局全部失败。
    expect(await room.joinRoom('late1')).toEqual({ joined: false, error: 'GAME_STARTED' });
    expect(room.updateConfig(host, { startLevel: 2 })).toEqual({ updated: false, error: 'GAME_STARTED' });
    expect(room.setReady(guests[0], false)).toEqual({ ok: false, error: 'GAME_STARTED' });
    expect(room.startGame(host)).toEqual({ started: false, error: 'GAME_STARTED' });
  });

  it('人数不足、未准备、非房主开局均失败且状态保持 LOBBY', async () => {
    const { room, host, guests } = await makeReadyLobby(3);
    room.setReady(guests[1], false);
    expect(room.startGame(host)).toEqual({ started: false, error: 'PLAYERS_NOT_READY' });
    room.setReady(guests[1], true);
    room.leaveRoom(guests[0]);
    room.leaveRoom(guests[1]);
    expect(room.startGame(host)).toEqual({ started: false, error: 'NOT_ENOUGH_PLAYERS' });
    expect(room.getLobbyState()?.state).toBe('LOBBY');
    const back = await room.joinRoom('g9');
    if (!back.joined) throw new Error('join failed');
    room.setReady(back.playerId, true);
    expect(room.startGame(back.playerId)).toEqual({ started: false, error: 'NOT_HOST' });
    expect(room.startGame('p_nobody')).toEqual({ started: false, error: 'UNAUTHORIZED' });
    expect(room.getLobbyState()?.state).toBe('LOBBY');
  });
});

describe('N15 终局与下一局', () => {
  it('finishGame 仅 RUNNING 可终局；nextRound 房主 FINISHED→LOBBY 全员重新准备', async () => {
    const { room, sql, host, guests } = await makeReadyLobby(2);
    room.startGame(host);
    expect(room.finishGame()).toEqual({ finished: false, error: 'BAD_STATE' }); // COUNTDOWN 不可终局
    setState(sql, 'RUNNING');
    expect(room.finishGame()).toEqual({ finished: true });
    expect(room.finishGame()).toEqual({ finished: false, error: 'BAD_STATE' }); // 幂等：已 FINISHED
    expect(room.nextRound(guests[0])).toEqual({ ok: false, error: 'NOT_HOST' });
    expect(room.nextRound(host)).toEqual({ ok: true, generation: 1 });
    const snap = room.getLobbyState();
    expect(snap?.state).toBe('LOBBY');
    expect(snap?.seats.every((s) => !s.isReady)).toBe(true); // 下一局全员重新准备
    expect(sql.exec('SELECT COUNT(*) AS c FROM match_roster').one().c).toBe(0); // 冻结名单清空
    // 下一局：配置可再改、腾出的席位可再加入、可再开局。
    expect(room.updateConfig(host, { randomMode: 'S3' }).updated).toBe(true);
    room.leaveRoom(guests[0]);
    expect((await room.joinRoom('g2')).joined).toBe(true);
  });

  it('LOBBY/COUNTDOWN 状态 nextRound 拒绝；开赛后中途退出不改写已冻结名单', async () => {
    const { room, sql, host, guests } = await makeReadyLobby(2);
    expect(room.nextRound(host)).toEqual({ ok: false, error: 'BAD_STATE' });
    room.startGame(host);
    const rosterBefore = [
      ...sql.exec('SELECT player_id FROM match_roster ORDER BY join_order'),
    ].map((r) => String(r.player_id));
    room.leaveRoom(guests[0]);
    const rosterAfter = [
      ...sql.exec('SELECT player_id FROM match_roster ORDER BY join_order'),
    ].map((r) => String(r.player_id));
    expect(rosterAfter).toEqual(rosterBefore); // 名单冻结语义（淘汰接线属 N18）
    expect(room.nextRound(host)).toEqual({ ok: false, error: 'BAD_STATE' });
  });
});

describe('N15 加入序号修复（N12 O2：MAX+1 不撞号）', () => {
  it('中途退出后新加入者序号取存活最大值+1，不复用旧号', async () => {
    const { room } = await makeRoom();
    const created = await room.createRoom(req(4));
    if (!created.claimed) throw new Error('claim failed');
    const a = await room.joinRoom('ga');
    const b = await room.joinRoom('gb');
    if (!a.joined || !b.joined) throw new Error('join failed');
    expect([a.joinOrder, b.joinOrder]).toEqual([2, 3]);
    room.leaveRoom(created.playerId); // 房主(1)退出：存活 {2,3}，count=2
    const c = await room.joinRoom('gc');
    if (!c.joined) throw new Error('join failed');
    expect(c.joinOrder).toBe(4); // 旧逻辑 COUNT+1=3 会撞 gb 的号
    expect(room.getSeats().map((s) => s.joinOrder)).toEqual([2, 3, 4]);
    expect(room.getSeats().filter((s) => s.isHost).map((s) => s.playerId)).toEqual([a.playerId]);
  });
});
