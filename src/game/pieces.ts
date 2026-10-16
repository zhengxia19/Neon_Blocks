// Neon Blocks — 七种方块的固定形状矩阵与四旋转态（规格 S03.1）。
// 矩阵为字符串行数组，'1'=本方块占用（不存颜色），'0'=空；不去除外围全 0 行列。
import type { PieceType, Rotation } from './types';

/** 形状矩阵：固定大小方阵的字符串行（I/O 为 4×4，其余 3×3）。 */
export type Matrix = readonly string[];

/** 0 态矩阵，逐行与 S03.1 规格一致（S03.1）。 */
const SPAWN_SHAPES: Record<PieceType, Matrix> = {
  I: ['0000', '1111', '0000', '0000'],
  O: ['0000', '0110', '0110', '0000'],
  T: ['010', '111', '000'],
  J: ['100', '111', '000'],
  L: ['001', '111', '000'],
  S: ['011', '110', '000'],
  Z: ['110', '011', '000'],
};

/**
 * 顺时针 90° 旋转整个固定大小方阵：new[row][col] = old[n-1-col][row]（S03.1）。
 * 返回全新数组，绝不原地突变输入；不剪边。
 */
export function rotateMatrixCW(matrix: Matrix): Matrix {
  const n = matrix.length;
  const out: string[] = [];
  for (let row = 0; row < n; row += 1) {
    let line = '';
    for (let col = 0; col < n; col += 1) {
      line += matrix[n - 1 - col][row];
    }
    out.push(line);
  }
  return out;
}

/** 预计算 7×4 缓存：0 态连续 CW 旋转得 1/2/3 态；O 四态自然相同。 */
const ROTATION_CACHE: Record<PieceType, readonly [Matrix, Matrix, Matrix, Matrix]> = (() => {
  const cache = {} as Record<PieceType, [Matrix, Matrix, Matrix, Matrix]>;
  const types = Object.keys(SPAWN_SHAPES) as PieceType[];
  for (const type of types) {
    const r0 = SPAWN_SHAPES[type];
    const r1 = rotateMatrixCW(r0);
    const r2 = rotateMatrixCW(r1);
    const r3 = rotateMatrixCW(r2);
    cache[type] = [r0, r1, r2, r3];
  }
  return cache;
})();

/** 取指定方块在指定旋转态的矩阵（0–3 全部可用，来自预计算缓存）。 */
export function getMatrix(type: PieceType, rotation: Rotation): Matrix {
  return ROTATION_CACHE[type][rotation];
}
