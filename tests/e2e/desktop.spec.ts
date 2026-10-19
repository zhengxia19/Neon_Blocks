import { expect, test } from '@playwright/test';

// T057：桌面 Playwright 游戏闭环（规格 S08；任务清单 T057）。
// 断言全部使用 locator / expect / expect.poll 自动重试，不依赖固定等待。
// 引擎状态经 window.__NEON_BLOCKS__ 调试句柄只读点读（main.ts 装配）。

interface LiveState {
  status: string;
  score: number;
  lines: number;
  level: number;
  x: number | null;
  y: number | null;
  rotation: number | null;
  type: string | null;
}

async function liveState(page: import('@playwright/test').Page): Promise<LiveState> {
  return page.evaluate(() => {
    const s = window.__NEON_BLOCKS__.engine.getState();
    return {
      status: s.status,
      score: s.score,
      lines: s.lines,
      level: s.level,
      x: s.active ? s.active.x : null,
      y: s.active ? s.active.y : null,
      rotation: s.active ? s.active.rotation : null,
      type: s.active ? s.active.type : null,
    };
  });
}

test('desktop loop: ready → start → move/rotate → hard drop scores → pause → resume → restart', async ({ page }) => {
  await page.goto('/');

  // 初始 READY：开始按钮与棋盘可见，状态 ready。
  await expect(page.locator('#btn-start')).toBeVisible();
  await expect(page.locator('#board-canvas')).toBeVisible();
  // 高分屏 backing store = CSS 尺寸 × min(dpr,2)（S05，桌面 dpr=1 → 300）。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.getElementById('board-canvas') as HTMLCanvasElement;
        const scale = Math.min(window.devicePixelRatio, 2);
        const box = canvas.getBoundingClientRect();
        return (
          canvas.width === Math.round(box.width * scale) &&
          canvas.height === Math.round(box.height * scale)
        );
      }),
    )
    .toBe(true);
  await expect.poll(() => liveState(page).then((s) => s.status)).toBe('ready');

  // 点击开始 → running，READY 覆盖层隐藏。
  await page.click('#btn-start');
  await expect.poll(() => liveState(page).then((s) => s.status)).toBe('running');
  await expect(page.locator('#btn-start')).toBeHidden();

  // 左右移动：出生块左侧恒有净空，一步必然成功。
  const spawned = await liveState(page);
  expect(spawned.type).not.toBeNull();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => liveState(page).then((s) => s.x)).toBe((spawned.x as number) - 1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => liveState(page).then((s) => s.x)).toBe(spawned.x as number);

  // 旋转：出生位置净空充足，任何方块顺时针一步必然改变 rotation。
  const beforeRotate = await liveState(page);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => liveState(page).then((s) => s.rotation)).not.toBe(beforeRotate.rotation);

  // 硬降：score 增加且 HUD 六位读数与引擎一致。
  await page.keyboard.press('Space');
  await expect.poll(() => liveState(page).then((s) => s.score)).toBeGreaterThan(0);
  const scored = await liveState(page);
  await expect(page.locator('#score-value')).toHaveText(
    String(scored.score).padStart(6, '0'),
  );

  // P 暂停 → PAUSED 覆盖层出现；点击继续 → 恢复运行。
  await page.keyboard.press('KeyP');
  await expect(page.locator('#btn-resume')).toBeVisible();
  await expect.poll(() => liveState(page).then((s) => s.status)).toBe('paused');
  const pausedScore = (await liveState(page)).score;
  await page.click('#btn-resume');
  await expect.poll(() => liveState(page).then((s) => s.status)).toBe('running');
  await expect(page.locator('#btn-resume')).toBeHidden();

  // 重开：暂停 → 重新开始（原生确认接受）→ running 且分数清零。
  await page.click('#btn-pause');
  await expect(page.locator('#btn-restart')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.click('#btn-restart');
  await expect.poll(() => liveState(page).then((s) => s.status)).toBe('running');
  await expect.poll(() => liveState(page).then((s) => s.score)).toBe(0);
  expect(pausedScore).toBeGreaterThan(0);
});

test('desktop loop: restart confirm cancel keeps state', async ({ page }) => {
  await page.goto('/');
  await page.click('#btn-start');
  // 覆盖层在下一渲染帧关闭；等待其隐藏再按键，避免焦点仍在可见 dialog 内时
  // 输入卫生策略（对话框不劫持）吞掉 Space（设计使然，非缺陷）。
  await expect(page.locator('#btn-start')).toBeHidden();
  await page.keyboard.press('Space');
  await expect.poll(() => liveState(page).then((s) => s.score)).toBeGreaterThan(0);
  const scoreBefore = (await liveState(page)).score;
  await page.click('#btn-pause');
  await expect(page.locator('#btn-restart')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.click('#btn-restart');
  // 取消重开：状态保持 paused、分数不变（S06 防意外重开）。
  await expect.poll(() => liveState(page).then((s) => s.status)).toBe('paused');
  await expect(page.locator('#btn-resume')).toBeVisible();
  expect((await liveState(page)).score).toBe(scoreBefore);
});

test('settings sound/ghost persist across reload', async ({ page }) => {
  await page.goto('/');

  // 默认：Ghost 开、音效关（静音默认）。
  await page.click('#btn-settings');
  await expect(page.locator('#set-ghost')).toBeVisible();
  await expect(page.locator('#set-ghost')).toBeChecked();
  await expect(page.locator('#set-sound')).not.toBeChecked();

  // 关闭 Ghost → 落盘；关闭设置保持 paused（不自动恢复）。
  await page.click('#set-ghost');
  await expect(page.locator('#set-ghost')).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('neon-blocks:v1:settings') ?? '{}')))
    .toEqual({ soundEnabled: false, ghostEnabled: false, reducedMotion: false });
  await page.click('#btn-settings-close');

  // 刷新后重新打开：设置逐项回显（跨刷新持久，S07）。
  await page.reload();
  await page.click('#btn-settings');
  await expect(page.locator('#set-ghost')).not.toBeChecked();
  await expect(page.locator('#set-sound')).not.toBeChecked();
  await expect(page.locator('#set-reduced')).not.toBeChecked();
});
