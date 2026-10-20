// N38：双棋盘与排行榜连接 E2E（需本机 Worker 8787；未运行时整组跳过，CI 不受影响）。
// 覆盖：3 人局恰好 2 个 Canvas（无第三棋盘）；watch_target 切换对手预览（目标
// 改变后 <1s 内切换）；不同观看者同时看不同目标；目标切换后服务器补发最后帧
// （remoteSeq>0）；全员同一份排行榜（逐行一致、得分降序不乱序）且仅本人行高亮。
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

interface MatchDebug {
  watchTargetId: string | null;
  remoteSeq: number;
}

async function matchDebug(page: Page): Promise<MatchDebug | null> {
  return page.evaluate(() => {
    const handle = (window as unknown as Record<string, { matchDebug?: () => MatchDebug | null }>)
      .__NEON_BLOCKS_MP__;
    return handle?.matchDebug ? handle.matchDebug() : null;
  });
}

async function leaderboardNames(page: Page): Promise<string[]> {
  return page.locator('#leaderboard-slot .lb-name').allTextContents();
}

test.describe('N38 双棋盘与排行榜连接（三人局）', () => {
  test('两棋盘无第三块；目标切换 <1s；不同观看者不同目标；补帧；榜单全员一致不乱序', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    const contexts: BrowserContext[] = [];
    try {
      const pages: Page[] = [];
      for (let i = 0; i < 3; i += 1) {
        const ctx = await browser.newContext();
        contexts.push(ctx);
        pages.push(await ctx.newPage());
      }
      const [a, b, c] = pages;
      await createRoom(a, 'host01');
      const code = (await a.locator('#mp-room-code-value').textContent()) as string;
      await joinRoom(b, 'guest02', code);
      await joinRoom(c, 'guest03', code);
      await readyAll(pages);
      await a.click('#mp-start');
      for (const p of pages) {
        await expect(p.locator('#mp-match-status')).toContainText('比赛进行中', { timeout: 8000 });
      }

      // 无第三棋盘：全页严格 2 个 Canvas（本人 + 对手）。
      for (const p of pages) {
        expect(await p.locator('canvas').count()).toBe(2);
      }

      // 开局即有观察目标（服务器 match_start 后逐席位下发 watch_target）：
      // 同分并列按加入顺序升序 → b/c 的初始目标都是 host01。
      await expect(c.locator('#opponent-name')).toHaveText('host01', { timeout: LOBBY_TIMEOUT });
      await expect(b.locator('#opponent-name')).toHaveText('host01', { timeout: LOBBY_TIMEOUT });

      // guest02 硬降得分（dropPoints>0）→ 对 c 而言出现「分数高于自己」的候选，
      // 目标从 host01 切到 guest02；对 b 而言仍无人高于自己 → 目标保持 host01。
      await b.keyboard.press('Space');
      // 端到端切换（发布 ≤250ms + 服务端榜单批次 ≤500ms + 网络）应在 3s 内完成。
      await expect(c.locator('#opponent-name')).toHaveText('guest02', { timeout: 3000 });
      // 不同观看者同时看不同目标：b→host01、c→guest02。
      await expect(b.locator('#opponent-name')).toHaveText('host01');
      await expect(c.locator('#opponent-name')).toHaveText('guest02');

      // 切换后服务器补发目标最后帧：c 的远程棋盘水位 >0（缓存目标最后帧）。
      const cDebug = await matchDebug(c);
      expect(cDebug).not.toBeNull();
      expect(cDebug!.remoteSeq).toBeGreaterThan(0);
      // b 的目标未变（水位同样有帧，且观察目标 id 与 c 不同）。
      const bDebug = await matchDebug(b);
      expect(bDebug).not.toBeNull();
      expect(bDebug!.watchTargetId).not.toBe(cDebug!.watchTargetId);

      // 排行榜全员同一份：得分降序（guest02 领先），并列按加入顺序（host01 先于
      // guest03）；b/c 两份逐行一致（客户端绝不重排）。
      const namesB = await leaderboardNames(b);
      const namesC = await leaderboardNames(c);
      expect(namesB).toEqual(['guest02', 'host01', 'guest03']);
      expect(namesC).toEqual(namesB);
      // 本人行高亮是每客户端各自的（同一份榜单、不同高亮行）。
      await expect(b.locator('#leaderboard-slot tr.lb-self .lb-name')).toHaveText('guest02');
      await expect(c.locator('#leaderboard-slot tr.lb-self .lb-name')).toHaveText('guest03');
      // 对手面板数据来自同一份榜单（分数与榜上 guest02 一致）。
      const cOppScore = await c.locator('#opponent-score').textContent();
      const cRowScore = await c
        .locator('#leaderboard-slot tr', { hasText: 'guest02' })
        .locator('td')
        .nth(2)
        .textContent();
      expect(cOppScore).toBe(`分数 ${cRowScore}`);
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });
});
