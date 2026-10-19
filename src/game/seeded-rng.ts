// Neon Blocks — 可复现的种子随机源（联网对战 N05）。
// 算法版本 `xorshift32-bag7-v1`：xorshift32 PRNG + 既有 7-bag 洗牌规则（不改变出块规则）。
// 本文件为纯逻辑：不访问 DOM / 网络 API；`import type` 仅用于与协议常量保持同步（编译期擦除）。
import type { RngAlgo, RandomMode } from '../../shared/protocol';
import { drawFromBag } from './random';
import type { PieceType } from './types';

/** 与协议 `RngAlgo` 同步的算法版本标识。 */
export const RNG_ALGO = 'xorshift32-bag7-v1' satisfies RngAlgo;

/** 32 位无符号空间。 */
const U32 = 0x1_0000_0000;
/** xorshift32 不允许零状态；用黄金比例常数替换 0。 */
const ZERO_SEED_REPLACEMENT = 0x9e3779b9;

/**
 * 32 位种子归一化：截断为整数、按 2^32 取模并转无符号；0 替换为非零常数。
 * 保证任意输入（含负数、超大值）在前后端得到同一状态值。
 */
export function normalizeSeed(seed: number): number {
  const truncated = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const wrapped = truncated % U32;
  const unsigned = wrapped >>> 0;
  return unsigned === 0 ? ZERO_SEED_REPLACEMENT : unsigned;
}

/**
 * UTF-8 稳定哈希（FNV-1a 32 位 + finalizer），用于房主自定义种子（S3）。
 * 跨设备/跨语言一致：同一字符串永远得到同一 32 位种子。
 */
export function hashUtf8ToSeed(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return normalizeSeed(h);
}

/** 房主自定义种子（S3）→ 主种子。 */
export function masterSeedFromCustomSeed(customSeed: string): number {
  return hashUtf8ToSeed(customSeed);
}

/**
 * 席位派生（S2 模式）：由系统主种子与席位序号派生互不相同且可复现的席位种子。
 * 席位序号从 1 起（与 `PlayerView.seatIndex` 一致）。
 */
export function deriveSeatSeed(masterSeed: number, seatIndex: number): number {
  if (!Number.isSafeInteger(seatIndex) || seatIndex < 1) {
    throw new RangeError(`deriveSeatSeed: 非法席位序号 ${String(seatIndex)}`);
  }
  const base = normalizeSeed(masterSeed);
  let x = (base ^ Math.imul(seatIndex, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return normalizeSeed(x);
}

/** 按随机模式取该席位应使用的种子：S1/S3 全员同序列，S2 按席位派生。 */
export function seatSeedFor(mode: RandomMode, masterSeed: number, seatIndex: number): number {
  return mode === 'S2' ? deriveSeatSeed(masterSeed, seatIndex) : normalizeSeed(masterSeed);
}

/**
 * xorshift32 PRNG：返回 [0,1) 的确定性序列。
 * 同一（归一化）种子在任意设备、任意刷新下产生完全相同的序列。
 */
export function createSeededRng(seed: number): () => number {
  let state = normalizeSeed(seed);
  return (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / U32;
  };
}

/** 用种子随机源连续抽取 `count` 枚方块（复用既有 7-bag 规则，不改变出块约束）。 */
export function drawPieceSequence(seed: number, count: number): PieceType[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`drawPieceSequence: 非法数量 ${String(count)}`);
  }
  const rng = createSeededRng(seed);
  const out: PieceType[] = [];
  let bag: readonly PieceType[] = [];
  for (let i = 0; i < count; i += 1) {
    const drawn = drawFromBag(bag, rng);
    bag = drawn.bag;
    out.push(drawn.type);
  }
  return out;
}
