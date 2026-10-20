// N36：固定双棋盘响应式布局 E2E（需本机 Worker 8787；未运行时整组跳过）。
// 覆盖：桌面 1280 双棋盘（本人 300px + 对手 180px + 排行榜列）无重叠无横向溢出；
// 390/320 手机视口对手缩略条置顶、触屏按键可见、无横向溢出；全页严格 2 个 Canvas。
// 截图输出 evidence/multiplayer/N36/。
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

/** 准备并以对端席位列表确认（服务端权威同步）；点击偶发丢失时补一次。 */
async function readyUp(page: Page, name: string, witness: Page): Promise<void> {
  await page.click('#mp-ready');
  const pattern = new RegExp(`${name}.*已准备`);
  try {
    await expect(witness.locator('#mp-seat-list')).toContainText(pattern, { timeout: 3000 });
  } catch {
    // ready 单向幂等：仍为可点状态才补点（已准备则按钮禁用，直接点击会挂死）。
    const btn = page.locator('#mp-ready');
    if (await btn.isEnabled()) await btn.click();
    await expect(witness.locator('#mp-seat-list')).toContainText(pattern, { timeout: LOBBY_TIMEOUT });
  }
}

/** 双人建房→准备（双端确认）→开局→双端「比赛进行中」。 */
async function startMatch(a: Page, b: Page): Promise<void> {
  await createRoom(a, 'host01');
  const code = (await a.locator('#mp-room-code-value').textContent()) as string;
  await joinRoom(b, 'guest02', code);
  await readyUp(a, 'host01', b);
  await readyUp(b, 'guest02', a);
  await expect(a.locator('#mp-start')).toBeEnabled({ timeout: LOBBY_TIMEOUT });
  await a.click('#mp-start');
  await expect(a.locator('#mp-match-status')).toHaveText('比赛进行中', { timeout: 10_000 });
  await expect(b.locator('#mp-match-status')).toHaveText('比赛进行中', { timeout: 10_000 });
}

interface Box { x: number; y: number; width: number; height: number }

function overlaps(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return true;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('N36 双棋盘响应式布局（双端实时对局）', () => {
  test('桌面 1280：严格 2 Canvas、双棋盘无重叠、排行榜列就位、无横向溢出', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    const ctxA: BrowserContext = await browser.newContext();
    const ctxB: BrowserContext = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await startMatch(a, b);
      // 严格只 2 个 Canvas（不绘制第 3～6 张棋盘）。
      await expect(a.locator('canvas')).toHaveCount(2);
      await expect(b.locator('canvas')).toHaveCount(2);
      const selfBox = await a.locator('#board-canvas').boundingBox();
      const oppBox = await a.locator('#opponent-canvas').boundingBox();
      expect(selfBox).not.toBeNull();
      expect(oppBox).not.toBeNull();
      expect(selfBox!.width).toBe(300);
      // 对手棋盘约为本人的 55%～70%。
      expect(oppBox!.width / selfBox!.width).toBeGreaterThanOrEqual(0.55);
      expect(oppBox!.width / selfBox!.width).toBeLessThanOrEqual(0.7);
      expect(overlaps(selfBox, oppBox)).toBe(false);
      await expect(a.locator('#leaderboard-slot')).toBeVisible();
      await assertNoHorizontalOverflow(a);
      await a.screenshot({ path: 'evidence/multiplayer/N36/shot-desktop.png' });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('390×844：对手缩略条置顶不遮挡、触屏按键可见、无横向溢出', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    // 手机视口从建房起生效：布局挂载时的断点判定与真实手机用户一致。
    const ctxA: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const ctxB: BrowserContext = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await startMatch(a, b);
      await expect(a.locator('canvas')).toHaveCount(2);
      const selfBox = await a.locator('#board-canvas').boundingBox();
      const oppBox = await a.locator('#opponent-canvas').boundingBox();
      expect(overlaps(selfBox, oppBox)).toBe(false);
      // 手机：对手棋盘缩略在本人棋盘上方，不遮挡操作区。
      expect(oppBox!.y).toBeLessThan(selfBox!.y);
      // 触屏按键可见、可触达（≥44px）且完整位于首屏视口内（触屏按键优先）。
      await expect(a.locator('#touch-controls')).toBeVisible();
      const btn = a.locator('#touch-controls button').first();
      await expect(btn).toBeVisible();
      const btnBox = await btn.boundingBox();
      expect(btnBox).not.toBeNull();
      expect(btnBox!.width).toBeGreaterThanOrEqual(44);
      expect(btnBox!.height).toBeGreaterThanOrEqual(44);
      const touchBox = await a.locator('#touch-controls').boundingBox();
      expect(touchBox).not.toBeNull();
      const vp = a.viewportSize();
      expect(vp).not.toBeNull();
      expect(touchBox!.y + touchBox!.height).toBeLessThanOrEqual(vp!.height);
      // 触屏按键不被对手棋盘遮挡（触控区在自身游戏区之后）。
      expect(overlaps(touchBox, oppBox)).toBe(false);
      await assertNoHorizontalOverflow(a);
      await a.screenshot({ path: 'evidence/multiplayer/N36/shot-390.png' });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('320×568：无横向溢出、双棋盘可见、排行榜可折叠展开', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    const ctxA: BrowserContext = await browser.newContext({ viewport: { width: 320, height: 568 } });
    const ctxB: BrowserContext = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await startMatch(a, b);
      await expect(a.locator('canvas')).toHaveCount(2);
      await expect(a.locator('#board-canvas')).toBeVisible();
      await expect(a.locator('#opponent-canvas')).toBeVisible();
      const selfBox = await a.locator('#board-canvas').boundingBox();
      const oppBox = await a.locator('#opponent-canvas').boundingBox();
      expect(overlaps(selfBox, oppBox)).toBe(false);
      await assertNoHorizontalOverflow(a);
      // 排行榜折叠语义：手机断点默认折叠（首屏让位触屏按键），一键展开全部玩家。
      const details = a.locator('.leaderboard-details');
      await expect(details).toBeVisible();
      await expect(a.locator('#leaderboard-slot')).toBeHidden();
      await a.click('.leaderboard-summary');
      await expect(a.locator('#leaderboard-slot')).toBeVisible();
      await a.click('.leaderboard-summary');
      await expect(a.locator('#leaderboard-slot')).toBeHidden();
      // 触控区完整位于 320×568 首屏视口内。
      const touchBox = await a.locator('#touch-controls').boundingBox();
      expect(touchBox).not.toBeNull();
      expect(touchBox!.y + touchBox!.height).toBeLessThanOrEqual(568);
      await assertNoHorizontalOverflow(a);
      await a.screenshot({ path: 'evidence/multiplayer/N36/shot-320.png' });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
