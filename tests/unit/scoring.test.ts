// T020：计分纯函数测试（规格 S03.5）。
import { describe, expect, it } from 'vitest';
import { dropPoints, lineClearPoints, type DropKind } from '../../src/game/scoring';

describe('lineClearPoints（T020，S03.5）', () => {
  it('等级 1 分值表全匹配：0/1/2/3/4 行 → 0/100/300/500/800', () => {
    expect(lineClearPoints(0, 1)).toBe(0);
    expect(lineClearPoints(1, 1)).toBe(100);
    expect(lineClearPoints(2, 1)).toBe(300);
    expect(lineClearPoints(3, 1)).toBe(500);
    expect(lineClearPoints(4, 1)).toBe(800);
  });

  it('任务指定用例：4 行 × 等级 2 = 1600', () => {
    expect(lineClearPoints(4, 2)).toBe(1600);
  });

  it('等级 1..12 全表：每档消行数均为基础分 × level', () => {
    const base = [0, 100, 300, 500, 800] as const;
    for (let level = 1; level <= 12; level += 1) {
      for (let cleared = 0; cleared <= 4; cleared += 1) {
        expect(lineClearPoints(cleared, level)).toBe(base[cleared] * level);
      }
    }
  });

  it('非法消行数显式拒绝：-1/5/1.5/NaN/Infinity 抛 RangeError', () => {
    for (const bad of [-1, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => lineClearPoints(bad, 1)).toThrow(RangeError);
      expect(() => lineClearPoints(bad, 1)).toThrow(/无效消行数/);
    }
  });

  it('非法等级显式拒绝：0/-3/1.5/NaN 抛 RangeError', () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      expect(() => lineClearPoints(1, bad)).toThrow(RangeError);
      expect(() => lineClearPoints(1, bad)).toThrow(/无效等级/);
    }
  });

  it('纯函数：重复调用结果一致（无隐藏状态）', () => {
    const first = lineClearPoints(3, 7);
    const second = lineClearPoints(3, 7);
    expect(first).toBe(3500); // 500 × 7
    expect(second).toBe(first);
  });
});

describe('dropPoints（T020，S03.5）', () => {
  it('任务指定用例：soft 3 格 = 3、hard 3 格 = 6', () => {
    expect(dropPoints('soft', 3)).toBe(3);
    expect(dropPoints('hard', 3)).toBe(6);
  });

  it('0 格均 +0：soft 0 = 0、hard 0 = 0', () => {
    expect(dropPoints('soft', 0)).toBe(0);
    expect(dropPoints('hard', 0)).toBe(0);
  });

  it('每格单价：soft 每格 +1、hard 每格 +2（1/20 格抽查）', () => {
    expect(dropPoints('soft', 1)).toBe(1);
    expect(dropPoints('hard', 1)).toBe(2);
    expect(dropPoints('soft', 20)).toBe(20);
    expect(dropPoints('hard', 20)).toBe(40);
  });

  it('非法格数显式拒绝：-1/0.5/NaN 两种 kind 均抛 RangeError', () => {
    for (const kind of ['soft', 'hard'] as const) {
      for (const bad of [-1, 0.5, Number.NaN]) {
        expect(() => dropPoints(kind, bad)).toThrow(RangeError);
        expect(() => dropPoints(kind, bad)).toThrow(/无效落块格数/);
      }
    }
  });

  it('非法种类显式拒绝：gravity/空串 抛 RangeError（自然重力不经本函数）', () => {
    for (const bad of ['gravity', '', 'SOFT'] as unknown as DropKind[]) {
      expect(() => dropPoints(bad, 1)).toThrow(RangeError);
      expect(() => dropPoints(bad, 1)).toThrow(/无效落块种类/);
    }
  });
});
