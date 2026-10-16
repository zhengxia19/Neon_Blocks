// T013：棋盘创建与复制测试（规格 S03.1）。
import { describe, expect, it } from 'vitest';
import { cloneBoard, createEmptyBoard } from '../../src/game/board';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../src/game/constants';
import type { Board } from '../../src/game/types';

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
