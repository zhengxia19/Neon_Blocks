// N16：种子派生与 7-bag 序列金样本（跨客户端约定牌序不变量，shared/protocol 实现）。
import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_MS,
  RNG_ALGO,
  bag7Sequence,
  deriveSeatSeed,
  fnv1a32,
  normalizeSeed32,
  xorshift32,
} from '../../shared/protocol';

describe('N16 xorshift32 与 7-bag 金样本', () => {
  it('xorshift32(seed=1) 前三输出固定（算法版本锁定）', () => {
    const rng = xorshift32(1);
    expect([rng(), rng(), rng()]).toEqual([270369, 67634689, 2647435461]);
  });

  it('相同种子+相同取牌次数=同一序列（金样本 14 枚；前缀一致）', () => {
    expect(bag7Sequence(1, 14)).toEqual([4, 0, 2, 3, 5, 6, 1, 2, 1, 3, 5, 4, 6, 0]);
    expect(bag7Sequence(1, 14)).toEqual(bag7Sequence(1, 14));
    expect(bag7Sequence(1, 7)).toEqual(bag7Sequence(1, 14).slice(0, 7));
    expect(bag7Sequence(2, 14)).not.toEqual(bag7Sequence(1, 14));
  });

  it('每袋为 7 枚全排列（7-bag 规则，禁止逐块等概率抽签）', () => {
    const seq = bag7Sequence(12345, 35);
    expect(seq.length).toBe(35);
    for (let b = 0; b < 5; b += 1) {
      expect([...seq.slice(b * 7, b * 7 + 7)].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it('零种子映射为非零状态（xorshift32 状态非零约束）', () => {
    expect(xorshift32(0)()).toBeGreaterThan(0);
    expect(deriveSeatSeed(0, 'p_x')).not.toBe(0);
  });
});

describe('N16 S3 归一化与 S2 席位派生', () => {
  it('S3 固定哈希归一化：金样本、大小写敏感、可复盘', () => {
    expect(fnv1a32('')).toBe(2166136261); // FNV-1a 偏移基
    expect(normalizeSeed32('seed42')).toBe(1672157454);
    expect(normalizeSeed32('Seed42')).toBe(2868627374); // 大小写敏感
    expect(normalizeSeed32('a')).toBe(3826002220);
    expect(normalizeSeed32('seed42')).toBe(normalizeSeed32('seed42'));
  });

  it('S2 按主种子+席位 ID 派生：金样本、确定性、席位间互异', () => {
    expect(deriveSeatSeed(1, 'p_aaaaaaaaaaaa')).toBe(2416443464);
    expect(deriveSeatSeed(1, 'p_bbbbbbbbbbbb')).toBe(23004892);
    expect(deriveSeatSeed(7, 'p_a')).not.toBe(deriveSeatSeed(7, 'p_b'));
  });

  it('算法版本常量与统一倒计时时长', () => {
    expect(RNG_ALGO).toBe('xorshift32-bag7-v1');
    expect(COUNTDOWN_MS).toBe(3000);
  });
});
