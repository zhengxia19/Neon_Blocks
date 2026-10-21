// N42：恶意流量与协议上限测试（Node ≥22 原生 fetch + 最小原始 WS 客户端，直连本地 Worker 8787）。
// 说明：Node undici WebSocket 不发 Origin，而服务端对 join/ticket/ws 要求非空且被允许的
// Origin（防脚本裸 POST/握手），故本脚本自带最小 WS 客户端（握手、掩码帧、ping→pong）。
// 场景（各自独立房间，互不干扰）：
//  1) 100Hz 高频快照洪水：服务端每连接 20 条/秒滑窗限流（room.ts INBOUND_RATE_PER_SEC），
//     观测旁观端从洪水席位收到的目标帧率与连接存活。
//  2) 重复 seq：同 seq 快照只入账一次（严格递增守卫）。
//  3) 迟到帧：低于高水位的 seq 被丢弃。
//  4) 错误码/非法消息：未知类型、禁用字段、超限报文、非法 JSON、错误版本的响应与连接存活。
//  5) 慢客户端：原始 TCP 套接字暂停读取 15s（TCP 窗口关闭 ⇒ 服务端 bufferedAmount 超
//     16KiB ⇒ deliverFrame 单槽覆盖旧帧保留新帧），恢复后只收到最新帧、无陈旧积压。
//  6) 断线重连：WS 异常关闭 → 宽限期内换票重连 → 席位保留、连接恢复。
// 全程度量：每连接 inbound/outbound 字节、消息数、最大报文（≤4KiB）、remote_snapshot/scoreboard 计数。
// 用法：node tests/load/mp-abuse.mjs [--api http://127.0.0.1:8787] [--out evidence/multiplayer/N42/abuse-metrics.json]
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const API = argOf('api', 'http://127.0.0.1:8787');
const ORIGIN = 'http://127.0.0.1:4173'; // 本地 DEV_ORIGINS 白名单内
const OUT = argOf('out', 'evidence/multiplayer/N42/abuse-metrics.json');
const V = 1;

const log = (line) => {
  console.log(line);
  appendFileSync(OUT.replace(/\.json$/, '') + '-abuse.log', line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    ...init,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ---------------------------------------------------------------- 最小原始 WS 客户端
class RawWS {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.onmessage = null; // (text: string) => void
    this.onclose = null; // (info: {code:number}) => void
    this.handshakeStatus = null;
    this.pingsReceived = 0;
    this.pongsSent = 0;
    this.destroyed = false;
  }

  async open(pathWithQuery) {
    const u = new URL(`${API.replace(/^http/, 'ws')}${pathWithQuery}`);
    const port = Number(u.port || 80);
    const host = u.hostname;
    this.sock = net.connect(port, host);
    await new Promise((resolve, reject) => {
      this.sock.once('connect', resolve);
      this.sock.once('error', reject);
    });
    const key = randomBytes(16).toString('base64');
    this.sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`,
    );
    let head = '';
    await new Promise((resolve) => {
      const onData = (chunk) => {
        head += chunk.toString('latin1');
        if (head.includes('\r\n\r\n')) {
          this.sock.removeListener('data', onData);
          const rest = head.slice(head.indexOf('\r\n\r\n') + 4);
          if (rest.length > 0) this.buf = Buffer.concat([this.buf, Buffer.from(rest, 'latin1')]);
          this.handshakeStatus = head.split('\r\n')[0];
          resolve();
        }
      };
      this.sock.on('data', onData);
    });
    if (!this.handshakeStatus?.startsWith('HTTP/1.1 101')) {
      this.destroyed = true;
      return false;
    }
    this.sock.on('data', (chunk) => this.#feed(chunk));
    this.sock.on('close', () => {
      this.destroyed = true;
      this.onclose?.({ code: 1006 });
    });
    this.sock.on('error', () => { this.destroyed = true; });
    return true;
  }

  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        maskKey = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked && maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x1) this.onmessage?.(payload.toString('utf8'));
      else if (opcode === 0x9) {
        this.pingsReceived += 1;
        this.#sendFrame(0xa, payload); // pong 回显 payload
        this.pongsSent += 1;
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.onclose?.({ code });
      }
    }
  }

  #sendFrame(opcode, payloadBuf) {
    const payload = payloadBuf;
    const mask = randomBytes(4);
    let head;
    if (payload.length < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  send(text) {
    this.#sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 4001, reason = 'abuse') {
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.#sendFrame(0x8, payload);
    } catch { /* socket gone */ }
    setTimeout(() => { try { this.sock?.destroy(); } catch { /* gone */ } }, 200).unref?.();
  }
}

// ---------------------------------------------------------------- 席位客户端
function emptyBoard() {
  return Array.from({ length: 24 }, () => '..........');
}

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.seq = 0;
    this.inBytes = 0;
    this.outBytes = 0;
    this.inMsgs = 0;
    this.outMsgs = 0;
    this.maxMsgBytes = 0;
    this.byType = {};
    this.remoteSnap = []; // {at, targetPlayerId, seq}
    this.scoreboardAt = [];
    this.errors = [];
    this.closed = null;
  }

  async create(capacity = 6) {
    const r = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ nickname: this.nickname, capacity, randomMode: 'S1', startLevel: 1 }),
    });
    if (r.status !== 201 || !r.json?.seatToken) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.json)}`);
    this.code = r.json.code;
    this.seatToken = r.json.seatToken;
    this.playerId = r.json.playerId;
    return this;
  }

  async join(code) {
    const r = await api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ nickname: this.nickname }),
    });
    if (r.status !== 200 || !r.json?.seatToken) throw new Error(`join failed: ${r.status} ${JSON.stringify(r.json)}`);
    this.code = code;
    this.seatToken = r.json.seatToken;
    this.playerId = r.json.playerId;
    return this;
  }

  async ticket() {
    const r = await api(`/api/rooms/${this.code}/ticket`, {
      method: 'POST',
      body: JSON.stringify({ playerId: this.playerId, seatToken: this.seatToken }),
    });
    if (r.status !== 200 || !r.json?.ticket) throw new Error(`ticket failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.ticket;
  }

  async connect() {
    const ticket = await this.ticket();
    this.closed = null; // 重连场景：清除上一次连接的关闭标记
    this.ws = new RawWS();
    const ok = await this.ws.open(`/ws/${this.code}?ticket=${ticket}`);
    if (!ok) throw new Error(`ws handshake failed: ${this.ws.handshakeStatus}`);
    this.ws.onmessage = (text) => {
      const len = Buffer.byteLength(text, 'utf8');
      this.inBytes += len;
      this.inMsgs += 1;
      if (len > this.maxMsgBytes) this.maxMsgBytes = len;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      this.byType[msg.type] = (this.byType[msg.type] ?? 0) + 1;
      if (msg.type === 'remote_snapshot') {
        this.remoteSnap.push({ at: Date.now(), targetPlayerId: msg.targetPlayerId, seq: msg.snapshot?.seq });
      } else if (msg.type === 'scoreboard') {
        this.scoreboardAt.push(Date.now());
      } else if (msg.type === 'error') {
        this.errors.push(msg);
      }
    };
    this.ws.onclose = (info) => {
      if (this.closed === null) this.closed = info;
    };
    return this;
  }

  sendRaw(raw) {
    const len = Buffer.byteLength(raw, 'utf8');
    this.outBytes += len;
    this.outMsgs += 1;
    if (len > this.maxMsgBytes) this.maxMsgBytes = len;
    this.ws.send(raw);
  }

  send(msg) { this.sendRaw(JSON.stringify(msg)); }
  nextSeq() { this.seq += 1; return this.seq; }

  snapshot(seq, score) {
    return {
      v: V, type: 'snapshot', seq,
      snapshot: { seq, board: emptyBoard(), active: { t: 'T', r: 0, x: 3, y: 0 }, score, lines: 0, level: 1, status: 'running' },
    };
  }

  ready() { this.send({ v: V, type: 'ready', seq: this.nextSeq() }); }
  start() { this.send({ v: V, type: 'start', seq: this.nextSeq() }); }
  close() { this.ws?.close(4001, 'abuse'); }
}

const results = { startedAt: new Date().toISOString(), api: API, scenarios: {} };

// ---------------------------------------------------------------- 场景 1：100Hz 洪水
async function scenarioFlood() {
  const host = await new Client('fhost').create(6);
  const watcher = await new Client('fwatch').join(host.code);
  const flood = await new Client('fflood').join(host.code);
  for (const c of [host, watcher, flood]) await c.connect();
  for (const c of [host, watcher, flood]) c.ready();
  await sleep(600);
  host.start();
  await sleep(3600); // 倒计时 3s + 余量
  // 洪水席位以高分成为 watcher 的观察目标。
  flood.send(flood.snapshot(flood.nextSeq(), 999_999));
  await sleep(1200);
  const target = watcher.remoteSnap.at(-1)?.targetPlayerId;
  const before = watcher.remoteSnap.length;
  const t0 = Date.now();
  let sent = 0;
  while (Date.now() - t0 < 6000) {
    flood.send(flood.snapshot(flood.nextSeq(), 999_999));
    sent += 1;
    await sleep(10); // 100Hz
  }
  const dur = Date.now() - t0;
  const got = watcher.remoteSnap.slice(before).filter((r) => r.targetPlayerId === flood.playerId);
  const r = {
    floodSent: sent,
    floodWindowMs: dur,
    watcherTargetIsFlood: target === flood.playerId,
    watcherFramesFromFlood: got.length,
    watcherFramesPerSec: Math.round((got.length / dur) * 1000 * 10) / 10,
    floodConnAlive: flood.closed === null,
    watcherMaxMsgBytes: watcher.maxMsgBytes,
    serverInboundCapPerSec: 20,
  };
  results.scenarios.flood100Hz = r;
  log(`[flood] 发送 ${sent} 条(100Hz/6s)；watcher 收到目标帧 ${got.length}（${r.watcherFramesPerSec}/s）；洪水连接存活=${r.floodConnAlive}`);
  for (const c of [host, watcher, flood]) c.close();
  await sleep(300);
  return r;
}

// ---------------------------------------------------------------- 场景 2/3：重复 seq 与迟到帧
async function scenarioSeq() {
  const host = await new Client('shost').create(3);
  const pub = await new Client('spub').join(host.code);
  const watcher = await new Client('swatch').join(host.code);
  for (const c of [host, pub, watcher]) await c.connect();
  for (const c of [host, pub, watcher]) c.ready();
  await sleep(600);
  host.start();
  await sleep(3600);
  // 让 pub 成为 watcher 目标（高分）。
  pub.send(pub.snapshot(pub.nextSeq(), 5000));
  await sleep(1200);
  const dupSeq = pub.seq + 10;
  const before = watcher.remoteSnap.length;
  // 重复 seq：同一 seq 发两次（内容不同分数）。
  pub.send(pub.snapshot(dupSeq, 5000));
  pub.send(pub.snapshot(dupSeq, 5001));
  // 迟到帧：低于高水位。
  pub.send(pub.snapshot(dupSeq - 5, 9999));
  await sleep(1500);
  const got = watcher.remoteSnap.slice(before).filter((r) => r.targetPlayerId === pub.playerId);
  const dupCount = got.filter((r) => r.seq === dupSeq).length;
  const lateCount = got.filter((r) => r.seq === dupSeq - 5).length;
  const r = { dupSeqSent: 2, dupSeqReceived: dupCount, lateSeqSent: 1, lateSeqReceived: lateCount, pubConnAlive: pub.closed === null };
  results.scenarios.dupLateSeq = r;
  log(`[seq] 重复 seq 收到 ${dupCount}/2；迟到帧收到 ${lateCount}/1；连接存活=${r.pubConnAlive}`);
  for (const c of [host, pub, watcher]) c.close();
  await sleep(300);
  return r;
}

// ---------------------------------------------------------------- 场景 4：非法消息
async function scenarioInvalid() {
  const host = await new Client('ihost').create(2);
  const peer = await new Client('ipeer').join(host.code);
  for (const c of [host, peer]) await c.connect();
  const probes = [];
  const probe = async (label, raw) => {
    const before = peer.errors.length;
    peer.sendRaw(raw);
    await sleep(700);
    const errs = peer.errors.slice(before);
    probes.push({ label, bytes: Buffer.byteLength(raw, 'utf8'), errors: errs.map((e) => ({ code: e.code, retryable: e.retryable })), connAlive: peer.closed === null });
  };
  await probe('unknown_type', JSON.stringify({ v: V, type: 'bogus', seq: 1 }));
  await probe('forbidden_field', JSON.stringify({ v: V, type: 'ready', seq: 2, playerId: 'x' }));
  await probe('oversized_4k', JSON.stringify({ v: V, type: 'snapshot', seq: 3, snapshot: { seq: 3, board: Array.from({ length: 24 }, () => 'X'.repeat(120)), active: null, score: 0, lines: 0, level: 1, status: 'running' } }));
  await probe('bad_json', '{not json');
  await probe('wrong_version', JSON.stringify({ v: 99, type: 'ping', seq: 4, clientTime: Date.now() }));
  const r = { probes, finalConnAlive: peer.closed === null };
  results.scenarios.invalidMessages = r;
  for (const p of probes) log(`[invalid] ${p.label} bytes=${p.bytes} errors=${JSON.stringify(p.errors)} alive=${p.connAlive}`);
  log(`[invalid] 探测结束连接存活=${r.finalConnAlive}`);
  for (const c of [host, peer]) c.close();
  await sleep(300);
  return r;
}

// ---------------------------------------------------------------- 场景 5：慢客户端（暂停读取 60s）
async function scenarioSlow() {
  const host = await new Client('dhost').create(3);
  const pub = await new Client('dpub').join(host.code);
  const slow = await new Client('dslow').join(host.code);
  for (const c of [host, pub, slow]) await c.connect();
  for (const c of [host, pub, slow]) c.ready();
  await sleep(600);
  host.start();
  await sleep(3600);
  pub.send(pub.snapshot(pub.nextSeq(), 8888)); // 高分 ⇒ slow 的目标 = pub
  await sleep(1200);
  // slow 断开正常连接后以原始套接字重连，并暂停读取（TCP 接收窗口关闭 ⇒
  // 服务端 bufferedAmount 超 16KiB ⇒ deliverFrame 单槽覆盖旧帧保留新帧）。
  slow.close();
  await sleep(800);
  const ticket = await slow.ticket();
  const raw = new RawWS();
  const ok = await raw.open(`/ws/${slow.code}?ticket=${ticket}`);
  const handshakeOk = ok;
  const frames = [];
  raw.onmessage = (text) => {
    try { frames.push(JSON.parse(text)); } catch { /* 非 JSON */ }
  };
  raw.sock.pause();
  const pubT0 = Date.now();
  let pubSent = 0;
  while (Date.now() - pubT0 < 60_000) {
    pub.send(pub.snapshot(pub.nextSeq(), 8888));
    pubSent += 1;
    await sleep(50); // 20Hz（入站限流内）⇒ 出站门控 5Hz ≈ 2.4KiB/s，60s 远超内核接收缓冲
  }
  raw.sock.resume();
  // 恢复后 publisher 继续 5Hz 发布 3 秒（真实节奏）：缓冲回落 ⇒ 下一帧即补发槽内
  // 最新帧（单槽覆盖语义），随后正常收流。
  const resumeT0 = Date.now();
  while (Date.now() - resumeT0 < 3000) {
    pub.send(pub.snapshot(pub.nextSeq(), 8888));
    await sleep(200);
  }
  await sleep(500);
  const remote = frames.filter((f) => f.type === 'remote_snapshot');
  const seqs = remote.map((f) => f.snapshot?.seq);
  const latestSeq = pub.seq;
  const oldest = seqs[0] ?? null;
  const newest = seqs.at(-1) ?? null;
  // 序列跳变数：单槽覆盖生效时出现 seq 空洞（内核缓冲吸收的部分为连续段）。
  let gaps = 0;
  for (let i = 1; i < seqs.length; i += 1) if (seqs[i] - seqs[i - 1] > 1) gaps += 1;
  const r = {
    handshakeOk,
    pauseSec: 60,
    pubFramesOfferedDuringPause: pubSent,
    resumeReceivedFrames: remote.length,
    resumeOldestSeq: oldest,
    resumeNewestSeq: newest,
    latestPublishedSeq: latestSeq,
    seqGaps: gaps,
    // 有界性判据：恢复后收到的帧数远小于发布帧数（服务端未积压全部历史），
    // 且最新态必达（单槽覆盖保留新帧）。
    backlogBounded: remote.length < pubSent,
    latestDelivered: newest === latestSeq,
    slowSockAlive: !raw.destroyed,
  };
  results.scenarios.slowClient = r;
  log(`[slow] 握手101=${handshakeOk} 暂停60s内发布${pubSent}帧；恢复后收到${remote.length}帧（最旧seq=${oldest}，最新seq=${newest}，发布最新=${latestSeq}，seq跳变=${gaps}）积压有界=${r.backlogBounded} 最新态必达=${r.latestDelivered}`);
  raw.close(1000, 'bye');
  for (const c of [host, pub]) c.close();
  await sleep(300);
  return r;
}

// ---------------------------------------------------------------- 场景 6：断线重连
async function scenarioReconnect() {
  const host = await new Client('rhost').create(2);
  const guest = await new Client('rguest').join(host.code);
  for (const c of [host, guest]) await c.connect();
  for (const c of [host, guest]) c.ready();
  await sleep(600);
  host.start();
  await sleep(3600);
  const t0 = Date.now();
  guest.close(); // 异常关闭 ⇒ 服务端进入宽限期
  await sleep(2000);
  await guest.connect(); // 换票重连（席位令牌仍在）
  const reconnectMs = Date.now() - t0;
  await sleep(1500);
  const r = {
    reconnectMs,
    guestReconnected: guest.closed === null,
    hostConnAlive: host.closed === null,
    hostSawPlayerLeft: (host.byType['player_left'] ?? 0) > 0,
  };
  results.scenarios.reconnect = r;
  log(`[reconnect] 断线→重连耗时 ${reconnectMs}ms；重连成功=${r.guestReconnected}；房主连接存活=${r.hostConnAlive}`);
  for (const c of [host, guest]) c.close();
  await sleep(300);
  return r;
}

// ---------------------------------------------------------------- 汇总
async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await scenarioFlood();
  await scenarioSeq();
  await scenarioInvalid();
  await scenarioSlow();
  await scenarioReconnect();
  results.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`[done] 指标写入 ${OUT}`);
  process.exit(process.exitCode ?? 0); // 兜底：不让残留 socket 挂住事件循环
}

main().catch((err) => {
  log(`[fatal] ${err?.stack ?? err}`);
  process.exitCode = 1;
});
