// T013/T014：棋盘创建、复制与碰撞判断测试（规格 S03.1）。
import { describe, expect, it } from 'vitest';
import { canPlace, cloneBoard, createEmptyBoard } from '../../src/game/board';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../src/game/constants';
import type { ActivePiece, Board } from '../../src/game/types';

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
  const piece = (type: ActivePiece['type'], rotation: ActivePiece['rotation'], x: number, y: number): ActivePiece => ({ type, rotation, x, y });

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
