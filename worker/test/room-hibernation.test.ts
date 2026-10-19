// N14：WebSocket Hibernation 接线（DO 直测 + 桩模拟休眠/热重启重建）。
import { describe, expect, it } from 'vitest';
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

async function makeAttached() {
  const { ctx, store, accepted } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  const created = await room.createRoom({ nickname: 'host1', capacity: 2, randomMode: 'S1', startLevel: 1 });
  if (!created.claimed) throw new Error('claim failed');
  const issued = await room.issueTicket(created.playerId, created.seatToken);
  if (!issued.issued) throw new Error('issue failed');
  const { ws, state } = makeFakeWs();
  const attached = await room.attachWebSocket(issued.ticket, ws);
  if (!attached.ok) throw new Error('attach failed');
  return { room, ctx, store, accepted, ws, state, playerId: created.playerId, seatToken: created.seatToken };
}

describe('N14 acceptWebSocket 接管', () => {
  it('正向：票据有效 → 附件携带席位身份，连接声明入库', async () => {
    const { store, accepted, state, playerId } = await makeAttached();
    expect(accepted.length).toBe(1);
    expect(state.attachment).toEqual({ playerId, generation: 1 });
    const rows = store.db.prepare('SELECT player_id, generation FROM seat_conns').all();
    expect(rows).toEqual([{ player_id: playerId, generation: 1 }]);
  });

  it('反向：票据无效 → 不接管（accepted 为空），席位不变', async () => {
    const { ctx, store, accepted } = makeFakeCtx();
    const room = new RoomDO(ctx as never, {} as never);
    const created = await room.createRoom({ nickname: 'host1', capacity: 2, randomMode: 'S1', startLevel: 1 });
    if (!created.claimed) throw new Error('claim failed');
    const { ws } = makeFakeWs();
    const res = await room.attachWebSocket('f'.repeat(32), ws);
    expect(res).toEqual({ ok: false, error: 'TOKEN_REPLAY' });
    expect(accepted.length).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS c FROM seat_conns').all()[0].c).toBe(0);
  });

  it('DO fetch 升级交接：webSocket+upgrade → 接管成功；无效票据 → 401 JSON', async () => {
    const { ctx, store, accepted } = makeFakeCtx();
    const room = new RoomDO(ctx as never, {} as never);
    const created = await room.createRoom({ nickname: 'host1', capacity: 2, randomMode: 'S1', startLevel: 1 });
    if (!created.claimed) throw new Error('claim failed');
    const issued = await room.issueTicket(created.playerId, created.seatToken);
    if (!issued.issued) throw new Error('issue failed');
    const fake = makeFakeWs();
    const req = {
      method: 'GET',
      url: `https://api.example/ws/123456?ticket=${issued.ticket}`,
      headers: new Headers({ upgrade: 'websocket' }),
      webSocket: fake.ws,
    } as unknown as Request;
    // node undici 拒绝构造 status 101 响应（workerd 合法）：握手接管完成的
    // 判据改为附件与 seat_conns 断言；101 构造异常单独识别（E2E 覆盖 101）。
    let status = 0;
    try {
      status = (await room.fetch(req)).status;
    } catch (e) {
      // undici 的 101 拒绝信息不含状态码，按 RangeError 识别。
      expect(String(e)).toMatch(/RangeError.*init\["status"\]/);
      status = 101;
    }
    expect(status).toBe(101);
    expect(accepted.length).toBe(1);
    expect(fake.state.attachment).toEqual({ playerId: created.playerId, generation: 1 });
    const req2 = {
      method: 'GET',
      url: 'https://api.example/ws/123456?ticket=' + 'c'.repeat(32),
      headers: new Headers({ upgrade: 'websocket' }),
      webSocket: makeFakeWs().ws,
    } as unknown as Request;
    const res2 = await room.fetch(req2);
    expect(res2.status).toBe(401);
    expect(((await res2.json()) as Record<string, unknown>).error).toBe('TOKEN_REPLAY');
    void store;
  });

  it('本地 dev 回退：请求无 webSocket 属性 → DO 自建 pair，server 端接管、client 端随 101 回传', async () => {
    const { ctx, store, accepted } = makeFakeCtx();
    const room = new RoomDO(ctx as never, {} as never);
    const created = await room.createRoom({ nickname: 'host1', capacity: 2, randomMode: 'S1', startLevel: 1 });
    if (!created.claimed) throw new Error('claim failed');
    const issued = await room.issueTicket(created.playerId, created.seatToken);
    if (!issued.issued) throw new Error('issue failed');
    const clientFake = makeFakeWs();
    const serverFake = makeFakeWs();
    // node 环境无 WebSocketPair：桩为构造返回 [client, server] 的类。
    const original = (globalThis as Record<string, unknown>)['WebSocketPair'];
    (globalThis as Record<string, unknown>)['WebSocketPair'] = class {
      constructor() {
        return [clientFake.ws, serverFake.ws];
      }
    };
    const req = {
      method: 'GET',
      url: `https://api.example/ws/123456?ticket=${issued.ticket}`,
      headers: new Headers({ upgrade: 'websocket' }),
    } as unknown as Request;
    let status = 0;
    try {
      status = (await room.fetch(req)).status;
    } catch (e) {
      // undici 拒绝构造 status 101（workerd 合法）：按 RangeError 识别 101 语义。
      expect(String(e)).toMatch(/RangeError.*init\["status"\]/);
      status = 101;
    } finally {
      if (original === undefined) delete (globalThis as Record<string, unknown>)['WebSocketPair'];
      else (globalThis as Record<string, unknown>)['WebSocketPair'] = original;
    }
    expect(status).toBe(101);
    // server 端被 Hibernation 接管且携带席位附件；client 端不被接管（随响应回传）。
    expect(accepted.length).toBe(1);
    expect(accepted[0]).toBe(serverFake.ws as unknown as (typeof accepted)[number]);
    expect(serverFake.state.attachment).toEqual({ playerId: created.playerId, generation: 1 });
    expect(clientFake.state.attachment).toBeNull();
    const rows = store.db.prepare('SELECT player_id, generation FROM seat_conns').all();
    expect(rows).toEqual([{ player_id: created.playerId, generation: 1 }]);
  });
});

describe('N14 事件回调', () => {
  it('ping → pong（附件身份可用）', async () => {
    const { room, ws, state } = await makeAttached();
    room.webSocketMessage(ws, 'ping');
    expect(state.sent).toEqual(['{"type":"pong"}']);
    room.webSocketMessage(ws, 'unknown-payload');
    expect(state.sent.length).toBe(1); // 未知消息忽略不放大
  });

  it('附件缺失的消息连接 → 4001 关闭', async () => {
    const { ctx, store } = makeFakeCtx();
    const room = new RoomDO(ctx as never, {} as never);
    const { ws, state } = makeFakeWs();
    room.webSocketMessage(ws, 'ping');
    expect(state.closed?.code).toBe(4001);
    expect(state.sent.length).toBe(0);
    void store;
  });

  it('close/error 事件释放连接声明 → 同席位可再换发新票据接管', async () => {
    const { room, ctx, store, ws, playerId, seatToken } = await makeAttached();
    room.webSocketClose(ws, 1006, '', false);
    expect(store.db.prepare('SELECT COUNT(*) AS c FROM seat_conns').all()[0].c).toBe(0);
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    const second = makeFakeWs();
    const res = await room.attachWebSocket(issued.ticket, second.ws);
    expect(res.ok).toBe(true);
    void ctx;
  });

  it('error 事件同样释放声明（旧连接不阻塞新接管）', async () => {
    const { room, store, ws, playerId, seatToken } = await makeAttached();
    room.webSocketError(ws, new Error('boom'));
    const issued = await room.issueTicket(playerId, seatToken);
    if (!issued.issued) throw new Error('issue failed');
    expect((await room.attachWebSocket(issued.ticket, makeFakeWs().ws)).ok).toBe(true);
    void store;
  });
});

describe('N14 休眠/热重启重建', () => {
  it('新实例构造即恢复连接上下文：有效连接保留、席位与房间配置可恢复', async () => {
    const { ctx, store, accepted, state, playerId } = await makeAttached();
    // 模拟驱逐后重建：同一 SQLite 与 Hibernation 存量连接，新 DO 实例。
    const ctx2 = {
      storage: { sql: store.sql },
      acceptWebSocket: (w: FakeHibernatableSocket, a?: unknown) => ctx.acceptWebSocket(w, a),
      getWebSockets: ctx.getWebSockets,
    };
    const revived = new RoomDO(ctx2 as never, {} as never);
    expect(state.closed).toBeNull(); // 连接未被误关
    expect(accepted.length).toBe(1);
    // 连接身份可恢复：附件仍指向原席位；房间配置从 SQLite 恢复。
    expect(state.attachment).toEqual({ playerId, generation: 1 });
    expect(revived.getSeats()).toEqual([
      { playerId, nickname: 'host1', isHost: true, joinOrder: 1 },
    ]);
    // 重建实例上事件回调仍按附件身份工作。
    const ws = accepted[0] as unknown as WebSocket;
    revived.webSocketMessage(ws, 'ping');
    expect(state.sent).toEqual(['{"type":"pong"}']);
  });

  it('失效连接即刻关闭：房间关闭重占后旧连接 4001 且声明清除', async () => {
    const { ctx, store, state, playerId } = await makeAttached();
    // 房主离开 → 房间关闭（连接未走 close 事件，模拟 DO 驱逐时序）。
    const roomRef = new RoomDO(ctx as never, {} as never);
    roomRef.leaveRoom(playerId);
    const ctx2 = {
      storage: { sql: store.sql },
      acceptWebSocket: (w: FakeHibernatableSocket, a?: unknown) => ctx.acceptWebSocket(w, a),
      getWebSockets: ctx.getWebSockets,
    };
    new RoomDO(ctx2 as never, {} as never); // 构造即核验
    expect(state.closed?.code).toBe(4001);
    expect(store.db.prepare('SELECT COUNT(*) AS c FROM seat_conns').all()[0].c).toBe(0);
  });

  it('附件缺失的存量连接 → 重建时 4001 关闭', async () => {
    const { ctx, store, accepted } = makeFakeCtx();
    const orphan = makeFakeWs();
    accepted.push(orphan.ws as unknown as FakeHibernatableSocket); // 无附件（模拟损坏/外部注入）
    const ctx2 = {
      storage: { sql: store.sql },
      acceptWebSocket: (w: FakeHibernatableSocket, a?: unknown) => ctx.acceptWebSocket(w, a),
      getWebSockets: ctx.getWebSockets,
    };
    new RoomDO(ctx2 as never, {} as never);
    expect(orphan.state.closed?.code).toBe(4001);
  });
});


