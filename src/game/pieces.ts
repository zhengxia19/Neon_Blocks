// Neon Blocks — 七种方块的固定出生形状矩阵（规格 S03.1）。
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
 * 取指定方块在指定旋转态的矩阵。
 * rotation=0 完整可用；1/2/3 态由 T011 实现，当前显式抛未实现错误（不伪装完成）。
 */
export function getMatrix(type: PieceType, rotation: Rotation): Matrix {
  if (rotation === 0) {
    return SPAWN_SHAPES[type];
  }
  throw new Error(`getMatrix: rotation ${rotation} 尚未实现（T011 提供四旋转态）`);
}
