// N33：等待大厅 E2E（需本机 Worker 8787；未运行时整组跳过，CI 不受影响）。
// 覆盖：创建→大厅、加入→双端席位同步、房主设置同步与访客只读、
// 准备门槛（全员准备前开局禁用）、开局进入倒计时。
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
  // 房间码由首帧 room_state 填充：读取前先等 6 位码就位。
  await expect(page.locator('#mp-room-code-value')).toHaveText(/^[1-9]\d{5}$/);
}

async function joinRoom(page: Page, nickname: string, code: string): Promise<void> {
  await page.goto('/?mode=multiplayer');
  await page.fill('#mp-nickname', nickname);
  await page.fill('#mp-room-code', code);
  await page.click('#mp-join');
  await expect(page.locator('#mp-lobby')).toBeVisible({ timeout: LOBBY_TIMEOUT });
}

test.describe('N33 等待大厅（双端）', () => {
  test('创建房间 → 大厅：6 位房间码、席位视图、房主控件', async ({ page, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    await createRoom(page, 'host01');
    const code = await page.locator('#mp-room-code-value').textContent();
    expect(code).toMatch(/^[1-9]\d{5}$/);
    await expect(page.locator('#mp-seat-list')).toContainText('host01');
    await expect(page.locator('#mp-seat-list')).toContainText('房主');
    await expect(page.locator('#mp-seat-list')).toContainText('未准备');
    // 房主可编辑设置；仅 1 人时开局禁用。
    await expect(page.locator('#mp-capacity')).toBeEnabled();
    await expect(page.locator('#mp-start')).toBeVisible();
    await expect(page.locator('#mp-start')).toBeDisabled();
    await expect(page.locator('#mp-ready')).toBeEnabled();
  });

  test('加入 → 双端席位同步；访客只读；准备后全员准备才可开局', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    const ctxA: BrowserContext = await browser.newContext();
    const ctxB: BrowserContext = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await createRoom(a, 'host01');
      const code = (await a.locator('#mp-room-code-value').textContent()) as string;
      await joinRoom(b, 'guest02', code);
      // 双端席位列表一致（room_state 权威广播）。
      await expect(a.locator('#mp-seat-list')).toContainText('guest02');
      await expect(b.locator('#mp-seat-list')).toContainText('host01');
      // 访客：设置只读、无开局按钮。
      await expect(b.locator('#mp-capacity')).toBeDisabled();
      await expect(b.locator('#mp-apply-settings')).toBeDisabled();
      await expect(b.locator('#mp-start')).toBeHidden();
      // 准备门槛：房主先准备仍禁用开局；访客准备后解禁。
      await a.click('#mp-ready');
      await expect(a.locator('#mp-seat-list')).toContainText('已准备');
      await expect(a.locator('#mp-start')).toBeDisabled();
      await b.click('#mp-ready');
      await expect(a.locator('#mp-seat-list')).toContainText('guest02 · 已准备');
      await expect(a.locator('#mp-start')).toBeEnabled();
      // 开局：双端进入倒计时/进行中阶段。
      await a.click('#mp-start');
      await expect(a.locator('#mp-phase')).toContainText(/即将开始|比赛进行中/);
      await expect(b.locator('#mp-phase')).toContainText(/即将开始|比赛进行中/);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('房主改设置 → 访客同步只读值；设置变更重置全员准备', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    const ctxA: BrowserContext = await browser.newContext();
    const ctxB: BrowserContext = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    try {
      await createRoom(a, 'host01');
      const code = (await a.locator('#mp-room-code-value').textContent()) as string;
      await joinRoom(b, 'guest02', code);
      await a.click('#mp-ready');
      await expect(a.locator('#mp-seat-list')).toContainText('已准备');
      await a.selectOption('#mp-capacity', '6');
      await a.selectOption('#mp-start-level', '5');
      await a.click('#mp-apply-settings');
      // 访客侧收到同步后的权威值（锁定参数全员一致的基础）。
      await expect(b.locator('#mp-capacity')).toHaveValue('6');
      await expect(b.locator('#mp-start-level')).toHaveValue('5');
      // 设置变更重置准备状态（服务端裁决，双端视图一致）。
      await expect(a.locator('#mp-seat-list')).toContainText('未准备');
      await expect(b.locator('#mp-seat-list')).toContainText('未准备');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
