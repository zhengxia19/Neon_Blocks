// T020：计分纯函数——消行分值与软/硬降加分（规格 S03.5）。
// 纯逻辑模块：不依赖 DOM/Canvas/localStorage，不持有任何可变状态。

/** 落块加分种类：soft=手动软降、hard=硬降（自然重力不产生加分，不经本函数）。 */
export type DropKind = 'soft' | 'hard';

/** 消行分值表（S03.5）：下标即消行数 0..4，值为基础分（结算时 × 消行发生前的 level）。 */
const LINE_CLEAR_BASE_POINTS: readonly [number, number, number, number, number] = [
  0, 100, 300, 500, 800,
];

/**
 * 消行得分（S03.5）：`cleared` 行按 0/100/300/500/800 × `level` 结算。
 * `level` 必须是消行发生**之前**的等级（调用方保证结算顺序）。
 * 非法输入（非 0..4 整数行数、非 ≥1 整数等级）显式拒绝。
 */
export function lineClearPoints(cleared: number, level: number): number {
  if (!Number.isInteger(cleared) || cleared < 0 || cleared > 4) {
    throw new RangeError(`无效消行数：${cleared}（必须为 0..4 的整数）`);
  }
  if (!Number.isInteger(level) || level < 1) {
    throw new RangeError(`无效等级：${level}（必须为 ≥1 的整数）`);
  }
  return LINE_CLEAR_BASE_POINTS[cleared] * level;
}

/**
 * 落块加分（S03.5）：软降每有效移动一格 +1，硬降按实际落差每格 +2（0 格 +0）。
 * 非法输入（非 soft/hard 种类、非 ≥0 整数格数）显式拒绝。
 */
export function dropPoints(kind: DropKind, cells: number): number {
  if (kind !== 'soft' && kind !== 'hard') {
    throw new RangeError(`无效落块种类：${String(kind)}（必须为 soft 或 hard）`);
  }
  if (!Number.isInteger(cells) || cells < 0) {
    throw new RangeError(`无效落块格数：${cells}（必须为 ≥0 的整数）`);
  }
  return kind === 'soft' ? cells : cells * 2;
}
