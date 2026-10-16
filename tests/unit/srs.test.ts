// Neon Blocks — SRS 墙踢静态表单元测试（规格 S03.4，任务 T017）。
// 逐项对照规格 S03.4 表格（屏幕坐标，y 向下为正），锁定 16 组偏移的长度与顺序。
import { describe, expect, it } from 'vitest';
import { canPlace, createEmptyBoard } from '../../src/game/board';
import {
  getKickOffsets,
  I_KICKS,
  JLSTZ_KICKS,
  O_KICKS,
  tryRotate,
  type KickOffset,
  type KickTable,
} from '../../src/game/srs';
import type { ActivePiece, Board, PieceType, Rotation } from '../../src/game/types';

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

describe('tryRotate 自由旋转（空盘首偏移 (0,0) 即成功）', () => {
  it('T 空盘 0→1 顺转：位置不变、rotation+1', () => {
    const board = createEmptyBoard();
    const piece: ActivePiece = { type: 'T', rotation: 0, x: 3, y: 2 };
    const result = tryRotate(board, piece, 1);
    expect(result).toEqual({ type: 'T', rotation: 1, x: 3, y: 2 });
    expect(result).not.toBe(piece);
  });

  it('T 空盘 0→3 逆转：rotation 循环到 3', () => {
    const board = createEmptyBoard();
    const piece: ActivePiece = { type: 'T', rotation: 0, x: 3, y: 2 };
    expect(tryRotate(board, piece, -1)).toEqual({ type: 'T', rotation: 3, x: 3, y: 2 });
  });

  it('rotation 循环：1→2→3→0（顺）与 0→3→2→1（逆）', () => {
    const board = createEmptyBoard();
    let piece: ActivePiece = { type: 'S', rotation: 1, x: 3, y: 5 };
    piece = tryRotate(board, piece, 1);
    expect(piece.rotation).toBe(2);
    piece = tryRotate(board, piece, 1);
    expect(piece.rotation).toBe(3);
    piece = tryRotate(board, piece, 1);
    expect(piece.rotation).toBe(0);
    piece = tryRotate(board, piece, -1);
    expect(piece.rotation).toBe(3);
    piece = tryRotate(board, piece, -1);
    expect(piece.rotation).toBe(2);
    piece = tryRotate(board, piece, -1);
    expect(piece.rotation).toBe(1);
  });
});

describe('tryRotate 墙边旋转成功且不穿墙', () => {
  it('I 贴左墙竖转横（0→1）：命中 (-2,0) 踢回场内', () => {
    const board = createEmptyBoard();
    // I 0 态 x=0：实体格占第 1–4 列；顺转 1 态占第 3 列，(0,0) 即可。
    // 为命中 (-2,0)：先构造 1→0 逆转贴左墙。I 1 态 x=-2（实体列 0），逆转 1→0 需占 x..x+3。
    const piece: ActivePiece = { type: 'I', rotation: 1, x: -2, y: 10 };
    const result = tryRotate(board, piece, -1);
    // I 1→0 偏移 (0,0),(2,0),(-1,0),(2,-1),(-1,2)：(0,0)→x=-2 占 -2..1 越界；(2,0)→x=0 合法。
    expect(result).toEqual({ type: 'I', rotation: 0, x: 0, y: 10 });
    expect(canPlace(board, result)).toBe(true);
  });

  it('I 贴右墙竖转横（1→2）：命中 (-1,0) 踢回场内', () => {
    const board = createEmptyBoard();
    // I 1 态实体列 = x+2；x=7 时实体列 9（贴右墙）。1→2 偏移 (0,0),(-1,0),(2,0),(-1,-2),(2,1)：
    // (0,0)→x=7 横占 7..10 越界；(-1,0)→x=6 占 6..9 合法，首个可行。
    const piece: ActivePiece = { type: 'I', rotation: 1, x: 7, y: 10 };
    const result = tryRotate(board, piece, 1);
    expect(result).toEqual({ type: 'I', rotation: 2, x: 6, y: 10 });
    expect(canPlace(board, result)).toBe(true);
  });

  it('T 贴左墙顺转：命中 (-1,-1) 上移踢墙', () => {
    const board = createEmptyBoard();
    // T 1 态（["010","011","010"]）x=-1：实体列 0/1 合法。1→2 偏移 (0,0),(1,0),(1,1),(0,-2),(1,-2)。
    // T 2 态（["000","111","010"]）x=-1 时占列 -1..1 越界；(1,0)→x=0 合法。
    const piece: ActivePiece = { type: 'T', rotation: 1, x: -1, y: 10 };
    const result = tryRotate(board, piece, 1);
    expect(result).toEqual({ type: 'T', rotation: 2, x: 0, y: 10 });
    expect(canPlace(board, result)).toBe(true);
  });

  it('S 贴地顺转：命中 (0,2) 类下移不可行时按表顺序取首个可行', () => {
    const board = createEmptyBoard();
    // S 0 态（["011","110","000"]）y=22：实体行 22/23 贴地。0→1 偏移 (0,0),(-1,0),(-1,-1),(0,2),(-1,2)。
    // S 1 态（["010","011","001"]）y=22 时占行 22/23/24 越界；(-1,0) 同越界；(-1,-1)→y=21 合法。
    const piece: ActivePiece = { type: 'S', rotation: 0, x: 3, y: 22 };
    const result = tryRotate(board, piece, 1);
    expect(result).toEqual({ type: 'S', rotation: 1, x: 2, y: 21 });
    expect(canPlace(board, result)).toBe(true);
  });
});

describe('tryRotate 阻挡全失败时完全维持原状态', () => {
  it('I 竖态被左墙+两道砖栏夹死（1→2）：返回原 piece 同一引用，x/y/rotation 不变', () => {
    const board = createEmptyBoard();
    // I 1 态 x=-2（实体列 0）y=20（行 20–23）。1→2 偏移 (0,0),(-1,0),(2,0),(-1,-2),(2,1)：
    // (0,0)/(-1,0) 横态越左界；(2,0)→横占行 22 列 0..3 被 (22,1..3) 挡；(-1,-2) 越左界；
    // (2,1)→横占行 23 列 0..3 被 (23,1..3) 挡。五偏移全败。
    for (const x of [1, 2, 3]) {
      board[22][x] = 'J';
      board[23][x] = 'J';
    }
    const piece: ActivePiece = { type: 'I', rotation: 1, x: -2, y: 20 };
    expect(canPlace(board, piece)).toBe(true);
    const result = tryRotate(board, piece, 1);
    expect(result).toBe(piece);
    expect(result).toEqual({ type: 'I', rotation: 1, x: -2, y: 20 });
  });

  it('T 被砖块夹死（0→1）：返回同一引用，x/y/rotation 完全不变', () => {
    const board = createEmptyBoard();
    // T 0 态 (3,2)：实体格 (2,4),(3,3),(3,4),(3,5)（保持为空，当前落点合法）。
    // 0→1 偏移 (0,0),(-1,0),(-1,-1),(0,2),(-1,2) 的落点分别被 (4,4)/(2,3)/(1,3)/(4,4)/(4,3) 挡死。
    for (const [y, x] of [
      [4, 4], [2, 3], [1, 3], [4, 3], [5, 4], [5, 5], [4, 5], [5, 3], [2, 2],
    ] as const) {
      board[y][x] = 'J';
    }
    const piece: ActivePiece = { type: 'T', rotation: 0, x: 3, y: 2 };
    expect(canPlace(board, piece)).toBe(true);
    const result = tryRotate(board, piece, 1);
    expect(result).toBe(piece);
    expect(result).toEqual({ type: 'T', rotation: 0, x: 3, y: 2 });
  });
});

describe('tryRotate O 不移动、不踢墙', () => {
  it('O 顺/逆转仅 rotation 变化，x/y 恒等', () => {
    const board = createEmptyBoard();
    const piece: ActivePiece = { type: 'O', rotation: 0, x: 4, y: 2 };
    expect(tryRotate(board, piece, 1)).toEqual({ type: 'O', rotation: 1, x: 4, y: 2 });
    expect(tryRotate(board, piece, -1)).toEqual({ type: 'O', rotation: 3, x: 4, y: 2 });
  });

  it('O 贴左墙旋转仍不移动', () => {
    const board = createEmptyBoard();
    // O 0 态实体列 x+1,x+2；x=-1 时占 0/1 列合法。
    const piece: ActivePiece = { type: 'O', rotation: 0, x: -1, y: 10 };
    const result = tryRotate(board, piece, 1);
    expect(result).toEqual({ type: 'O', rotation: 1, x: -1, y: 10 });
  });
});

describe('tryRotate 不修改入参（board/piece 均不可变）', () => {
  it('踢墙成功后原 board 与 piece 保持原值', () => {
    const board = createEmptyBoard();
    const piece: ActivePiece = { type: 'I', rotation: 1, x: -2, y: 10 };
    const boardSnapshot: Board = board.map((row) => [...row]);
    const pieceSnapshot: ActivePiece = { ...piece };
    tryRotate(board, piece, -1);
    expect(board).toEqual(boardSnapshot);
    expect(piece).toEqual(pieceSnapshot);
  });
});
