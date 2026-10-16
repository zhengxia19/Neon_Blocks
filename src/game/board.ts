// Neon Blocks — 棋盘创建、复制、碰撞判断、锁入与消行（规格 S03.1,S03.5）。纯逻辑，无 DOM/随机。
import { BOARD_HEIGHT, BOARD_WIDTH } from './constants';
import { getMatrix } from './pieces';
import type { ActivePiece, Board, Cell } from './types';

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

/**
 * 判断方块在当前位置是否合法（S03.1）：只检查矩阵中为 '1' 的实体格；
 * 实体格左/右/上/下越界或与已锁定格重叠 → false；矩阵 '0' 格出界不影响。
 * 先做边界检查再索引，绝不产生非法索引或抛出。
 */
export function canPlace(board: Board, piece: ActivePiece): boolean {
  const matrix = getMatrix(piece.type, piece.rotation);
  const n = matrix.length;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (matrix[row][col] !== '1') {
        continue;
      }
      const x = piece.x + col;
      const y = piece.y + row;
      if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) {
        return false;
      }
      if (board[y][x] !== null) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 将方块锁入棋盘（S03.1/S03.5）：返回新 Board，绝不修改入参；
 * 每个实体格写入对应 PieceType；位置无效（越界或重叠）时显式抛错，
 * 绝不默默忽略（引擎只在 canPlace 通过的位置调用）。
 */
export function mergePiece(board: Board, piece: ActivePiece): Board {
  if (!canPlace(board, piece)) {
    throw new Error(
      `mergePiece: 无效落点（type=${piece.type} rot=${piece.rotation} x=${piece.x} y=${piece.y}）`,
    );
  }
  const next = cloneBoard(board);
  const matrix = getMatrix(piece.type, piece.rotation);
  const n = matrix.length;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (matrix[row][col] === '1') {
        next[piece.y + row][piece.x + col] = piece.type;
      }
    }
  }
  return next;
}

/** 消行结果：新棋盘与清除行数。 */
export interface ClearResult {
  board: Board;
  cleared: number;
}

/**
 * 一次性消除所有满行（S03.5）：筛掉全部 10 格皆非 null 的行，
 * 在顶部一次性补足 null 行；非满行相对顺序不变、整体下移 cleared 行
 * （不存在逐行消除造成的跳漏）。返回新 Board（行引用独立），入参不被修改。
 */
export function clearFullRows(board: Board): ClearResult {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - remaining.length;
  const next: Board = [];
  for (let i = 0; i < cleared; i += 1) {
    next.push(new Array<Cell>(BOARD_WIDTH).fill(null));
  }
  for (const row of remaining) {
    next.push([...row]);
  }
  return { board: next, cleared };
}
