/**
 * N31 联网 API/WS 客户端与生命周期测试。
 * 替身：FakeWS（记录 URL/发送帧/事件触发）、fetch 替身（记录请求）、Map 凭据存储。
 * 验收钉死：断线/恢复不重入并发连接；长令牌 seatToken 不泄露到握手 URL；
 * 退避封顶不侵蚀 30 秒重连宽限；协议版本不匹配不重连；单人模式不连接。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_KEY,
  NetClient,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_DELAY_MS,
  loadCredential,
  type CredentialStore,
} from '../../src/net/client';
import { DISCONNECT_GRACE_MS } from '../../shared/protocol';

class FakeWS {
  static instances: FakeWS[] = [];
  static ctorCount = 0;
  readonly url: string;
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((ev: never) => void)[]>();

  constructor(url: string) {
    FakeWS.ctorCount += 1;
    this.url = url;
    FakeWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.readyState = 3;
    this.fire('close', { code: code ?? 1006 } as never);
  }

  addEventListener(type: 'open' | 'message' | 'close', cb: (ev: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  fire(type: string, ev: never): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }

  /** 模拟服务端完成握手。 */
  serverOpen(): void {
    this.readyState = 1;
    this.fire('open', {} as never);
  }

  /** 模拟服务端下发消息帧。 */
  serverMessage(obj: unknown): void {
    this.fire('message', { data: JSON.stringify(obj) } as never);
  }

  /** 模拟服务端断开（不经客户端 close()）。 */
  serverClose(code: number): void {
    this.readyState = 3;
    this.fire('close', { code } as never);
  }
}

interface FetchCall {
  url: string;
  body: unknown;
}

function makeFetchImpl(handler: (url: string, body: unknown) => { status: number; json: unknown }): {
  calls: FetchCall[];
  fetchImpl: (input: string, init: { method: string; body: string }) => Promise<{
    status: number;
    json: () => Promise<unknown>;
  }>;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (input: string, init: { method: string; body: string }) => {
    const body = JSON.parse(init.body) as unknown;
    calls.push({ url: input, body });
    const res = handler(input, body);
    return Promise.resolve({
      status: res.status,
      json: () => Promise.resolve(res.json),
    });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function makeStore(): CredentialStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const SEAT_TOKEN = 'SEATLONGTOKEN_aaaaaaaaaaaaaaaaaaaaaaaa';
const API = 'http://127.0.0.1:8787';

function seatJson() {
  return {
    code: '842131',
    generation: 1,
    playerId: 'p_aabbccddeeff',
    seatToken: SEAT_TOKEN,
    room: { phase: 'LOBBY' },
  };
}

let ticketSeq = 0;
function ticketJson() {
  ticketSeq += 1;
  return { code: '842131', ticket: `tk${ticketSeq}`, expiresAt: Date.now() + 60_000 };
}

function makeClient(
  overrides: {
    handler?: (url: string, body: unknown) => { status: number; json: unknown };
    store?: CredentialStore & { map: Map<string, string> };
  } = {},
) {
  const store = overrides.store ?? makeStore();
  const { calls, fetchImpl } = makeFetchImpl(
    overrides.handler ??
      ((url) =>
        url.endsWith('/ticket')
          ? { status: 200, json: ticketJson() }
          : { status: 201, json: seatJson() }),
  );
  const fatal: { code: string; message: string }[] = [];
  const messages: unknown[] = [];
  const closes: { code: number; willReconnect: boolean }[] = [];
  const client = new NetClient({
    apiBaseUrl: API,
    credentialStore: store,
    fetchImpl,
    webSocketImpl: FakeWS,
    onFatal: (e) => fatal.push(e),
    onMessage: (m) => messages.push(m),
    onClose: (i) => closes.push(i),
  });
  return { client, store, calls, fatal, messages, closes };
}

beforeEach(() => {
  FakeWS.instances = [];
  FakeWS.ctorCount = 0;
  ticketSeq = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('N31 REST：创建/加入与席位凭据落盘', () => {
  it('正向：createRoom 成功后凭据（含 seatToken）写入 sessionStorage', async () => {
    const { client, store } = makeClient();
    const res = await client.createRoom({
      nickname: 'alice',
      capacity: 4,
      randomMode: 'S1',
      startLevel: 1,
    });
    expect(res.ok).toBe(true);
    const cred = loadCredential(store);
    expect(cred).not.toBeNull();
    expect(cred?.code).toBe('842131');
    expect(cred?.seatToken).toBe(SEAT_TOKEN);
    expect(store.map.has(CREDENTIAL_KEY)).toBe(true);
  });

  it('反向：joinRoom 409 ROOM_FULL ⇒ 中文提示「房间已满员。」且不落盘凭据', async () => {
    const { client, store } = makeClient({
      handler: () => ({ status: 409, json: { error: 'ROOM_FULL', message: '房间已满员。' } }),
    });
    const res = await client.joinRoom('842131', 'bob');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('ROOM_FULL');
      expect(res.message).toBe('房间已满员。');
    }
    expect(loadCredential(store)).toBeNull();
  });
});

describe('N31 WS 握手：仅传一次性短期票据', () => {
  it('正向：握手 URL 只含 ticket，不含 seatToken；seatToken 只进 POST body', async () => {
    const { client, calls } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    const res = await client.connect();
    expect(res.ok).toBe(true);
    expect(FakeWS.ctorCount).toBe(1);
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe(`ws://127.0.0.1:8787/ws/842131?ticket=tk1`);
    expect(ws.url).not.toContain(SEAT_TOKEN);
    const ticketCall = calls.find((c) => c.url.endsWith('/ticket'));
    expect(ticketCall).toBeDefined();
    expect((ticketCall?.body as { seatToken: string }).seatToken).toBe(SEAT_TOKEN);
  });

  it('反向：无凭据时 connect 返回中文「席位凭据无效」且不建立连接', async () => {
    const { client } = makeClient();
    const res = await client.connect();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe('席位凭据无效，请重新加入房间。');
    expect(FakeWS.ctorCount).toBe(0);
  });

  it('反向：ticket 401 UNAUTHORIZED ⇒ 中文提示且不建立连接', async () => {
    const { client } = makeClient({
      handler: (url) =>
        url.endsWith('/ticket')
          ? { status: 401, json: { error: 'UNAUTHORIZED' } }
          : { status: 201, json: seatJson() },
    });
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    const res = await client.connect();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe('席位凭据无效，请重新加入房间。');
    expect(FakeWS.ctorCount).toBe(0);
  });
});

describe('N31 生命周期：单飞连接与断线重连', () => {
  it('验收：断线/恢复不重入并发连接（重复 connect 与重连等待期均不并发）', async () => {
    const { client } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await Promise.all([client.connect(), client.connect()]);
    expect(FakeWS.ctorCount).toBe(1); // 并发 connect 只开一条
    const ws = FakeWS.instances[0];
    ws.serverOpen();
    ws.serverClose(1006); // 意外断开 ⇒ 进入重连等待
    expect(client.state).toBe('reconnecting');
    const res = await client.connect(); // 等待期内再 connect
    expect(res.ok).toBe(true);
    expect(FakeWS.ctorCount).toBe(1); // 不并发第二条
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    expect(FakeWS.ctorCount).toBe(2); // 退避到点后才开新连接
  });

  it('正向：指数退避 500/1000/2000ms 精确到点；每次重连重新换取一次性票据', async () => {
    const { client, calls } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    FakeWS.instances[0].serverClose(1006);
    vi.advanceTimersByTime(RECONNECT_BASE_MS - 1);
    expect(FakeWS.ctorCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.ctorCount).toBe(2);
    FakeWS.instances[1].serverClose(1006);
    vi.advanceTimersByTime(1000 - 1);
    expect(FakeWS.ctorCount).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.ctorCount).toBe(3);
    FakeWS.instances[2].serverClose(1006);
    vi.advanceTimersByTime(2000 - 1);
    expect(FakeWS.ctorCount).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.ctorCount).toBe(4);
    const ticketCalls = calls.filter((c) => c.url.endsWith('/ticket'));
    expect(ticketCalls.length).toBe(4); // 每次连接都换新的短期票据
  });

  it('验收：退避封顶 8s 且累计等待不侵蚀 30 秒宽限——预算耗尽即放弃并中文提示', async () => {
    expect(RECONNECT_MAX_DELAY_MS).toBeLessThan(DISCONNECT_GRACE_MS);
    const { client, fatal } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    // 持续断开：退避 500,1000,2000,4000,8000,8000（累计 23.5s）；下一次 8000 ⇒ 31.5s > 30s ⇒ 放弃
    for (let i = 0; i < 10; i += 1) {
      const ws = FakeWS.instances[FakeWS.instances.length - 1];
      ws.serverClose(1006);
      if (client.state !== 'reconnecting') break;
      await vi.runOnlyPendingTimersAsync();
    }
    expect(fatal.length).toBe(1);
    expect(fatal[0].message).toBe('连接已断开，重连超时，请重新加入房间。');
    expect(client.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0); // 无残留重连定时器
    const attempts = FakeWS.ctorCount;
    expect(attempts).toBe(7); // 首连 + 6 次退避重连后放弃
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2);
    expect(FakeWS.ctorCount).toBe(attempts); // 放弃后不再重连
  });

  it('正向：主动 close() 不再自动重连', async () => {
    const { client } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    FakeWS.instances[0].serverOpen();
    client.close();
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(FakeWS.ctorCount).toBe(1);
    expect(client.state).toBe('closed');
  });

  it('正向：leave() 清除 sessionStorage 凭据并断开', async () => {
    const { client, store } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    FakeWS.instances[0].serverOpen();
    client.leave();
    expect(loadCredential(store)).toBeNull();
    expect(client.state).toBe('closed');
  });
});

describe('N31 协议版本处理与发送', () => {
  it('正向：error(PROTOCOL_VERSION) ⇒ 中文致命提示且不重连（close 1002 同样不重连）', async () => {
    const { client, fatal } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.serverOpen();
    ws.serverMessage({ v: 1, type: 'error', code: 'PROTOCOL_VERSION', message: 'x', retryable: false });
    expect(fatal.length).toBe(1);
    expect(fatal[0].message).toBe('协议版本不匹配，请刷新页面后重试。');
    ws.serverClose(1002);
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(FakeWS.ctorCount).toBe(1); // 版本不匹配绝不重连
    expect(client.state).toBe('closed');
  });

  it('正向：v 不匹配的消息帧同样致命且不重连', async () => {
    const { client, fatal } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.serverOpen();
    ws.serverMessage({ v: 2, type: 'room_state' });
    expect(fatal.length).toBe(1);
    expect(fatal[0].code).toBe('PROTOCOL_VERSION');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(FakeWS.ctorCount).toBe(1);
  });

  it('正向：send 自动补连接内单调 seq 与 v；未 open 时返回 false', async () => {
    const { client } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    const ws = FakeWS.instances[0];
    expect(client.send({ type: 'ping', clientTime: 1 })).toBe(false); // 未 open
    ws.serverOpen();
    expect(client.send({ type: 'ping', clientTime: 1 })).toBe(true);
    expect(client.send({ type: 'ready' })).toBe(true);
    const frames = ws.sent.map((s) => JSON.parse(s) as { seq: number; v: number; type: string });
    expect(frames.map((f) => f.seq)).toEqual([1, 2]); // 连接内单调
    expect(frames.every((f) => f.v === 1)).toBe(true);
    ws.serverClose(1006);
    expect(client.send({ type: 'ready' })).toBe(false);
  });

  it('反向：陈旧连接的迟到帧不进入 onMessage', async () => {
    const { client, messages } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    const old = FakeWS.instances[0];
    old.serverOpen();
    old.serverClose(1006);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
    const fresh = FakeWS.instances[1];
    fresh.serverOpen();
    old.serverMessage({ v: 1, type: 'pong', seq: 1, serverTime: 1 }); // 旧连接迟到帧
    fresh.serverMessage({ v: 1, type: 'pong', seq: 2, serverTime: 2 }); // 新连接正常帧
    expect(messages.length).toBe(1);
    expect((messages[0] as { seq: number }).seq).toBe(2);
  });
});

describe('N31 复审修复（P2-1/P2-2/P2-3/P2-4）与 S→C 白名单（O-4）', () => {
  it('P2-1：票据 POST 在途时 leave() ⇒ 不构造僵尸连接', async () => {
    const { client, store } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    const p = client.connect(); // 不 await：票据 POST 挂起在微任务
    client.leave(); // 同步：清凭据 + closedIntentionally
    const res = await p;
    expect(res.ok).toBe(true);
    expect(FakeWS.ctorCount).toBe(0); // 票据 resolve 后守卫拦截，绝不 new WebSocket
    expect(loadCredential(store)).toBeNull();
    expect(client.state).toBe('closed');
  });

  it('P2-2：无 error 帧、仅 close(1002) ⇒ 冻结契约分支真实执行且不重连', async () => {
    const { client, fatal } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.serverOpen();
    ws.serverClose(1002); // 仅关闭码，无先行 error 帧
    expect(fatal.length).toBe(1);
    expect(fatal[0].code).toBe('PROTOCOL_VERSION');
    expect(fatal[0].message).toBe('协议版本不匹配，请刷新页面后重试。');
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS * 2);
    expect(FakeWS.ctorCount).toBe(1); // 1002 ⇒ 绝不重连
    expect(vi.getTimerCount()).toBe(0);
    expect(client.state).toBe('closed');
  });

  it('P2-3：重连期票据失败 ⇒ onClose 通知装配层且退避继续，下一次尝试成功', async () => {
    let ticketCalls = 0;
    const { client, closes } = makeClient({
      handler: (url) => {
        if (!url.endsWith('/ticket')) return { status: 201, json: seatJson() };
        ticketCalls += 1;
        return ticketCalls === 2
          ? { status: 409, json: { error: 'GENERATION_STALE' } }
          : { status: 200, json: ticketJson() };
      },
    });
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect(); // 票据 #1 成功
    FakeWS.instances[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS); // 票据 #2 失败
    expect(FakeWS.ctorCount).toBe(1); // 失败不建连
    expect(client.state).toBe('reconnecting'); // 退避继续（韧性路径）
    expect(closes.length).toBe(2); // 首断 + 票据失败均通知装配层
    expect(closes[1]).toEqual({ code: 1006, willReconnect: true });
    await vi.advanceTimersByTimeAsync(1000); // 票据 #3 成功
    expect(FakeWS.ctorCount).toBe(2);
  });

  it('P2-4：leave() 清除致命粘滞 ⇒ 同实例重新 join+connect 可用', async () => {
    const { client, fatal } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    FakeWS.instances[0].serverOpen();
    FakeWS.instances[0].serverClose(1002); // 版本致命
    expect(fatal.length).toBe(1);
    client.leave();
    const join = await client.joinRoom('842131', 'alice');
    expect(join.ok).toBe(true);
    const res = await client.connect();
    expect(res.ok).toBe(true); // 旧 fatal 不再粘滞
    expect(FakeWS.ctorCount).toBe(2);
  });

  it('O-4：type 不在服务端白名单的 v=1 帧被静默忽略（连接保持）', async () => {
    const { client, messages } = makeClient();
    await client.createRoom({ nickname: 'alice', capacity: 4, randomMode: 'S1', startLevel: 1 });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.serverOpen();
    ws.serverMessage({ v: 1, type: 'bogus_type' });
    ws.serverMessage({ v: 1, type: 'pong', seq: 1, serverTime: 2 });
    expect(messages.length).toBe(1); // 未知类型忽略、合法类型放行
    expect(client.state).toBe('open'); // 连接保持
  });
});

describe('N31 单人模式不连接（无自启动副作用）', () => {
  it('正向：仅构造 NetClient 不产生任何 WebSocket 连接', () => {
    makeClient();
    new NetClient({ apiBaseUrl: API, credentialStore: makeStore(), fetchImpl: makeFetchImpl(() => ({ status: 200, json: {} })).fetchImpl, webSocketImpl: FakeWS });
    expect(FakeWS.ctorCount).toBe(0);
  });
});

describe('N33 回归：fetch 以 null 接收者调用（浏览器 Illegal invocation）', () => {
  it('正向：#post 使用 .call(null, …)；反向：不允许方法调用形式', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'net', 'client.ts'), 'utf8');
    expect(src).toMatch(/this\.#fetch\.call\(null,/);
    expect(src).not.toMatch(/return this\.#fetch\(/);
  });
});
