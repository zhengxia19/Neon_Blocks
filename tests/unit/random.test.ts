// T012：可注入随机的 7-bag 测试（规格 S03.2）。
import { describe, expect, it } from 'vitest';
import { BAG_TYPES, drawFromBag, newBag, shuffle } from '../../src/game/random';
import type { PieceType } from '../../src/game/types';

const PIECE_TYPES: readonly PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/** 确定性 PRNG（mulberry32），返回 [0,1)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 统计 rng 调用次数的包装。 */
function countingRng(inner: () => number): { rng: () => number; calls: () => number } {
  let n = 0;
  return {
    rng: () => {
      n += 1;
      return inner();
    },
    calls: () => n,
  };
}

describe('shuffle（Fisher–Yates）', () => {
  it('返回新数组且不突变输入', () => {
    const input = [...PIECE_TYPES];
    const snapshot = [...input];
    const out = shuffle(input, mulberry32(42));
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot);
  });

  it('输出是输入的排列（不重不漏）', () => {
    for (const seed of [1, 7, 99, 123456]) {
      const out = shuffle(PIECE_TYPES, mulberry32(seed));
      expect([...out].sort()).toEqual([...PIECE_TYPES].sort());
    }
  });

  it('对 7 项数组恰好调用 rng 6 次', () => {
    const c = countingRng(mulberry32(5));
    shuffle(PIECE_TYPES, c.rng);
    expect(c.calls()).toBe(6);
  });

  it('同种子产生相同洗牌结果（确定性）', () => {
    expect(shuffle(PIECE_TYPES, mulberry32(2024))).toEqual(shuffle(PIECE_TYPES, mulberry32(2024)));
  });
});

describe('newBag', () => {
  it('新袋恰含 7 种方块各一枚', () => {
    for (const seed of [3, 8, 777]) {
      const bag = newBag(mulberry32(seed));
      expect(bag).toHaveLength(7);
      expect([...bag].sort()).toEqual([...BAG_TYPES].sort());
    }
  });
});

describe('drawFromBag（7-bag 抽取）', () => {
  it('连续 14 枚：前 7 枚与后 7 枚各自恰含 7 种不重不漏', () => {
    const rng = mulberry32(2026);
    let bag: readonly PieceType[] = [];
    const drawn: PieceType[] = [];
    for (let i = 0; i < 14; i += 1) {
      const r = drawFromBag(bag, rng);
      bag = r.bag;
      drawn.push(r.type);
    }
    const first = drawn.slice(0, 7);
    const second = drawn.slice(7, 14);
    expect([...first].sort()).toEqual([...PIECE_TYPES].sort());
    expect([...second].sort()).toEqual([...PIECE_TYPES].sort());
  });

  it('同一种子序列稳定（两次运行完全一致）', () => {
    const run = (seed: number): PieceType[] => {
      const rng = mulberry32(seed);
      let bag: readonly PieceType[] = [];
      const drawn: PieceType[] = [];
      for (let i = 0; i < 14; i += 1) {
        const r = drawFromBag(bag, rng);
        bag = r.bag;
        drawn.push(r.type);
      }
      return drawn;
    };
    expect(run(31337)).toEqual(run(31337));
  });

  it('随机仅在袋空补充时消耗：非空袋抽取零次 rng', () => {
    const c = countingRng(mulberry32(9));
    const bag = newBag(c.rng);
    const before = c.calls();
    let current: readonly PieceType[] = bag;
    for (let i = 0; i < 7; i += 1) {
      current = drawFromBag(current, c.rng).bag;
    }
    expect(current).toHaveLength(0);
    expect(c.calls()).toBe(before); // 7 次抽取全部来自已有袋，零新增随机
    drawFromBag(current, c.rng); // 第 8 次：袋空 → 补充新袋才消耗随机
    expect(c.calls()).toBe(before + 6);
  });

  it('不突变输入袋，返回新数组', () => {
    const bag = newBag(mulberry32(11));
    const snapshot = [...bag];
    const r = drawFromBag(bag, mulberry32(12));
    expect(bag).toEqual(snapshot);
    expect(r.bag).not.toBe(bag);
    expect(r.bag).toHaveLength(6);
    expect([...r.bag, r.type].sort()).toEqual([...PIECE_TYPES].sort());
  });

  it('空袋抽取自动补充：返回 7 种之一且剩余 6 枚', () => {
    const r = drawFromBag([], mulberry32(13));
    expect(PIECE_TYPES).toContain(r.type);
    expect(r.bag).toHaveLength(6);
    expect(r.bag).not.toContain(r.type);
  });
});
