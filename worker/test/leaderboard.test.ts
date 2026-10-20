// N27：统一积分排行榜纯函数——分数降序、同分并列名次（跳号）、消行/加入序
// 仅稳定显示顺序；死人留榜分数固定；输入顺序无关（全员恒得同一份榜单）。
import { describe, expect, it } from 'vitest';
import type { PlayerStatus } from '../../shared/protocol';
import { buildLeaderboard, topScorePlayerIds, type LeaderboardRow } from '../src/leaderboard';

function row(
  playerId: string,
  score: number,
  lines: number,
  joinOrder: number,
  status: PlayerStatus = 'playing',
  nickname = `n_${playerId}`,
): LeaderboardRow {
  return { playerId, nickname, score, lines, joinOrder, status };
}

describe('N27 统一积分排行榜', () => {
  it('方案 §6 例：2000/1400/900/900/500/300 → 得分降序 + 竞赛排名跳号', () => {
    const entries = buildLeaderboard([
      row('A', 900, 4, 1),
      row('B', 1400, 7, 2),
      row('C', 300, 1, 3),
      row('D', 900, 4, 4),
      row('E', 2000, 10, 5),
      row('F', 500, 2, 6),
    ]);
    expect(entries.map((e) => e.playerId)).toEqual(['E', 'B', 'A', 'D', 'F', 'C']);
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3, 3, 5, 6]);
  });

  it('并列只看分数：同分不同消行共享名次，消行仅决定显示顺序', () => {
    const entries = buildLeaderboard([
      row('X', 900, 3, 1),
      row('Y', 900, 9, 2),
      row('Z', 900, 9, 3),
    ]);
    expect(entries.map((e) => e.playerId)).toEqual(['Y', 'Z', 'X']); // 消行降序→加入序升序
    expect(entries.map((e) => e.rank)).toEqual([1, 1, 1]);
  });

  it('死人继续显示：淘汰者留榜、分数固定、可列榜首（得分第一≠胜者）', () => {
    const entries = buildLeaderboard([
      row('dead', 1500, 8, 1, 'eliminated'),
      row('alive', 1200, 6, 2, 'playing'),
    ]);
    expect(entries[0]).toMatchObject({ playerId: 'dead', score: 1500, status: 'eliminated', rank: 1 });
    expect(entries[1]).toMatchObject({ playerId: 'alive', status: 'playing', rank: 2 });
  });

  it('断线宽限期显示 disconnected：状态原样携带，不影响排序', () => {
    const entries = buildLeaderboard([
      row('a', 100, 0, 1),
      row('b', 200, 1, 2, 'disconnected'),
    ]);
    expect(entries.map((e) => [e.playerId, e.status])).toEqual([
      ['b', 'disconnected'],
      ['a', 'playing'],
    ]);
  });

  it('输入顺序无关：任意乱序恒得同一份榜单（全员同 revision 的前提）', () => {
    const base = [
      row('p1', 900, 4, 1),
      row('p2', 900, 4, 2),
      row('p3', 2000, 10, 3, 'eliminated'),
      row('p4', 0, 0, 4),
      row('p5', 500, 2, 5, 'disconnected'),
      row('p6', 500, 3, 6),
    ];
    const canonical = buildLeaderboard(base);
    const perm1 = [base[3], base[0], base[5], base[2], base[4], base[1]];
    const perm2 = [...base].reverse();
    expect(buildLeaderboard(perm1)).toEqual(canonical);
    expect(buildLeaderboard(perm2)).toEqual(canonical);
    // 无观看者参数：函数签名本身即排除「按自己名字/观察目标重排」。
    expect(buildLeaderboard.length).toBe(1);
  });

  it('负向：消行与加入序不得翻转分数次序；单条 rank=1；空输入空输出', () => {
    const entries = buildLeaderboard([
      row('hi_lines_low_score', 100, 99, 1),
      row('lo_lines_high_score', 200, 0, 2),
    ]);
    expect(entries.map((e) => e.playerId)).toEqual(['lo_lines_high_score', 'hi_lines_low_score']);
    expect(buildLeaderboard([row('solo', 0, 0, 1)])).toEqual([
      { playerId: 'solo', nickname: 'n_solo', score: 0, lines: 0, rank: 1, status: 'playing' },
    ]);
    expect(buildLeaderboard([])).toEqual([]);
  });

  it('topScorePlayerIds：并列得分第一可多人；与生存赛胜者语义独立', () => {
    const entries = buildLeaderboard([
      row('a', 900, 4, 1, 'eliminated'),
      row('b', 900, 5, 2, 'playing'),
      row('c', 100, 0, 3),
    ]);
    expect(topScorePlayerIds(entries)).toEqual(['b', 'a']); // 显示顺序内并列共享得分第一
    // 顺序无关（复审 O1）：乱序输入仍得同一集合。
    expect(topScorePlayerIds([entries[2], entries[0], entries[1]]).sort()).toEqual(['a', 'b']);
    expect(topScorePlayerIds([])).toEqual([]);
  });
});
