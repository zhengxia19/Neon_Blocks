// N42：6 客户端持续压测（真实浏览器客户端，默认 600 秒整局）。
// 每页注入：WebSocket 包装（in/out 字节、消息数、最大报文、按类型计数、remote_snapshot/
// scoreboard 到达时刻）+ rAF 帧记录器（帧间隔分布、>25ms 长帧计数）。
// 对局中段（duration/2）对第 6 页调用 debugDropSocket 注入断线（客户端自动退避重连）。
// 600s 模式跑满 MATCH_DURATION_MS=600_000 ⇒ 服务端 timeout 终局，验证全员结果一致。
// 用法：node tests/load/mp-soak.mjs [--duration 600] [--base http://127.0.0.1:4173] [--out evidence/multiplayer/N42/soak-metrics.json]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DURATION = Number(argOf('duration', '600'));
const BASE = argOf('base', 'http://127.0.0.1:4173');
const OUT = argOf('out', 'evidence/multiplayer/N42/soak-metrics.json');
const P = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTRUMENT = () => {
  const stats = {
    opened: 0, closed: 0,
    inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, maxMsgBytes: 0,
    byType: {}, remoteSnapAt: [], scoreboardAt: [],
  };
  window.__WS_STATS = stats;
  const Orig = window.WebSocket;
  const Wrapped = function (url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    stats.opened += 1;
    ws.addEventListener('message', (ev) => {
      const len = typeof ev.data === 'string' ? new Blob([ev.data]).size : ev.data.byteLength;
      stats.inMsgs += 1;
      stats.inBytes += len;
      if (len > stats.maxMsgBytes) stats.maxMsgBytes = len;
      let type = '?';
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
        type = msg?.type ?? '?';
      } catch { /* 非 JSON */ }
      stats.byType[type] = (stats.byType[type] ?? 0) + 1;
      if (type === 'remote_snapshot') stats.remoteSnapAt.push(performance.now());
      else if (type === 'scoreboard') stats.scoreboardAt.push(performance.now());
    });
    ws.addEventListener('close', () => { stats.closed += 1; });
    const origSend = ws.send.bind(ws);
    ws.send = (d) => {
      const len = typeof d === 'string' ? new Blob([d]).size : d.byteLength;
      stats.outMsgs += 1;
      stats.outBytes += len;
      if (len > stats.maxMsgBytes) stats.maxMsgBytes = len;
      return origSend(d);
    };
    return ws;
  };
  window.WebSocket = Wrapped;

  const frames = { started: false, count: 0, sum: 0, p50: 0, p95: 0, p99: 0, max: 0, long25: 0, deltas: [] };
  window.__FRAME_STATS = frames;
  let last = performance.now();
  const tick = (t) => {
    if (frames.started) {
      const d = t - last;
      frames.count += 1;
      frames.sum += d;
      frames.deltas.push(d);
      if (d > 25) frames.long25 += 1;
      if (d > frames.max) frames.max = d;
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__FRAMES_START = () => {
    frames.started = true;
    frames.count = 0; frames.sum = 0; frames.max = 0; frames.long25 = 0; frames.deltas = [];
    last = performance.now();
  };
  window.__FRAMES_SUMMARY = () => {
    const ds = frames.deltas.slice().sort((a, b) => a - b);
    const q = (p) => (ds.length === 0 ? 0 : ds[Math.min(ds.length - 1, Math.floor(ds.length * p))]);
    return {
      count: frames.count,
      meanMs: frames.count ? Math.round((frames.sum / frames.count) * 100) / 100 : 0,
      p50Ms: Math.round(q(0.5) * 100) / 100,
      p95Ms: Math.round(q(0.95) * 100) / 100,
      p99Ms: Math.round(q(0.99) * 100) / 100,
      maxMs: Math.round(frames.max * 100) / 100,
      longFrames25ms: frames.long25,
      longFrameRatio: frames.count ? Math.round((frames.long25 / frames.count) * 10000) / 10000 : 0,
    };
  };
};

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const browser = await chromium.launch();
  const contexts = [];
  const pages = [];
  const out = {
    startedAt: new Date().toISOString(),
    durationSec: DURATION,
    base: BASE,
    clients: [],
  };
  try {
    for (let i = 0; i < P; i += 1) {
      const ctx = await browser.newContext();
      await ctx.addInitScript(INSTRUMENT);
      contexts.push(ctx);
      pages.push(await ctx.newPage());
    }
    const [host, ...guests] = pages;
    // 建房 + 容量调到 6。
    await host.goto(`${BASE}/?mode=multiplayer`);
    await host.fill('#mp-nickname', 'soakhost01');
    await host.click('#mp-create');
    await host.waitForSelector('#mp-lobby', { timeout: 30_000 });
    const code = await host.locator('#mp-room-code-value').textContent();
    await host.selectOption('#mp-capacity', '6');
    await host.click('#mp-apply-settings');
    await sleep(1500); // 容量设置经 host WS → DO 串行生效；先落定再收访客（N41 观察项）
    for (let i = 1; i < P; i += 1) {
      await pages[i].goto(`${BASE}/?mode=multiplayer`);
      await pages[i].fill('#mp-nickname', `soakguest0${i + 1}`);
      await pages[i].fill('#mp-room-code', code);
      await pages[i].click('#mp-join');
      try {
        await pages[i].waitForSelector('#mp-lobby', { timeout: 10_000 });
      } catch {
        // 容量生效竞态兜底：ROOM_FULL 等 ⇒ 1s 后重试加入。
        console.log(`[soak] guest${i + 1} 首次加入未进厅，重试`);
        await sleep(1000);
        await pages[i].fill('#mp-room-code', code);
        await pages[i].click('#mp-join');
        await pages[i].waitForSelector('#mp-lobby', { timeout: 30_000 });
      }
      console.log(`[soak] guest${i + 1} 进厅`);
    }
    for (const pg of pages) {
      const btn = pg.locator('#mp-ready');
      if (await btn.isEnabled()) await btn.click();
    }
    await host.waitForSelector('#mp-start:not([disabled])', { timeout: 10_000 });
    await host.click('#mp-start');
    for (const pg of pages) {
      await pg.waitForFunction(() => document.querySelector('#mp-match-status')?.textContent?.includes('比赛进行中'), null, { timeout: 15_000 });
    }
    for (const pg of pages) await pg.evaluate(() => window.__FRAMES_START());
    const matchStartedAt = Date.now();

    // 中段断线注入（第 6 页）。
    const dropAt = Math.floor((DURATION * 1000) / 2);
    const dropTimer = setTimeout(async () => {
      try {
        await pages[P - 1].evaluate(() => window.__NEON_BLOCKS_MP__?.debugDropSocket?.());
      } catch { /* 页面已关 */ }
    }, dropAt);

    // 跑满 duration（600s ⇒ 服务端 timeout 终局）。
    await sleep(DURATION * 1000);
    clearTimeout(dropTimer);

    if (DURATION >= 595) {
      for (const pg of pages) {
        await pg.waitForSelector('#mp-results', { timeout: 30_000 });
      }
    }

    for (let i = 0; i < P; i += 1) {
      const ws = await pages[i].evaluate(() => {
        const s = window.__WS_STATS;
        return {
          opened: s.opened, closed: s.closed,
          inMsgs: s.inMsgs, inBytes: s.inBytes, outMsgs: s.outMsgs, outBytes: s.outBytes,
          maxMsgBytes: s.maxMsgBytes, byType: s.byType,
          remoteSnapCount: s.remoteSnapAt.length,
          scoreboardCount: s.scoreboardAt.length,
          remoteSnapHz: Math.round((s.remoteSnapAt.length / ((performance.now()) / 1000)) * 100) / 100,
        };
      });
      const frames = await pages[i].evaluate(() => window.__FRAMES_SUMMARY());
      const debug = await pages[i].evaluate(() => window.__NEON_BLOCKS_MP__?.matchDebug?.() ?? null);
      out.clients.push({ nickname: i === 0 ? 'soakhost01' : `soakguest0${i + 1}`, ws, frames, remoteSeq: debug?.remoteSeq ?? null, watchTarget: debug?.watchTargetId ?? null });
    }
    out.matchWallMs = Date.now() - matchStartedAt;
    out.finishedAt = new Date().toISOString();
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`[soak] ${DURATION}s × ${P} 客户端完成，指标写入 ${OUT}`);
    for (const c of out.clients) {
      console.log(`[soak] ${c.nickname}: in=${c.ws.inBytes}B/${c.ws.inMsgs}msg out=${c.ws.outBytes}B/${c.ws.outMsgs}msg max=${c.ws.maxMsgBytes}B remoteSnap=${c.ws.remoteSnapCount} scoreboard=${c.ws.scoreboardCount} frames=${c.frames.count} p95=${c.frames.p95Ms}ms long=${c.frames.longFrames25ms}(${(c.frames.longFrameRatio * 100).toFixed(2)}%)`);
    }
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[soak-fatal] ${err?.stack ?? err}`);
  process.exitCode = 1;
});
