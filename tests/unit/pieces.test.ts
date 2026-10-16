// T010/T011：出生形状矩阵与四旋转态测试（规格 S03.1）。
import { describe, expect, it } from 'vitest';
import { getMatrix, rotateMatrixCW } from '../../src/game/pieces';
import type { PieceType, Rotation } from '../../src/game/types';

const PIECE_TYPES: readonly PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

/** S03.1 原样 0 态矩阵。 */
const SPEC_SPAWN: Record<PieceType, readonly string[]> = {
  I: ['0000', '1111', '0000', '0000'],
  O: ['0000', '0110', '0110', '0000'],
  T: ['010', '111', '000'],
  J: ['100', '111', '000'],
  L: ['001', '111', '000'],
  S: ['011', '110', '000'],
  Z: ['110', '011', '000'],
};

const sizeOf = (type: PieceType): number => (type === 'I' || type === 'O' ? 4 : 3);

const countOnes = (m: readonly string[]): number =>
  m.join('').split('').filter((ch) => ch === '1').length;

describe('出生形状矩阵（S03.1）', () => {
  it.each(PIECE_TYPES)('%s：0 态逐行匹配规格', (type) => {
    expect(getMatrix(type, 0)).toEqual(SPEC_SPAWN[type]);
  });

  it.each(PIECE_TYPES)('%s：恰好 4 个实体格', (type) => {
    expect(countOnes(getMatrix(type, 0))).toBe(4);
  });

  it.each(PIECE_TYPES)('%s：方阵尺寸正确（I/O 4×4，其余 3×3）', (type) => {
    const m = getMatrix(type, 0);
    const n = sizeOf(type);
    expect(m).toHaveLength(n);
    for (const row of m) {
      expect(row).toHaveLength(n);
      expect(row).toMatch(/^[01]+$/);
    }
  });
});

describe('四旋转态（T011，S03.1）', () => {
  it.each(PIECE_TYPES)('%s：7×4 个矩阵全部合法（固定尺寸、[01]、每态 4 格）', (type) => {
    const n = sizeOf(type);
    for (const rot of ROTATIONS) {
      const m = getMatrix(type, rot);
      expect(m).toHaveLength(n);
      for (const row of m) {
        expect(row).toHaveLength(n);
        expect(row).toMatch(/^[01]+$/);
      }
      expect(countOnes(m)).toBe(4);
    }
  });

  it.each(PIECE_TYPES)('%s：连续旋转 4 次恢复原状', (type) => {
    let m = getMatrix(type, 0);
    for (let i = 0; i < 4; i += 1) {
      m = rotateMatrixCW(m);
    }
    expect(m).toEqual(SPEC_SPAWN[type]);
  });

  it.each(PIECE_TYPES)('%s：getMatrix 的 1/2/3 态等于对 0 态连续 CW 旋转', (type) => {
    let m = getMatrix(type, 0);
    for (const rot of [1, 2, 3] as const) {
      m = rotateMatrixCW(m);
      expect(getMatrix(type, rot)).toEqual(m);
    }
  });

  it('O 四态完全相同（S03.1）', () => {
    for (const rot of [1, 2, 3] as const) {
      expect(getMatrix('O', rot)).toEqual(SPEC_SPAWN.O);
    }
  });

  it('I 竖态列位置正确：1 态在第 2 列，3 态在第 1 列，2 态在第 2 行（S03.1 不剪边）', () => {
    expect(getMatrix('I', 1)).toEqual(['0010', '0010', '0010', '0010']);
    expect(getMatrix('I', 2)).toEqual(['0000', '0000', '1111', '0000']);
    expect(getMatrix('I', 3)).toEqual(['0100', '0100', '0100', '0100']);
  });

  it('rotateMatrixCW 不原地突变输入，返回新数组', () => {
    for (const type of PIECE_TYPES) {
      const original = getMatrix(type, 0);
      const snapshot = [...original];
      const rotated = rotateMatrixCW(original);
      expect(original).toEqual(snapshot);
      if (type !== 'O') {
        expect(rotated).not.toEqual(snapshot);
      }
      expect(rotated).not.toBe(original);
    }
  });
});
