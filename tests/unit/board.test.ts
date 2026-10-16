// T013/T014/T015/T016/T019：棋盘创建、复制、碰撞判断、锁入、消行与幽灵落点测试（规格 S03.1,S03.2,S03.5,S04.1）。
import { describe, expect, it } from 'vitest';
import { canPlace, clearFullRows, cloneBoard, createEmptyBoard, getGhostY, mergePiece } from '../../src/game/board';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../src/game/constants';
import type { ActivePiece, Board, PieceType } from '../../src/game/types';

/** 构造 ActivePiece 的简写。 */
const piece = (type: ActivePiece['type'], rotation: ActivePiece['rotation'], x: number, y: number): ActivePiece => ({ type, rotation, x, y });

describe('createEmptyBoard（S03.1）', () => {
  it('尺寸恰为 24 行 × 每行 10 格', () => {
    const board = createEmptyBoard();
    expect(board).toHaveLength(BOARD_HEIGHT);
    for (const row of board) {
      expect(row).toHaveLength(BOARD_WIDTH);
    }
  });

  it('所有格初始为 null', () => {
    const board = createEmptyBoard();
    for (const row of board) {
      for (const cell of row) {
        expect(cell).toBeNull();
      }
    }
  });

  it('每次调用返回独立的新棋盘（行引用互不相同）', () => {
    const a = createEmptyBoard();
    const b = createEmptyBoard();
    expect(a).not.toBe(b);
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      expect(a[y]).not.toBe(b[y]);
    }
  });
});

describe('cloneBoard（S03.1）', () => {
  const lockedBoard = (): Board => {
    const board = createEmptyBoard();
    board[23][0] = 'I';
    board[23][9] = 'O';
    board[0][5] = 'T';
    return board;
  };

  it('复制后与原棋盘深相等', () => {
    const src = lockedBoard();
    expect(cloneBoard(src)).toEqual(src);
  });

  it('行引用完全独立（无共享行数组）', () => {
    const src = lockedBoard();
    const copy = cloneBoard(src);
    expect(copy).not.toBe(src);
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      expect(copy[y]).not.toBe(src[y]);
    }
  });

  it('修改复制不影响原棋盘', () => {
    const src = lockedBoard();
    const snapshot = cloneBoard(src);
    const copy = cloneBoard(src);
    copy[23][0] = null;
    copy[23][1] = 'J';
    copy[0][5] = null;
    expect(src).toEqual(snapshot);
  });

  it('修改原棋盘不影响已做的复制', () => {
    const src = lockedBoard();
    const copy = cloneBoard(src);
    const snapshot = cloneBoard(src);
    src[23][0] = null;
    src[10][10 - 1] = 'L';
    expect(copy).toEqual(snapshot);
  });
});

describe('canPlace（T014，S03.1）', () => {
  it('出生位置在空盘上合法', () => {
    expect(canPlace(createEmptyBoard(), piece('T', 0, 3, 2))).toBe(true);
  });

  it('矩阵 0 格出界不影响：I 竖态 x=-2 时实体格恰在第 0 列仍合法', () => {
    // I 1 态 = ["0010"×4]，x=-2 → 实体格 col=2 落在 x=0；col 0/1 的 0 格在界外。
    expect(canPlace(createEmptyBoard(), piece('I', 1, -2, 0))).toBe(true);
  });

  it('左越界拒绝：J 0 态 x=-1（实体格 col0 落在 x=-1）', () => {
    expect(canPlace(createEmptyBoard(), piece('J', 0, -1, 2))).toBe(false);
  });

  it('右越界拒绝：J 0 态 x=8（实体格 col2 落在 x=10）', () => {
    expect(canPlace(createEmptyBoard(), piece('J', 0, 8, 2))).toBe(false);
  });

  it('上越界拒绝：T 0 态 y=-1（实体格 row0 落在 y=-1）', () => {
    expect(canPlace(createEmptyBoard(), piece('T', 0, 3, -1))).toBe(false);
  });

  it('下越界拒绝：T 0 态 y=23（实体格 row1 落在 y=24）', () => {
    expect(canPlace(createEmptyBoard(), piece('T', 0, 3, 23))).toBe(false);
  });

  it('隐藏区合法：y=0（第 0 行）允许放置', () => {
    expect(canPlace(createEmptyBoard(), piece('O', 0, 3, 0))).toBe(true);
  });

  it('与锁定格重叠（穿透）拒绝，同位空盘则合法', () => {
    const board = createEmptyBoard();
    board[23][4] = 'I';
    // T 0 态实体格 row1 col0..2 → x=3..5, y=23 → 与 board[23][4] 重叠。
    expect(canPlace(board, piece('T', 0, 3, 22))).toBe(false);
    expect(canPlace(createEmptyBoard(), piece('T', 0, 3, 22))).toBe(true);
  });

  it('极端坐标不抛出、无非法索引：x=-10/y=100 返回 false', () => {
    const board = createEmptyBoard();
    expect(() => canPlace(board, piece('L', 3, -10, 100))).not.toThrow();
    expect(canPlace(board, piece('L', 3, -10, 100))).toBe(false);
    expect(() => canPlace(board, piece('S', 2, 99, -99))).not.toThrow();
    expect(canPlace(board, piece('S', 2, 99, -99))).toBe(false);
  });

  it('贴边合法：I 1 态 x=-2 与 x=7（实体列 0/9）均可，x=-3/x=8 均拒', () => {
    const board = createEmptyBoard();
    expect(canPlace(board, piece('I', 1, -2, 5))).toBe(true);
    expect(canPlace(board, piece('I', 1, 7, 5))).toBe(true);
    expect(canPlace(board, piece('I', 1, -3, 5))).toBe(false);
    expect(canPlace(board, piece('I', 1, 8, 5))).toBe(false);
  });
});

describe('mergePiece（T015，S03.1/S03.5）', () => {
  const nonNullCount = (board: Board): number =>
    board.reduce((sum, row) => sum + row.filter((c) => c !== null).length, 0);

  it('恰好新增四格且坐标正确：T 0 态 (3,2)', () => {
    const before = createEmptyBoard();
    const after = mergePiece(before, piece('T', 0, 3, 2));
    expect(nonNullCount(after)).toBe(4);
    expect(after[2][4]).toBe('T');
    expect(after[3][3]).toBe('T');
    expect(after[3][4]).toBe('T');
    expect(after[3][5]).toBe('T');
    expect(nonNullCount(before)).toBe(0); // 入参未被修改
  });

  it('写入的是对应 PieceType：I 竖态锁入后四格均为 I', () => {
    const after = mergePiece(createEmptyBoard(), piece('I', 1, -2, 20));
    for (let y = 20; y < 24; y += 1) {
      expect(after[y][0]).toBe('I');
    }
    expect(nonNullCount(after)).toBe(4);
  });

  it('返回新 Board：与原盘不同引用、行引用独立、原盘快照不变', () => {
    const src = createEmptyBoard();
    src[23][0] = 'J';
    const snapshot = cloneBoard(src);
    const after = mergePiece(src, piece('O', 0, 3, 20));
    expect(after).not.toBe(src);
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      expect(after[y]).not.toBe(src[y]);
    }
    expect(src).toEqual(snapshot);
    expect(nonNullCount(after)).toBe(5); // 预置 1 格（J）+ O 锁入 4 格
  });

  it('越界不默默忽略：上越界抛错', () => {
    expect(() => mergePiece(createEmptyBoard(), piece('T', 0, 3, -1))).toThrow(/无效落点/);
  });

  it('越界不默默忽略：右越界抛错', () => {
    expect(() => mergePiece(createEmptyBoard(), piece('J', 0, 8, 2))).toThrow(/无效落点/);
  });

  it('重叠不默默忽略：穿透锁定格抛错', () => {
    const board = createEmptyBoard();
    board[23][4] = 'I';
    expect(() => mergePiece(board, piece('T', 0, 3, 22))).toThrow(/无效落点/);
    expect(nonNullCount(board)).toBe(1); // 抛错后原盘未被改动
  });

  it('连续锁入两枚互不干扰且累计 8 格', () => {
    const b1 = mergePiece(createEmptyBoard(), piece('O', 0, 3, 20));
    const b2 = mergePiece(b1, piece('L', 0, 0, 21));
    expect(nonNullCount(b2)).toBe(8);
    expect(nonNullCount(b1)).toBe(4);
    expect(b2[21][2]).toBe('L');
    expect(b2[22][0]).toBe('L');
    expect(b2[22][1]).toBe('L');
    expect(b2[22][2]).toBe('L');
  });
});

describe('clearFullRows（T016，S03.5）', () => {
  const fillRow = (board: Board, y: number, type: PieceType = 'I'): void => {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      board[y][x] = type;
    }
  };
  const allNullRow = (row: readonly unknown[]): boolean => row.every((cell) => cell === null);

  it('清 0 行：cleared=0、深相等、返回新引用且行独立、入参不变', () => {
    const src = createEmptyBoard();
    src[23][0] = 'J';
    src[10][5] = 'T';
    const snapshot = cloneBoard(src);
    const { board: out, cleared } = clearFullRows(src);
    expect(cleared).toBe(0);
    expect(out).toEqual(snapshot);
    expect(out).not.toBe(src);
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      expect(out[y]).not.toBe(src[y]);
    }
    expect(src).toEqual(snapshot);
  });

  it('清 1 行：满行移除、顶部补 1 空行、其余行整体下移 1', () => {
    const src = createEmptyBoard();
    fillRow(src, 23);
    src[22][3] = 'T'; // 标记行：22 → 23
    src[0][9] = 'J';  // 标记行：0 → 1
    const { board: out, cleared } = clearFullRows(src);
    expect(cleared).toBe(1);
    expect(out).toHaveLength(BOARD_HEIGHT);
    for (const row of out) {
      expect(row).toHaveLength(BOARD_WIDTH);
    }
    expect(allNullRow(out[0])).toBe(true);
    expect(out[23][3]).toBe('T');
    expect(out[1][9]).toBe('J');
    expect(allNullRow(out[22])).toBe(true);
  });

  it('清 2 相邻行：22/23 满，标记 20→22，顶部 2 行为空', () => {
    const src = createEmptyBoard();
    fillRow(src, 22);
    fillRow(src, 23);
    src[20][0] = 'S';
    const { board: out, cleared } = clearFullRows(src);
    expect(cleared).toBe(2);
    expect(allNullRow(out[0])).toBe(true);
    expect(allNullRow(out[1])).toBe(true);
    expect(out[22][0]).toBe('S');
    expect(allNullRow(out[23])).toBe(true);
  });

  it('清 4 行：20–23 满，标记 19→23，顶部 4 行为空', () => {
    const src = createEmptyBoard();
    for (let y = 20; y <= 23; y += 1) {
      fillRow(src, y);
    }
    src[19][4] = 'Z';
    const { board: out, cleared } = clearFullRows(src);
    expect(cleared).toBe(4);
    for (let y = 0; y < 4; y += 1) {
      expect(allNullRow(out[y])).toBe(true);
    }
    expect(out[23][4]).toBe('Z');
    expect(allNullRow(out[22])).toBe(true);
  });

  it('非相邻满行（10 与 23）一次清 2：上方行下移 2、中间行下移 1，无跳漏', () => {
    const src = createEmptyBoard();
    fillRow(src, 10);
    fillRow(src, 23);
    src[5][1] = 'O';  // 在两条满行之上 → 下移 2：5 → 7
    src[11][1] = 'L'; // 在两满行之间 → 下移 1：11 → 12
    src[22][1] = 'I'; // 下移 1：22 → 23
    const { board: out, cleared } = clearFullRows(src);
    expect(cleared).toBe(2);
    expect(out[7][1]).toBe('O');
    expect(out[12][1]).toBe('L');
    expect(out[23][1]).toBe('I');
    expect(allNullRow(out[0])).toBe(true);
    expect(allNullRow(out[1])).toBe(true);
    expect(allNullRow(out[11])).toBe(true); // 原满行 10 的旧位置不再残留
    expect(allNullRow(out[22])).toBe(true);
  });

  it('全 24 行皆满：cleared=24，返回全新空盘仍为 24×10', () => {
    const src = createEmptyBoard();
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      fillRow(src, y);
    }
    const { board: out, cleared } = clearFullRows(src);
    expect(cleared).toBe(24);
    expect(out).toEqual(createEmptyBoard());
    expect(out).toHaveLength(BOARD_HEIGHT);
    for (const row of out) {
      expect(row).toHaveLength(BOARD_WIDTH);
      expect(allNullRow(row)).toBe(true);
    }
  });

  it('mergePiece 造成满行后消行：I 横态补满第 23 行即清 1 行', () => {
    let board = createEmptyBoard();
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      if (x < 4 || x > 7) {
        board[23][x] = 'J';
      }
    }
    board = mergePiece(board, piece('I', 0, 4, 22)); // I 0 态实体 row1 → (4..7, 23) 补满缺口
    board[21][3] = 'T';
    const { board: out, cleared } = clearFullRows(board);
    expect(cleared).toBe(1);
    expect(out[22][3]).toBe('T'); // 标记行 21 → 22
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      expect(out[23][x]).toBeNull(); // 原第 22 行为空 → 新第 23 行全空
    }
  });
});

describe('getGhostY（T019，S03.2/S04.1）', () => {
  it('空棋盘 T 0 态从出生点下探：贴底 y=22（实体最低行 row1 落在 23）', () => {
    const board = createEmptyBoard();
    const ghostY = getGhostY(board, piece('T', 0, 3, 2));
    expect(ghostY).toBe(22);
    expect(canPlace(board, piece('T', 0, 3, ghostY))).toBe(true);
    expect(canPlace(board, piece('T', 0, 3, ghostY + 1))).toBe(false);
  });

  it('空棋盘 I/O 各态按实体范围贴底：I 0 态 22、I 1 态 20、O 0 态 21', () => {
    const board = createEmptyBoard();
    expect(getGhostY(board, piece('I', 0, 3, 2))).toBe(22); // 实体 row1 → y+1=23
    expect(getGhostY(board, piece('I', 1, 0, 0))).toBe(20); // 实体 row0..3 → y+3=23
    expect(getGhostY(board, piece('O', 0, 3, 0))).toBe(21); // 实体 row1..2 → y+2=23
    expect(canPlace(board, piece('I', 1, 0, 21))).toBe(false);
    expect(canPlace(board, piece('O', 0, 3, 22))).toBe(false);
  });

  it('堆叠顶：T 停在锁定格上方不穿透（board[23][4]=T → y=21）', () => {
    const board = createEmptyBoard();
    board[23][4] = 'T';
    const ghostY = getGhostY(board, piece('T', 0, 3, 2));
    expect(ghostY).toBe(21);
    expect(canPlace(board, piece('T', 0, 3, ghostY))).toBe(true);
    expect(canPlace(board, piece('T', 0, 3, ghostY + 1))).toBe(false);
  });

  it('缺口下探：I 0 态落入第 23 行缺口贴底 y=22', () => {
    const board = createEmptyBoard();
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      if (x < 4 || x > 7) {
        board[23][x] = 'J';
      }
    }
    const ghostY = getGhostY(board, piece('I', 0, 4, 2));
    expect(ghostY).toBe(22);
    expect(canPlace(board, piece('I', 0, 4, ghostY))).toBe(true);
    expect(canPlace(board, piece('I', 0, 4, ghostY + 1))).toBe(false);
  });

  it('已在底部：返回与入参相同的 y（不再下移）', () => {
    const board = createEmptyBoard();
    expect(getGhostY(board, piece('T', 0, 3, 22))).toBe(22);
    const stacked = createEmptyBoard();
    stacked[23][4] = 'Z';
    // S 1 态实体 (3,y),(3,y+1),(4,y+1),(4,y+2)：y=20 时 (4,22) 空、y=21 时 (4,23) 撞锁定格。
    expect(getGhostY(stacked, piece('S', 1, 2, 20))).toBe(20);
  });

  it('无状态副作用：不修改棋盘与 piece，重复调用结果一致', () => {
    const board = createEmptyBoard();
    board[23][4] = 'Z';
    const p = piece('S', 1, 2, 5);
    const boardSnapshot = cloneBoard(board);
    const pieceSnapshot = { ...p };
    const first = getGhostY(board, p);
    const second = getGhostY(board, p);
    expect(first).toBe(20); // (4,23) 被占 → 停在 y=20
    expect(second).toBe(first);
    expect(board).toEqual(boardSnapshot);
    expect(p).toEqual(pieceSnapshot);
    expect(canPlace(board, piece('S', 1, 2, first + 1))).toBe(false);
  });
});
