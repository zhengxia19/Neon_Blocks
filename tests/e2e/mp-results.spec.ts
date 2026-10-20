// N39-b：淘汰、结果与下一局 UI E2E（需本机 Worker 8787；未运行时整组跳过，CI 不受影响）。
// 覆盖：状态行明确展示 600 秒剩余（mm:ss）；guest02 连续硬降自撞顶→服务端裁决
// 淘汰→只剩 1 人即时结束（match_end survival）；两端结果面板文案完全一致
// （原因 + 胜者独立文案）；淘汰方榜单显示「已淘汰」；「下一局」按钮房主专属；
// 房主点下一局→两端回大厅（房间码不变、结果面板移除）→再准备再开局闭环。
// 600 秒超时同结果由服务端 Alarm 裁决（worker 测试覆盖），E2E 不等待 10 分钟。
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const API = process.env.VITE_MULTIPLAYER_API_URL ?? 'http://127.0.0.1:8787';

async function workerUp(request: { get(url: string, init?: { timeout?: number }): Promise<{ ok(): boolean }> }): Promise<boolean> {
  try {
    const res = await request.get(`${API}/api/health`, { timeout: 2000 });
    return res.ok();
  } catch {
    return false;
  }
}

// 本地 wrangler dev 的 DO 冷启动可能超过默认 5s：大厅可见性断言统一放宽到 15s。
const LOBBY_TIMEOUT = 15_000;

async function createRoom(page: Page, nickname: string): Promise<void> {
  await page.goto('/?mode=multiplayer');
  await page.fill('#mp-nickname', nickname);
  await page.click('#mp-create');
  await expect(page.locator('#mp-lobby')).toBeVisible({ timeout: LOBBY_TIMEOUT });
  await expect(page.locator('#mp-room-code-value')).toHaveText(/^[1-9]\d{5}$/);
}

async function joinRoom(page: Page, nickname: string, code: string): Promise<void> {
  await page.goto('/?mode=multiplayer');
  await page.fill('#mp-nickname', nickname);
  await page.fill('#mp-room-code', code);
  await page.click('#mp-join');
  await expect(page.locator('#mp-lobby')).toBeVisible({ timeout: LOBBY_TIMEOUT });
}

// ready 单向：成功后按钮禁用，补点前必须 isEnabled 守卫（N34 竞态教训）。
async function clickReady(page: Page): Promise<void> {
  const btn = page.locator('#mp-ready');
  if (await btn.isEnabled()) await btn.click();
}

async function readyAll(pages: Page[]): Promise<void> {
  for (const p of pages) await clickReady(p);
  const host = pages[0];
  try {
    await expect(host.locator('#mp-start')).toBeEnabled({ timeout: 3000 });
  } catch {
    for (const p of pages) await clickReady(p);
    await expect(host.locator('#mp-start')).toBeEnabled({ timeout: LOBBY_TIMEOUT });
  }
}

async function matchDebugNull(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const handle = (window as unknown as Record<string, { matchDebug?: () => unknown | null }>)
      .__NEON_BLOCKS_MP__;
    return handle?.matchDebug ? handle.matchDebug() === null : false;
  });
}

test.describe('N39-b 淘汰、结果与下一局（双人局）', () => {
  test('剩余时间展示；只剩 1 人即时结束；两端同结果；房主专属下一局闭环', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    const contexts: BrowserContext[] = [];
    try {
      const pages: Page[] = [];
      for (let i = 0; i < 2; i += 1) {
        const ctx = await browser.newContext();
        contexts.push(ctx);
        pages.push(await ctx.newPage());
      }
      const [host, guest] = pages;
      await createRoom(host, 'host01');
      const code = (await host.locator('#mp-room-code-value').textContent()) as string;
      await joinRoom(guest, 'guest02', code);
      await readyAll(pages);
      await host.click('#mp-start');

      // 状态行明确展示 600 秒剩余（校准墙钟驱动，mm:ss 格式）。
      for (const p of pages) {
        await expect(p.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: 10_000 });
      }
      // 剩余应接近 10:00（开局 3 秒内）。
      const label = await host.locator('#mp-match-status').textContent();
      expect(label).toMatch(/剩余 (09:5[7-9]|10:00)/);

      // guest02 连续硬降自撞顶（真实 topout→引擎 gameover→gameover 上报）。
      for (let i = 0; i < 40; i += 1) await guest.keyboard.press('Space');

      // 只剩 1 人即时结束：两端结果面板出现，原因与胜负文案完全一致
      // （同一条 match_end；按钮文本不参与比较——房主端多一个入口）。
      await expect(host.locator('#mp-results')).toBeVisible({ timeout: 10_000 });
      await expect(guest.locator('#mp-results')).toBeVisible({ timeout: 10_000 });
      const hostTitle = await host.locator('.mp-results-title').innerText();
      const guestTitle = await guest.locator('.mp-results-title').innerText();
      const hostWinners = await host.locator('.mp-results-winners').innerText();
      const guestWinners = await guest.locator('.mp-results-winners').innerText();
      expect(hostTitle).toBe(guestTitle);
      expect(hostWinners).toBe(guestWinners);
      expect(hostTitle).toBe('比赛结束');
      expect(hostWinners).toBe('胜者：host01');
      // 状态行同步为终局原因（不再是进行中/剩余）。
      await expect(host.locator('#mp-match-status')).toHaveText('比赛结束');
      await expect(guest.locator('#mp-match-status')).toHaveText('比赛结束');

      // 淘汰方榜单显示「已淘汰」；胜者横幅独立于名次（全员一致）。
      await expect(guest.locator('#leaderboard-slot tr', { hasText: 'guest02' }).locator('td').nth(4)).toHaveText('已淘汰');
      await expect(host.locator('.lb-winners')).toHaveText('本局胜者：host01');
      await expect(guest.locator('.lb-winners')).toHaveText('本局胜者：host01');

      // 「下一局」入口房主专属：guest 端不存在该按钮。
      await expect(host.locator('#mp-next-round')).toBeVisible();
      expect(await guest.locator('#mp-next-round').count()).toBe(0);

      // 房主点下一局：服务端 FINISHED→LOBBY 广播 → 两端回大厅（房间码不变、
      // 结果面板随对局 DOM 移除、对局句柄为 null）。
      await host.click('#mp-next-round');
      for (const p of pages) {
        await expect(p.locator('#mp-lobby')).toBeVisible({ timeout: LOBBY_TIMEOUT });
        await expect(p.locator('#mp-room-code-value')).toHaveText(code);
        expect(await p.locator('#mp-results').count()).toBe(0);
        expect(await matchDebugNull(p)).toBe(true);
      }

      // 闭环：全员重新准备（ready 已清）→ 房主再开局 → 两端再次进入对局。
      await readyAll(pages);
      await host.click('#mp-start');
      for (const p of pages) {
        await expect(p.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: 10_000 });
      }
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });
});
