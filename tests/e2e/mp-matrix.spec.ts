// N41：2～6 人功能矩阵 E2E（需本机 Worker 8787；未运行时整组跳过，CI 不受影响）。
// 每个人数 p∈{2,3,4,5,6} 完整走一遍：建房（房主改容量）→ 加入满员 → 全员准备 →
// 开赛 → 始终恰好 2 个 Canvas（无第三棋盘）→ 排行榜名单全员一致（加入顺序）→
// 观战（每人观察目标≠本人、目标帧水位>0）→ 结算（全员硬降自撞顶淘汰、只剩房主
// 即时结束、全员结果文案一致、胜者 host01）→ 下一局回大厅 → 离房（席位减一、
// 离开方回入口面板）。截图存 evidence/multiplayer/N41/。
// 负载说明：5 个矩阵用例各开 2～6 个上下文；与 mp-resilience 同跑时建议
// `--workers=2`——6 房间并发挤占单 workerd 进程时，刷新重建首帧可能超 10s 窗口
// （N41 门禁实测：默认 workers 下 mp-resilience 刷新用例偶发超时，workers=2 稳定 17/17）。
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
    return handle?.matchDebug ? handle?.matchDebug() === null : false;
  });
}

async function remoteSeqOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const handle = (window as unknown as Record<string, { matchDebug?: () => { remoteSeq: number } | null }>)
      .__NEON_BLOCKS_MP__;
    return handle?.matchDebug ? (handle.matchDebug()?.remoteSeq ?? -1) : -1;
  });
}

async function leaderboardNames(page: Page): Promise<string[]> {
  return page.locator('#leaderboard-slot .lb-name').allTextContents();
}

function nicknames(p: number): string[] {
  return Array.from({ length: p }, (_, i) => (i === 0 ? 'host01' : `guest0${i + 1}`));
}

for (const p of [2, 3, 4, 5, 6]) {
  test.describe(`N41 ${p} 人功能矩阵`, () => {
    test(`建房→准备→开赛→双棋盘→榜单一致→观战→结算→离房`, async ({ browser, request }) => {
      test.skip(!(await workerUp(request)), 'Worker(8787) 未运行');
      test.setTimeout(150_000);
      const names = nicknames(p);
      const contexts: BrowserContext[] = [];
      try {
        const pages: Page[] = [];
        for (let i = 0; i < p; i += 1) {
          const ctx = await browser.newContext();
          contexts.push(ctx);
          pages.push(await ctx.newPage());
        }
        const [host, ...guests] = pages;

        // 建房：房主先把容量调到 p（默认 4），再收满 p−1 名访客。
        await createRoom(host, names[0]);
        const code = (await host.locator('#mp-room-code-value').textContent()) as string;
        await host.selectOption('#mp-capacity', String(p));
        await host.click('#mp-apply-settings');
        for (let i = 1; i < p; i += 1) await joinRoom(pages[i], names[i], code);
        await expect(host.locator('#mp-seat-list .mp-seat')).toHaveCount(p, { timeout: LOBBY_TIMEOUT });
        // 访客端同步只读容量视图（设置广播到全员）。
        await expect(guests[guests.length - 1].locator('#mp-capacity')).toHaveValue(String(p), { timeout: LOBBY_TIMEOUT });

        // 全员准备 → 开赛。
        await readyAll(pages);
        await host.click('#mp-start');
        for (const pg of pages) {
          await expect(pg.locator('#mp-match-status')).toContainText('比赛进行中', { timeout: 10_000 });
        }

        // 始终恰好 2 个 Canvas（本人 + 对手，无第三棋盘）。
        for (const pg of pages) {
          expect(await pg.locator('canvas').count()).toBe(2);
        }

        // 排行榜名单全员一致：p 行、得分并列按加入顺序升序。
        for (const pg of pages) {
          await expect(pg.locator('#leaderboard-slot .lb-name')).toHaveCount(p, { timeout: 10_000 });
        }
        const rosters = [];
        for (const pg of pages) rosters.push(await leaderboardNames(pg));
        for (const roster of rosters) {
          expect(roster).toEqual(names); // 全员同一份、同一顺序（客户端绝不重排）
        }

        // 观战：每人观察目标为其他玩家（≠本人），且目标帧水位 >0（收到目标快照帧）。
        for (let i = 0; i < p; i += 1) {
          const others = names.filter((n) => n !== names[i]);
          const opp = await pages[i].locator('#opponent-name').textContent();
          expect(opp).not.toBeNull();
          expect(others).toContain(opp as string);
          await expect
            .poll(async () => remoteSeqOf(pages[i]), { timeout: 5_000 })
            .toBeGreaterThan(0);
        }

        // 结算：全部访客硬降自撞顶（真实 topout→gameover 上报）→ 只剩房主即时结束。
        for (const g of guests) {
          for (let i = 0; i < 40; i += 1) await g.keyboard.press('Space');
        }
        for (const pg of pages) {
          await expect(pg.locator('#mp-results')).toBeVisible({ timeout: 15_000 });
        }
        const titles = [];
        const winners = [];
        for (const pg of pages) {
          titles.push(await pg.locator('.mp-results-title').innerText());
          winners.push(await pg.locator('.mp-results-winners').innerText());
        }
        for (const t of titles) expect(t).toBe('比赛结束'); // 全员结果文案完全一致
        for (const w of winners) expect(w).toBe(`胜者：${names[0]}`);
        // 结算面板在场时仍严格 2 个 Canvas。
        for (const pg of pages) {
          expect(await pg.locator('canvas').count()).toBe(2);
        }
        // 淘汰方榜单状态「已淘汰」（访客行），房主行非淘汰。
        await expect(guests[0].locator('#leaderboard-slot tr', { hasText: names[1] }).locator('td').nth(4)).toHaveText('已淘汰');
        await expect(host.locator('#leaderboard-slot tr', { hasText: names[0] }).locator('td').nth(4)).not.toHaveText('已淘汰');

        // 截图：p 人局结果面板（房主端）。
        await host.screenshot({ path: `evidence/multiplayer/N41/shot-matrix-${p}.png` });

        // 下一局：房主专属入口 → 全员回大厅（房间码不变、对局句柄 null）。
        await expect(host.locator('#mp-next-round')).toBeVisible();
        expect(await guests[0].locator('#mp-next-round').count()).toBe(0);
        await host.click('#mp-next-round');
        for (const pg of pages) {
          await expect(pg.locator('#mp-lobby')).toBeVisible({ timeout: LOBBY_TIMEOUT });
          await expect(pg.locator('#mp-room-code-value')).toHaveText(code);
          expect(await matchDebugNull(pg)).toBe(true);
        }

        // 离房：guest02 确认离开 ⇒ 回入口面板；房主席位减一、房间码不变。
        contexts[1].on('dialog', (d) => void d.accept());
        await guests[0].click('#mp-leave');
        await expect(guests[0].locator('.mp-entry-panel')).toBeVisible({ timeout: LOBBY_TIMEOUT });
        await expect(host.locator('#mp-seat-list .mp-seat')).toHaveCount(p - 1, { timeout: LOBBY_TIMEOUT });
        await expect(host.locator('#mp-room-code-value')).toHaveText(code);
      } finally {
        for (const ctx of contexts) await ctx.close();
      }
    });
  });
}
