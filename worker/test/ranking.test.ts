// N19：生存赛最终名次（已死高分不夺冠、并列显式表达、淘汰时间排序、
// 胜者独立、确定性）。与 N27 排行榜排序相互独立。
import { describe, expect, it } from 'vitest';
import { computeFinalRanking, type RankInput } from '../src/ranking';

function p(
  playerId: string,
  joinOrder: number,
  eliminatedAt: number | null,
  score: number,
  lines: number,
): RankInput {
  return { playerId, nickname: `n_${playerId}`, joinOrder, eliminatedAt, score, lines };
}

describe('N19 终局名次', () => {
  it('已死高分不夺冠：被淘汰 5000 分排在存活 100 分之后且无 placement', () => {
    const { standings, winners } = computeFinalRanking([
      p('dead', 1, 10_000, 5000, 50),
      p('alive', 2, null, 100, 1),
    ]);
    expect(winners).toEqual(['alive']);
    expect(standings.map((s) => s.playerId)).toEqual(['alive', 'dead']);
    expect(standings[0].placement).toBe(1);
    expect(standings[1].placement).toBeNull(); // 已淘汰无数值名次，仅顺序表达
    expect(standings[1].eliminatedAt).toBe(10_000);
  });

  it('超时存活者排序：分数降序 → 消行数降序', () => {
    const { standings, winners } = computeFinalRanking([
      p('a', 1, null, 900, 10),
      p('b', 2, null, 900, 12),
      p('c', 3, null, 1000, 5),
    ]);
    expect(standings.map((s) => s.playerId)).toEqual(['c', 'b', 'a']);
    expect(standings.map((s) => s.placement)).toEqual([1, 2, 3]);
    expect(winners).toEqual(['c']);
  });

  it('完全并列显式表达：同分同消行 → 并列第一双胜者，后续跳号（竞赛排名）', () => {
    const { standings, winners } = computeFinalRanking([
      p('a', 2, null, 900, 10),
      p('b', 1, null, 900, 10),
      p('c', 3, null, 800, 9),
    ]);
    // 显示顺序按加入顺序稳定（b 先），但名次并列不暗判 ID。
    expect(standings.map((s) => s.playerId)).toEqual(['b', 'a', 'c']);
    expect(standings.map((s) => s.placement)).toEqual([1, 1, 3]);
    expect(winners.slice().sort()).toEqual(['a', 'b']);
  });

  it('已淘汰者按存活时间从长到短：晚淘汰者靠前，无视分数差', () => {
    const { standings } = computeFinalRanking([
      p('early_high', 1, 100, 9999, 40),
      p('late_low', 2, 200, 10, 0),
    ]);
    expect(standings.map((s) => s.playerId)).toEqual(['late_low', 'early_high']);
    expect(standings.every((s) => s.placement === null)).toBe(true);
  });

  it('同一时刻淘汰按分数、消行数排列', () => {
    const { standings } = computeFinalRanking([
      p('a', 1, 300, 500, 5),
      p('b', 2, 300, 500, 8),
      p('c', 3, 300, 600, 1),
    ]);
    expect(standings.map((s) => s.playerId)).toEqual(['c', 'b', 'a']);
  });

  it('零存活（极端同时淘汰）：最晚时刻组内分数高者独胜', () => {
    const { standings, winners } = computeFinalRanking([
      p('a', 1, 300, 100, 2),
      p('b', 2, 300, 200, 1),
      p('c', 3, 200, 9999, 30),
    ]);
    expect(winners).toEqual(['b']); // 最晚时刻(300)组内分数最高
    expect(standings.map((s) => s.playerId)).toEqual(['b', 'a', 'c']);
  });

  it('零存活完全同条件：最晚时刻同分同消行 → 并列多胜者', () => {
    const { winners } = computeFinalRanking([
      p('a', 2, 300, 100, 2),
      p('b', 1, 300, 100, 2),
      p('c', 3, 200, 100, 2), // 更早淘汰不并列
    ]);
    expect(winners.slice().sort()).toEqual(['a', 'b']);
  });

  it('六人混合完整名次：存活段竞赛排名 + 淘汰段时刻排序', () => {
    const inputs = [
      p('s1', 1, null, 1200, 15),
      p('s2', 2, null, 1200, 15), // 与 s1 完全并列
      p('s3', 3, null, 700, 9),
      p('e1', 4, 500, 400, 6),
      p('e2', 5, 400, 800, 10), // 分数更高但更早淘汰 → 靠后
      p('e3', 6, 400, 800, 12), // 与 e2 同时刻，消行更多 → 靠前
    ];
    const { standings, winners } = computeFinalRanking(inputs);
    expect(standings.map((s) => s.playerId)).toEqual(['s1', 's2', 's3', 'e1', 'e3', 'e2']);
    expect(standings.map((s) => s.placement)).toEqual([1, 1, 3, null, null, null]);
    expect(winners.slice().sort()).toEqual(['s1', 's2']);
  });

  it('确定性：输入乱序输出完全一致（不依赖到包/入参顺序）', () => {
    const base = [
      p('a', 1, null, 900, 10),
      p('b', 2, null, 900, 10),
      p('c', 3, 100, 500, 5),
      p('d', 4, 200, 500, 5),
      p('e', 5, 200, 500, 4),
    ];
    const shuffled = [base[3], base[0], base[4], base[2], base[1]];
    expect(computeFinalRanking(shuffled)).toEqual(computeFinalRanking(base));
  });

  it('纯函数与边界：不改动入参；空输入空结果；单人局独胜', () => {
    const input = [p('solo', 1, null, 0, 0)];
    const snapshot = JSON.stringify(input);
    const res = computeFinalRanking(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(res.winners).toEqual(['solo']);
    expect(res.standings.length).toBe(1);
    expect(computeFinalRanking([])).toEqual({ standings: [], winners: [] });
  });

  it('反向：有存活者时胜者永不含已淘汰者（无论分数）', () => {
    const { winners } = computeFinalRanking([
      p('dead1', 1, 10, 99999, 99),
      p('dead2', 2, 20, 99999, 99),
      p('alive_low', 3, null, 1, 0),
    ]);
    expect(winners).toEqual(['alive_low']); // 唯一存活者即胜者
  });
});
