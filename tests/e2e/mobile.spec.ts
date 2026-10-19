import { expect, test } from '@playwright/test';

// T058：移动 Playwright 触控闭环（规格 S04.3、S08；任务清单 T058）。
// mobile-chrome project（Pixel 7 模拟，hasTouch）；390×844 主视口 +
// 320×640 临时覆盖。全部断言用 locator / expect / expect.poll，零固定等待。

const liveStatus = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__NEON_BLOCKS__.engine.getState().status);

const liveX = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const s = window.__NEON_BLOCKS__.engine.getState();
    return s.active ? s.active.x : null;
  });

const liveScore = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__NEON_BLOCKS__.engine.getState().score);

const noHorizontalOverflow = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

test.use({ viewport: { width: 390, height: 844 } });

test('mobile touch loop at 390×844: 44px targets, no overflow, all actions', async ({ page }) => {
  await page.goto('/');

  // 无横向溢出（S04.3 响应式）。
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

  // 触控开始。
  await page.tap('#btn-start');
  await expect.poll(() => liveStatus(page)).toBe('running');
  await expect(page.locator('#btn-start')).toBeHidden();

  // 7 个虚拟键全部存在且触控目标 ≥44×44（S04.3 移动端可点性）。
  for (const key of ['left', 'right', 'down', 'hard', 'rotL', 'rotR', 'hold']) {
    const box = await page.locator(`[data-touch-key="${key}"]`).boundingBox();
    expect(box, `touch key ${key} present`).not.toBeNull();
    expect(box!.width, `touch key ${key} width>=44`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `touch key ${key} height>=44`).toBeGreaterThanOrEqual(44);
  }

  // 触控左移。
  const spawnedX = await liveX(page);
  expect(spawnedX).not.toBeNull();
  await page.tap('[data-touch-key="left"]');
  await expect.poll(() => liveX(page)).toBe((spawnedX as number) - 1);

  // 触控旋转。
  const beforeRot = await page.evaluate(() => {
    const s = window.__NEON_BLOCKS__.engine.getState();
    return s.active ? s.active.rotation : null;
  });
  await page.tap('[data-touch-key="rotR"]');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__NEON_BLOCKS__.engine.getState();
        return s.active ? s.active.rotation : null;
      }),
    )
    .not.toBe(beforeRot);

  // 触控硬降 → 分数增长。
  await page.tap('[data-touch-key="hard"]');
  await expect.poll(() => liveScore(page)).toBeGreaterThan(0);

  // 头部暂停 → 覆盖层继续钮出现 → 触控继续。
  await page.tap('#btn-pause');
  await expect(page.locator('#btn-resume')).toBeVisible();
  await expect.poll(() => liveStatus(page)).toBe('paused');
  await page.tap('#btn-resume');
  await expect.poll(() => liveStatus(page)).toBe('running');

  // 全程仍无横向溢出。
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
});

test('320×640 small viewport: no horizontal overflow before and during play', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

  await page.tap('#btn-start');
  await expect.poll(() => liveStatus(page)).toBe('running');
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

  // 游戏中（HUD 数字、虚拟键占用最大宽度）依然无溢出。
  await page.tap('[data-touch-key="left"]');
  await page.tap('[data-touch-key="hard"]');
  await expect.poll(() => liveScore(page)).toBeGreaterThan(0);
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

  // 暂停覆盖层小屏也无溢出。
  await page.tap('#btn-pause');
  await expect(page.locator('#btn-resume')).toBeVisible();
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
});
