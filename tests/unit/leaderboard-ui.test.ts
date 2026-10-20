// N37 — 全员统一排行榜组件单测（方案 §5）。
// 纯函数直测（顺序照抄/并列名次/本人高亮/胜者独立）+ DOM 部分源码结构断言。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LeaderboardEntry } from '../../shared/protocol';
import { buildRows, statusLabel, winnersSummary } from '../../src/ui/leaderboard';

const SRC = {
  leaderboard: readFileSync(new URL('../../src/ui/leaderboard.ts', import.meta.url), 'utf8'),
};

function entry(over: Partial<LeaderboardEntry> & { playerId: string }): LeaderboardEntry {
  return { nickname: over.playerId, score: 0, lines: 0, rank: 1, status: 'playing', ...over };
}

describe('N37 排行榜组件（纯函数）', () => {
  it('statusLabel：六种服务端状态映射中文文案', () => {
    expect(statusLabel('lobby')).toBe('等待中');
    expect(statusLabel('ready')).toBe('已准备');
    expect(statusLabel('playing')).toBe('比赛中');
    expect(statusLabel('disconnected')).toBe('连接中断');
    expect(statusLabel('eliminated')).toBe('已淘汰');
    expect(statusLabel('finished')).toBe('已结束');
  });

  it('逐行照抄服务端顺序与名次（客户端不排序、不算名次）', () => {
    // 服务端榜单：分数降序 + 并列名次（1,1,3）。
    const entries = [
      entry({ playerId: 'p_a', score: 1400, lines: 8, rank: 1 }),
      entry({ playerId: 'p_b', score: 900, lines: 5, rank: 2 }),
      entry({ playerId: 'p_c', score: 900, lines: 5, rank: 2 }),
      entry({ playerId: 'p_d', score: 300, lines: 1, rank: 4, status: 'eliminated' }),
    ];
    const rows = buildRows(entries, 'p_c');
    expect(rows.map((r) => r.playerId)).toEqual(['p_a', 'p_b', 'p_c', 'p_d']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(rows.map((r) => r.score)).toEqual([1400, 900, 900, 300]);
    expect(rows.map((r) => r.statusLabel)).toEqual(['比赛中', '比赛中', '比赛中', '已淘汰']);
    // 本人仅高亮：只有 selfId 行 isSelf，顺序不变。
    expect(rows.map((r) => r.isSelf)).toEqual([false, false, true, false]);
  });

  it('反向：输入乱序也照抄（证明客户端绝不重排）', () => {
    const entries = [
      entry({ playerId: 'p_low', score: 100, rank: 3 }),
      entry({ playerId: 'p_high', score: 999, rank: 1 }),
    ];
    expect(buildRows(entries, null).map((r) => r.playerId)).toEqual(['p_low', 'p_high']);
  });

  it('终局：已淘汰者留榜分数固定，胜者仅标记不改行序', () => {
    // 服务端终局榜单（得分降序、名次 1/2/3）：得分第一 p_w ≠ 生存赛胜者 p_s。
    const entries = [
      entry({ playerId: 'p_w', score: 2000, rank: 1, status: 'finished' }),
      entry({ playerId: 'p_e', score: 1800, rank: 2, status: 'eliminated' }),
      entry({ playerId: 'p_s', score: 1500, rank: 3, status: 'finished' }),
    ];
    const rows = buildRows(entries, 'p_e', ['p_s']);
    expect(rows.map((r) => r.playerId)).toEqual(['p_w', 'p_e', 'p_s']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.isWinner)).toEqual([false, false, true]);
    expect(rows.map((r) => r.isSelf)).toEqual([false, true, false]);
    expect(rows.map((r) => r.statusLabel)).toEqual(['已结束', '已淘汰', '已结束']);
  });

  it('winnersSummary：按榜单顺序取昵称，无胜者/未知 id 为空串', () => {
    const entries = [
      entry({ playerId: 'p_a', nickname: '阿明', score: 10, rank: 1 }),
      entry({ playerId: 'p_b', nickname: '小云', score: 5, rank: 2 }),
    ];
    expect(winnersSummary(entries, ['p_b', 'p_a'])).toBe('本局胜者：阿明、小云');
    expect(winnersSummary(entries, [])).toBe('');
    expect(winnersSummary(entries, ['p_unknown'])).toBe('');
  });

  it('未知 winnerId 不影响任何行标记', () => {
    const rows = buildRows([entry({ playerId: 'p_a' })], null, ['p_ghost']);
    expect(rows[0]?.isWinner).toBe(false);
  });
});

describe('N37 排行榜组件（DOM 结构）', () => {
  it('createLeaderboardView：textContent 渲染、本人行 lb-self、胜者横幅独立', () => {
    expect(SRC.leaderboard).toContain('export function createLeaderboardView');
    expect(SRC.leaderboard).toContain("banner.className = 'lb-winners'");
    expect(SRC.leaderboard).toContain("tr.className = 'lb-self'");
    expect(SRC.leaderboard).toContain("setAttribute('aria-current', 'true')");
    expect(SRC.leaderboard).toContain("classList.add('lb-winner')");
    expect(SRC.leaderboard).toContain('replaceChildren()');
  });

  it('反向：无网络/无 innerHTML/无客户端排序与名次计算', () => {
    expect(SRC.leaderboard).not.toMatch(/fetch\(|WebSocket|XMLHttpRequest/);
    expect(SRC.leaderboard).not.toContain('innerHTML');
    expect(SRC.leaderboard).not.toMatch(/\.sort\(|\.toSorted\(/);
    expect(SRC.leaderboard).not.toMatch(/Date\.now|Math\.random/);
  });
});
