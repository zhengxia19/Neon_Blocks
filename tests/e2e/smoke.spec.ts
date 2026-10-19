import { expect, test } from '@playwright/test';

// T005：最小 E2E smoke——页面可加载且 <body> 可见。
// 该 spec 在 chromium 与 mobile-chrome 两个 project 中都会执行。
// 说明：当前页面是空骨架（#app 无内容、无样式），<body> 高度为 0，
// Playwright 的 toBeVisible()（要求非空 bounding box）必然失败。
// 因此本任务对“body 可见”的验证 = 已挂载 + CSS 可见（非 display:none / visibility:hidden）+ 标题正确；
// 真实视觉可见性（bounding box）在 T035 布局落地后由 T057/T058 E2E 断言。
test('page loads and body is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toBeAttached();
  await expect(page.locator('body')).toHaveCSS('display', 'block');
  await expect(page.locator('body')).toHaveCSS('visibility', 'visible');
  await expect(page).toHaveTitle('霓虹方块');
});
