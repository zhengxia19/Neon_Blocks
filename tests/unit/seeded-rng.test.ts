import { describe, expect, it } from 'vitest';
import { BAG_TYPES } from '../../src/game/random';
import {
  RNG_ALGO,
  createSeededRng,
  deriveSeatSeed,
  drawPieceSequence,
  hashUtf8ToSeed,
  masterSeedFromCustomSeed,
  normalizeSeed,
  seatSeedFor,
} from '../../src/game/seeded-rng';

// 金样本：算法版本 xorshift32-bag7-v1，seed=12345 的前 100 枚方块（跨设备/刷新必须一致）。
const GOLD_SEED_12345_FIRST_100 = [
  'J', 'T', 'S', 'O', 'I', 'Z', 'L', 'L', 'J', 'T', 'Z', 'I', 'S', 'O', 'T', 'I', 'S', 'O', 'J', 'Z',
  'L', 'I', 'Z', 'L', 'T', 'O', 'J', 'S', 'Z', 'S', 'I', 'T', 'J', 'L', 'O', 'S', 'J', 'Z', 'L', 'O',
  'I', 'T', 'T', 'S', 'L', 'I', 'J', 'Z', 'O', 'T', 'S', 'Z', 'L', 'I', 'O', 'J', 'Z', 'I', 'J', 'T',
  'S', 'O', 'L', 'O', 'S', 'T', 'L', 'J', 'I', 'Z', 'S', 'Z', 'J', 'I', 'L', 'T', 'O', 'Z', 'T', 'I',
  'L', 'O', 'J', 'S', 'O', 'L', 'Z', 'I', 'J', 'T', 'S', 'L', 'J', 'S', 'O', 'Z', 'T', 'I', 'T', 'J',
] as const;

describe('N05 种子随机算法（xorshift32-bag7-v1）', () => {
  it('正向：seed=12345 前 100 枚与金样本完全一致（可跨端重放）', () => {
    const seq = drawPieceSequence(12345, 100);
    expect(seq).toEqual([...GOLD_SEED_12345_FIRST_100]);
    expect(seq.length).toBe(100);
    expect(RNG_ALGO).toBe('xorshift32-bag7-v1');
  });

  it('正向：同一种子重复执行序列一致；PRNG 输出落在 [0,1)', () => {
    expect(drawPieceSequence(12345, 100)).toEqual(drawPieceSequence(12345, 100));
    expect(drawPieceSequence(0, 14)).toEqual(['T', 'J', 'L', 'I', 'Z', 'O', 'S', 'J', 'L', 'S', 'T', 'I', 'O', 'Z']);
    const rng = createSeededRng(1);
    expect(Array.from({ length: 5 }, () => rng())).toEqual([
      0.00006295018829405308, 0.015747428173199296, 0.6164041024167091, 0.07161863497458398, 0.5584883580449969,
    ]);
    const rng2 = createSeededRng(987654321);
    for (let i = 0; i < 500; i += 1) {
      const v = rng2();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('正向：32 位种子归一化把任意整数折叠到同一非零无符号状态', () => {
    expect([
      normalizeSeed(0),
      normalizeSeed(-1),
      normalizeSeed(4294967296),
      normalizeSeed(4294967297),
      normalizeSeed(1.9),
    ]).toEqual([2654435769, 4294967295, 2654435769, 1, 1]);
    expect(normalizeSeed(0)).toBe(normalizeSeed(2 ** 32));
    expect(drawPieceSequence(0, 14)).toEqual(drawPieceSequence(2 ** 32, 14));
  });

  it('正向：UTF-8 稳定哈希金样本（S3 房主自定义种子）', () => {
    expect(hashUtf8ToSeed('abc123')).toBe(793982812);
    expect(hashUtf8ToSeed('中文种子')).toBe(3880579551);
    expect(hashUtf8ToSeed('')).toBe(1947474976);
    expect(masterSeedFromCustomSeed('abc123')).toBe(793982812);
    expect(hashUtf8ToSeed('abc124')).not.toBe(793982812);
    expect(drawPieceSequence(hashUtf8ToSeed('abc123'), 20)).toEqual(
      drawPieceSequence(masterSeedFromCustomSeed('abc123'), 20),
    );
  });

  it('正向：席位派生金样本（S2）与模式规则（S1/S3 全员同序列）', () => {
    expect([1, 2, 3, 4, 5, 6].map((i) => deriveSeatSeed(987654321, i))).toEqual([
      4186254358, 2455252008, 2706828453, 3026961813, 2021123199, 3029152338,
    ]);
    const seats = [1, 2, 3, 4, 5, 6].map((i) => deriveSeatSeed(987654321, i));
    expect(new Set(seats).size).toBe(6);
    expect(deriveSeatSeed(987654321, 3)).toBe(deriveSeatSeed(987654321, 3));
    for (const mode of ['S1', 'S3'] as const) {
      const seeds = [1, 2, 3, 4, 5, 6].map((i) => seatSeedFor(mode, 555, i));
      expect(new Set(seeds).size).toBe(1);
      expect(seeds[0]).toBe(555);
    }
    const s2 = [1, 2, 3].map((i) => seatSeedFor('S2', 555, i));
    expect(new Set(s2).size).toBe(3);
    expect(s2).toEqual([deriveSeatSeed(555, 1), deriveSeatSeed(555, 2), deriveSeatSeed(555, 3)]);
  });

  it('正向：保留 7-bag 约束——每 7 枚恰为 7 种方块各一次', () => {
    const seq = drawPieceSequence(20261019, 98);
    for (let start = 0; start + 7 <= seq.length; start += 7) {
      const group = seq.slice(start, start + 7);
      expect([...group].sort().join('')).toBe([...BAG_TYPES].sort().join(''));
    }
    expect(BAG_TYPES.length).toBe(7);
    expect(new Set(BAG_TYPES).size).toBe(7);
  });

  it('反向：不同种子产生不同序列；非法参数抛 RangeError', () => {
    expect(drawPieceSequence(12345, 100)).not.toEqual(drawPieceSequence(12346, 100));
    expect(() => deriveSeatSeed(1, 0)).toThrow(RangeError);
    expect(() => deriveSeatSeed(1, 1.5)).toThrow(RangeError);
    expect(() => drawPieceSequence(1, -1)).toThrow(RangeError);
    expect(drawPieceSequence(1, 0)).toEqual([]);
  });

  it('反向：种子随机不改变单机既有 7-bag 行为', () => {
    expect(drawPieceSequence(12345, 7).length).toBe(7);
    // 归一化后的种子永不为 0，xorshift32 不会退化为常数序列
    const rng = createSeededRng(0);
    expect(new Set(Array.from({ length: 8 }, () => rng())).size).toBe(8);
  });
});
