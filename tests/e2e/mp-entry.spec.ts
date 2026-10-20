// N32：联网入口 E2E——首页分流条 → 创建/加入面板（全中文、触控目标 ≥44px、无登录）。
// 桌面（chromium）与移动（mobile-chrome）两个 project 都跑本 spec：
// 移动端额外守住「输入不卡操作」的布局底线（无横向溢出）。
// 断言全部使用 locator / expect 自动重试，不依赖固定等待。
import { expect, test } from '@playwright/test';

test('首页分流条可见且联网链接可达', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.mp-switch')).toBeVisible();
  await page.getByRole('link', { name: '联网对战' }).click();
  await expect(page).toHaveURL(/[?&]mode=multiplayer/);
  await expect(page.locator('.mp-entry-panel')).toBeVisible();
  await expect(page.getByRole('heading', { name: '联网对战' })).toBeVisible();
});

test('入口面板：中文控件齐备、无登录/密码字段', async ({ page }) => {
  await page.goto('/?mode=multiplayer');
  await expect(page.locator('#mp-nickname')).toBeVisible();
  await expect(page.locator('#mp-room-code')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
  await expect(page.getByRole('button', { name: '加入房间' })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回单人模式' })).toBeVisible();
  expect(await page.locator('input[type="password"]').count()).toBe(0);
});

test('入口面板：输入与按钮触控目标 ≥44px（移动端输入不卡操作）', async ({ page }) => {
  await page.goto('/?mode=multiplayer');
  for (const sel of ['#mp-nickname', '#mp-room-code', '#mp-create', '#mp-join']) {
    const box = await page.locator(sel).boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box!.height, sel).toBeGreaterThanOrEqual(44);
  }
  // 输入框聚焦不引发横向溢出（软键盘/滚动不破坏布局）
  await page.focus('#mp-room-code');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('本地预校验中文提示 → 合法输入走 NetClient（无服务器时中文降级）', async ({ page }) => {
  await page.goto('/?mode=multiplayer');
  await page.fill('#mp-nickname', '你好');
  await page.fill('#mp-room-code', '123456');
  await page.click('#mp-join');
  await expect(page.locator('#mp-entry-message')).toHaveText('昵称需为 1–16 位英文字母或数字。');

  await page.fill('#mp-nickname', 'alice');
  await page.fill('#mp-room-code', '012345');
  await page.click('#mp-join');
  await expect(page.locator('#mp-entry-message')).toHaveText('房间码需为 100000–999999 的 6 位数字。');

  // 合法输入：E2E 环境无 Worker（8787 未监听）→ NetClient fetch 失败 → 中文降级提示
  await page.fill('#mp-room-code', '123456');
  await page.click('#mp-join');
  await expect(page.locator('#mp-entry-message')).toHaveText('服务器暂时无法访问，请稍后再试。');
});
