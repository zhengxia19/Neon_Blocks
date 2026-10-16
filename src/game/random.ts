// Neon Blocks — 7-bag 随机袋（规格 S03.2）。随机源可注入；game/ 内绝不使用 Math.random。
import type { PieceType } from './types';

/** 构成一袋的 7 种方块。 */
export const BAG_TYPES: readonly PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/** 抽取一枚的结果：type 为抽出方块，bag 为剩余的新数组（不突变输入）。 */
export interface DrawResult {
  readonly bag: readonly PieceType[];
  readonly type: PieceType;
}

/**
 * Fisher–Yates 洗牌：返回新数组，不突变输入；
 * 对长度 n 的数组恰好调用 rng 共 n-1 次（i 从 n-1 递减到 1）。
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i >= 1; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 生成一个已洗牌的新袋（本模块内随机数的唯一消耗点）。 */
export function newBag(rng: () => number): PieceType[] {
  return shuffle(BAG_TYPES, rng);
}

/**
 * 从袋中抽取一枚：袋非空时直接取尾（零次 rng 调用）；
 * 仅当袋为空时才洗牌补充新袋（随机只在此处消耗）。返回新数组，不突变输入。
 */
export function drawFromBag(bag: readonly PieceType[], rng: () => number): DrawResult {
  const remaining = bag.length > 0 ? [...bag] : newBag(rng);
  const type = remaining.pop();
  if (type === undefined) {
    throw new Error('drawFromBag: 新袋仍为空（不应发生）');
  }
  return { bag: remaining, type };
}
