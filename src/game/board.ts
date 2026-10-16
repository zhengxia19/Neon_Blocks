// Neon Blocks — 棋盘创建与复制（规格 S03.1）。纯逻辑，无 DOM/随机。
import { BOARD_HEIGHT, BOARD_WIDTH } from './constants';
import type { Board, Cell } from './types';

/** 创建 24×10 空棋盘（全部 null）。 */
export function createEmptyBoard(): Board {
  const board: Board = [];
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    const row: Cell[] = [];
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      row.push(null);
    }
    board.push(row);
  }
  return board;
}

/** 深复制棋盘：逐行新建数组（Cell 为不可变联合，浅拷贝格即可）。 */
export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}
