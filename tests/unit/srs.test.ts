// Neon Blocks — SRS 墙踢静态表单元测试（规格 S03.4，任务 T017）。
// 逐项对照规格 S03.4 表格（屏幕坐标，y 向下为正），锁定 16 组偏移的长度与顺序。
import { describe, expect, it } from 'vitest';
import {
  getKickOffsets,
  I_KICKS,
  JLSTZ_KICKS,
  O_KICKS,
  type KickOffset,
  type KickTable,
} from '../../src/game/srs';
import type { PieceType, Rotation } from '../../src/game/types';

/** 规格 S03.4 表格逐字抄录（y 向下），用于与实现逐项比对。 */
const SPEC_JLSTZ: Record<string, readonly (readonly [number, number])[]> = {
  '01': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '10': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '12': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '21': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '23': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '32': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '30': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '03': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

const SPEC_I: Record<string, readonly (readonly [number, number])[]> = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

const TRANSITIONS = ['01', '10', '12', '21', '23', '32', '30', '03'] as const;

/** 断言一张表与规格抄录逐项一致：8 个过渡、每个长度 5、顺序完全相同。 */
function expectMatchesSpec(table: KickTable, spec: typeof SPEC_JLSTZ | typeof SPEC_I): void {
  expect(Object.keys(table).sort()).toEqual([...TRANSITIONS].sort());
  for (const key of TRANSITIONS) {
    expect(table[key]).toHaveLength(5);
    expect(table[key]).toEqual(spec[key]);
  }
}

describe('JLSTZ_KICKS 与规格 S03.4 逐项一致', () => {
  it('8 个过渡齐全且每组偏移长度=5、顺序与文档一致', () => {
    expectMatchesSpec(JLSTZ_KICKS, SPEC_JLSTZ);
  });
});

describe('I_KICKS 与规格 S03.4 逐项一致', () => {
  it('8 个过渡齐全且每组偏移长度=5、顺序与文档一致', () => {
    expectMatchesSpec(I_KICKS, SPEC_I);
  });

  it('I 的 0→1 含 (-2,0)（第二偏移）', () => {
    expect(I_KICKS['01'][1]).toEqual([-2, 0]);
  });
});

describe('两组表的首偏移均为 (0,0)', () => {
  it('16 组偏移第一处均为 (0,0)', () => {
    for (const key of TRANSITIONS) {
      expect(JLSTZ_KICKS[key][0]).toEqual([0, 0]);
      expect(I_KICKS[key][0]).toEqual([0, 0]);
    }
  });
});

describe('getKickOffsets 按类型选择表', () => {
  const jlstmz: PieceType[] = ['J', 'L', 'S', 'T', 'Z'];

  it('J/L/S/T/Z 全部返回 JLSTZ_KICKS 对应序列', () => {
    for (const type of jlstmz) {
      for (const key of TRANSITIONS) {
        const from = Number(key[0]) as Rotation;
        const to = Number(key[1]) as Rotation;
        expect(getKickOffsets(type, from, to)).toEqual(SPEC_JLSTZ[key]);
      }
    }
  });

  it('I 返回 I_KICKS 对应序列（与 JLSTZ 不同，不得混用）', () => {
    for (const key of TRANSITIONS) {
      const from = Number(key[0]) as Rotation;
      const to = Number(key[1]) as Rotation;
      const offsets = getKickOffsets('I', from, to);
      expect(offsets).toEqual(SPEC_I[key]);
      expect(offsets).not.toEqual(SPEC_JLSTZ[key]);
    }
  });

  it('O 不踢墙：任意过渡仅返回恒等偏移 [(0,0)]', () => {
    for (const key of TRANSITIONS) {
      const from = Number(key[0]) as Rotation;
      const to = Number(key[1]) as Rotation;
      expect(getKickOffsets('O', from, to)).toEqual(O_KICKS);
      expect(getKickOffsets('O', from, to)).toHaveLength(1);
    }
  });

  it('非法过渡（0→2、1→3、同态）抛错', () => {
    const bad: [Rotation, Rotation][] = [[0, 2], [2, 0], [1, 3], [3, 1], [0, 0], [1, 1], [2, 2], [3, 3]];
    for (const type of ['T', 'I'] as PieceType[]) {
      for (const [from, to] of bad) {
        expect(() => getKickOffsets(type, from, to)).toThrow(/非法旋转过渡/);
      }
    }
  });
});

describe('表为纯数据（无副作用、可安全共享）', () => {
  it('返回的偏移序列引用即表内常量，且数值均为整数', () => {
    const offsets: readonly KickOffset[] = getKickOffsets('T', 0, 1);
    expect(offsets).toBe(JLSTZ_KICKS['01']);
    for (const key of TRANSITIONS) {
      for (const [dx, dy] of [...I_KICKS[key], ...JLSTZ_KICKS[key]]) {
        expect(Number.isInteger(dx)).toBe(true);
        expect(Number.isInteger(dy)).toBe(true);
      }
    }
  });
});
