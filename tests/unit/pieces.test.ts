// T010：七种出生形状矩阵测试（规格 S03.1）。
import { describe, expect, it } from 'vitest';
import { getMatrix } from '../../src/game/pieces';
import type { PieceType } from '../../src/game/types';

const PIECE_TYPES: readonly PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

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

describe('出生形状矩阵（S03.1）', () => {
  it.each(PIECE_TYPES)('%s：0 态逐行匹配规格', (type) => {
    expect(getMatrix(type, 0)).toEqual(SPEC_SPAWN[type]);
  });

  it.each(PIECE_TYPES)('%s：恰好 4 个实体格', (type) => {
    const ones = getMatrix(type, 0)
      .join('')
      .split('')
      .filter((ch) => ch === '1').length;
    expect(ones).toBe(4);
  });

  it.each(PIECE_TYPES)('%s：方阵尺寸正确（I/O 4×4，其余 3×3）', (type) => {
    const m = getMatrix(type, 0);
    const n = type === 'I' || type === 'O' ? 4 : 3;
    expect(m).toHaveLength(n);
    for (const row of m) {
      expect(row).toHaveLength(n);
      expect(row).toMatch(/^[01]+$/);
    }
  });

  it('非 0 旋转态显式报未实现（T011 前不伪装完成）', () => {
    for (const rot of [1, 2, 3] as const) {
      expect(() => getMatrix('T', rot)).toThrow(/尚未实现/);
    }
  });
});
