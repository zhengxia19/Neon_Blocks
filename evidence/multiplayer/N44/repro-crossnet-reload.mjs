// N44 跨网诊断：2 人局开赛 → guest 刷新 → 每秒采样双端 matchDebug 与对手昵称。
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:4173';

async function debug(page) {
  return page.evaluate(() => {
    const h = window.__NEON_BLOCKS_MP__;
    return h?.matchDebug ? h.matchDebug() ?? null : 'NO_HANDLE';
  });
}

const browser = await chromium.launch();
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const host = await ctxA.newPage();
const guest = await ctxB.newPage();

await host.goto(`${BASE}/?mode=multiplayer`);
await host.fill('#mp-nickname', 'diaghost');
await host.click('#mp-create');
await host.waitForSelector('#mp-lobby', { timeout: 15000 });
await host.waitForFunction(() => /^[1-9]\d{5}$/.test(document.querySelector('#mp-room-code-value')?.textContent ?? ''), null, { timeout: 15000 });
const code = await host.locator('#mp-room-code-value').textContent();
console.log('code=', code);

await guest.goto(`${BASE}/?mode=multiplayer`);
await guest.fill('#mp-nickname', 'diagguest');
await guest.fill('#mp-room-code', code);
await guest.click('#mp-join');
await guest.waitForSelector('#mp-lobby', { timeout: 15000 });

for (const p of [host, guest]) {
  if (await p.locator('#mp-ready').isEnabled()) await p.click('#mp-ready');
}
try {
  await host.waitForSelector('#mp-start:not([disabled])', { timeout: 3000 });
} catch {
  for (const p of [host, guest]) {
    if (await p.locator('#mp-ready').isEnabled()) await p.click('#mp-ready');
  }
  await host.waitForSelector('#mp-start:not([disabled])', { timeout: 15000 });
}
await host.click('#mp-start');
for (const p of [host, guest]) {
  await p.waitForFunction(() => /比赛进行中/.test(document.querySelector('#mp-match-status')?.textContent ?? ''), null, { timeout: 15000 });
}
console.log('running. hostDebug=', JSON.stringify(await debug(host)), 'guestDebug=', JSON.stringify(await debug(guest)));
console.log('guest opponent-name=', await guest.locator('#opponent-name').textContent());

await guest.reload();
for (let i = 1; i <= 20; i += 1) {
  await guest.waitForTimeout(1000);
  const gd = await debug(guest);
  const hd = await debug(host);
  const name = await guest.locator('#opponent-name').textContent();
  const status = await guest.locator('#mp-match-status').textContent();
  console.log(`t+${i}s guest=${JSON.stringify(gd)} host=${JSON.stringify(hd)} name="${name}" status="${(status ?? '').slice(0, 24)}"`);
}
await browser.close();
