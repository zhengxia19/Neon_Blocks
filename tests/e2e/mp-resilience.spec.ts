// N40（a/b）：失焦/刷新/断网语义 E2E（需本机 Worker 8787；未运行时整组跳过，CI 不受影响）。
// 覆盖：失焦不停比赛时钟（剩余时间照常递减）；对局期刷新自动重连并按缓存
// match_start 重建（快照 seq 从服务端高水位续起→对手端 remoteSeq 3 秒内续增；
// 重建方以首帧采纳观察目标→对手面板恢复）；断网⇒遮罩+冻结+服务端榜单「连接中断」、
// 网络恢复退避内自动重连解冻续跑；大厅期刷新自动重连回同一房间。
// 30 秒宽限淘汰由服务端 Alarm 裁决（worker 测试覆盖）。
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const API = process.env.VITE_MULTIPLAYER_API_URL ?? 'http://127.0.0.1:8787';

async function workerUp(request: { get(url: string, init?: { timeout?: number }): Promise<{ ok(): boolean }> }): Promise<boolean> {
  try {
    const res = await request.get(`${API}/api/health`, { timeout: 8000 });
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
  await expect(page.locator('#mp-room-code-value')).toHaveText(/^[1-9]\d{5}$/, { timeout: LOBBY_TIMEOUT });
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

function parseRemaining(label: string | null): number {
  const m = /剩余 (\d{2}):(\d{2})/.exec(label ?? '');
  return m === null ? -1 : Number(m[1]) * 60 + Number(m[2]);
}

async function matchDebugOf(
  page: Page,
): Promise<{ watchTargetId: string | null; remoteSeq: number } | null> {
  return page.evaluate(() => {
    const handle = (window as unknown as Record<string, { matchDebug?: () => unknown | null }>)
      .__NEON_BLOCKS_MP__;
    return handle?.matchDebug ? (handle.matchDebug() as never) ?? null : null;
  });
}

test.describe('N40 失焦、刷新与断网恢复', () => {
  test('失焦不停时钟；对局期刷新自动重连重建（seq 高水位续起）', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    test.setTimeout(120_000);
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
      for (const p of pages) {
        await expect(p.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: 10_000 });
      }

      // 失焦（blur）：联网对局禁个人暂停，比赛时钟不得停止——剩余时间照常递减。
      const before = parseRemaining(await host.locator('#mp-match-status').textContent());
      expect(before).toBeGreaterThanOrEqual(500);
      await host.evaluate(() => window.dispatchEvent(new Event('blur')));
      await host.waitForTimeout(3000);
      const after = parseRemaining(await host.locator('#mp-match-status').textContent());
      expect(after).toBeLessThanOrEqual(before - 2);

      // 对局期刷新：席位凭据自动重连（不再出现入口面板），按缓存 match_start
      // 重建对局（同席位种子/等级），状态行续跑。
      const seqBefore = (await matchDebugOf(host))?.remoteSeq ?? -1;
      await guest.reload();
      await expect(guest.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: LOBBY_TIMEOUT });
      expect(await guest.locator('.mp-entry-panel').count()).toBe(0);
      expect(await matchDebugOf(guest)).not.toBeNull();

      // 快照 seq 从 sessionStorage 高水位续起：对手端 3 秒内收到续增帧
      // （若归零重发会被服务端水位拒收，约 6 秒后才恢复）。
      await expect
        .poll(async () => (await matchDebugOf(host))?.remoteSeq ?? -1, { timeout: 3000 })
        .toBeGreaterThan(seqBefore);
      // 复审 N40-a P1：重建方服务端不补发 watch_target（订阅映射跨断线存活）⇒
      // 客户端须以首帧采纳观察目标：guest 端对手面板数秒内恢复对手昵称/状态，
      // 且 guest 的 remoteSeq 续增（未修复则恒「等待对手…」且水位停在 -1/0）。
      await expect(guest.locator('#opponent-name')).toHaveText('host01', { timeout: LOBBY_TIMEOUT });
      await expect(guest.locator('#opponent-status')).toHaveText('比赛中', { timeout: LOBBY_TIMEOUT });
      await expect
        .poll(async () => (await matchDebugOf(guest))?.remoteSeq ?? -1, { timeout: 3000 })
        .toBeGreaterThan(0);
      // 房间码不变（同一房间，非重新加入新房间）由场景 2 的大厅断言有效覆盖。
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });

  test('断网：遮罩+冻结、服务端榜单「连接中断」、网络恢复退避内重连解冻续跑', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    test.setTimeout(120_000);
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
      for (const p of pages) {
        await expect(p.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: 10_000 });
      }

      // 断网注入：route 阻断全部 API（重连票据 POST 一律 reject）+ 应用侧断线。
      // Chromium setOffline 不拆既有 WS、workerd Hibernation 不回显 close 帧
      // （浏览器 close 事件永不到达）——见 evidence/multiplayer/N40-b/README。
      await host.route('**/api/**', (route) => route.abort());
      await host.evaluate(() => {
        const handle = (window as unknown as Record<string, { debugDropSocket?: () => void }>)
          .__NEON_BLOCKS_MP__;
        handle?.debugDropSocket?.();
      });

      // 客户端：遮罩出现 + 对局冻结（状态行断连文案，棋盘不步进）。
      await expect(host.locator('#mp-conn-overlay')).toBeVisible({ timeout: 10_000 });
      await expect(host.locator('#mp-conn-overlay')).toContainText('连接中断');
      await expect(host.locator('#mp-match-status')).toHaveText('连接中断，比赛仍在服务器进行……');

      // 服务端：宽限期内标记断线 ⇒ 对手榜单显示「连接中断」（close 帧真实到达）。
      await expect(
        guest.locator('#leaderboard-slot tr', { hasText: 'host01' }).locator('td').nth(4),
      ).toHaveText('连接中断', { timeout: 10_000 });

      // 断线期间：重连尝试被 route 拒（fetch reject）⇒ 退避继续，遮罩不静默消失
      // （N40-b 修复前重连链在首个失败后即死，此断言同时钉死修复生效）。
      await host.waitForTimeout(8_000);
      await expect(host.locator('#mp-conn-overlay')).toBeVisible();

      // 网络恢复：退避 ≤8s 内下一次尝试成功 ⇒ 遮罩消失、状态行续跑、时钟已续减。
      await host.unroute('**/api/**');
      await expect(host.locator('#mp-conn-overlay')).toBeHidden({ timeout: 25_000 });
      await expect(host.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: 10_000 });
      expect(parseRemaining(await host.locator('#mp-match-status').textContent())).toBeLessThan(590);
      // 对手榜单状态恢复（scoreboard 重估广播）。
      await expect(
        guest.locator('#leaderboard-slot tr', { hasText: 'host01' }).locator('td').nth(4),
      ).not.toHaveText('连接中断', { timeout: 10_000 });
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });

  test('大厅期刷新：自动重连回同一房间（无入口面板）', async ({ browser, request }) => {
    test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
    test.setTimeout(90_000);
    const contexts: BrowserContext[] = [];
    try {
      const host = await (await browser.newContext()).newPage();
      contexts.push(host.context());
      const guestCtx = await browser.newContext();
      contexts.push(guestCtx);
      const guest = await guestCtx.newPage();
      await createRoom(host, 'host01');
      const code = (await host.locator('#mp-room-code-value').textContent()) as string;
      await joinRoom(guest, 'guest02', code);

      // 刷新 ⇒ 凭据自动重连：直接回大厅（房间码相同），入口面板不出现。
      await guest.reload();
      await expect(guest.locator('#mp-lobby')).toBeVisible({ timeout: LOBBY_TIMEOUT });
      await expect(guest.locator('#mp-room-code-value')).toHaveText(code, { timeout: LOBBY_TIMEOUT });
      expect(await guest.locator('.mp-entry-panel').count()).toBe(0);

      // 服务端席位保持：房主端仍见 guest02（可继续准备开局）。
      await expect(host.locator('#mp-lobby')).toContainText('guest02');
      await readyAll([host, guest]);
      await host.click('#mp-start');
      await expect(guest.locator('#mp-match-status')).toContainText(/比赛进行中 · 剩余 \d{2}:\d{2}/, { timeout: 10_000 });
    } finally {
      for (const ctx of contexts) await ctx.close();
    }
  });
});
