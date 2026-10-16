// Neon Blocks — SRS 墙踢静态表与旋转尝试（规格 S03.4）。
// 表已按本项目屏幕坐标录入：y 向下为正；使用时不得再做二次变换或翻转 dy。
// `1` 为 R（顺时针）、`3` 为 L（逆时针）；不得用一组简单 ±1 通用踢墙替代。
import { canPlace } from './board';
import type { ActivePiece, Board, PieceType, Rotation } from './types';

/** 踢墙偏移 (dx, dy)，屏幕坐标，y 向下为正。 */
export type KickOffset = readonly [dx: number, dy: number];

/** 键为 `${from}${to}`（如 '01' 表示 0→1），值为按顺序测试的偏移序列。 */
export type KickTable = Readonly<Record<string, readonly KickOffset[]>>;

/** J/L/S/T/Z 共用踢墙表（S03.4 第一列，顺序逐项一致）。 */
export const JLSTZ_KICKS: KickTable = {
  '01': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '10': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '12': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '21': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '23': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '32': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '30': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '03': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

/** I 独立踢墙表（S03.4 第二列，顺序逐项一致）。 */
export const I_KICKS: KickTable = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

/** O 旋转不改变位置、不踢墙：仅恒等偏移。 */
export const O_KICKS: readonly KickOffset[] = [[0, 0]];

/**
 * 取得方块类型在旋转过渡 from→to 时应依次测试的偏移序列（顺序与 S03.4 表逐项一致）。
 * 非法过渡（如 0→2、1→3、同态）抛错；O 恒返回 [(0,0)]。
 */
export function getKickOffsets(type: PieceType, from: Rotation, to: Rotation): readonly KickOffset[] {
  if (type === 'O') {
    return O_KICKS;
  }
  const table = type === 'I' ? I_KICKS : JLSTZ_KICKS;
  const offsets = table[`${from}${to}`];
  if (offsets === undefined) {
    throw new Error(`getKickOffsets: 非法旋转过渡 ${from}→${to}（type=${type}）`);
  }
  return offsets;
}

/** 旋转方向：`1` 顺时针（R），`-1` 逆时针（L）。 */
export type RotateDirection = 1 | -1;

/**
 * 尝试旋转（规格 S03.4）：先计算循环目标旋转态（0→1→2→3→0 / 0→3→2→1→0），
 * 再按踢表顺序测试，遇首个可放置偏移即返回新 ActivePiece；
 * 全部失败则原样返回入参 piece（x/y/rotation 完全不变）。
 * O 旋转不改变位置、不踢墙；board 与入参 piece 均不修改。
 */
export function tryRotate(board: Board, piece: ActivePiece, dir: RotateDirection): ActivePiece {
  const to: Rotation = dir === 1
    ? (((piece.rotation + 1) % 4) as Rotation)
    : (((piece.rotation + 3) % 4) as Rotation);
  if (piece.type === 'O') {
    const rotated: ActivePiece = { ...piece, rotation: to };
    return canPlace(board, rotated) ? rotated : piece;
  }
  for (const [dx, dy] of getKickOffsets(piece.type, piece.rotation, to)) {
    const candidate: ActivePiece = { ...piece, rotation: to, x: piece.x + dx, y: piece.y + dy };
    if (canPlace(board, candidate)) {
      return candidate;
    }
  }
  return piece;
}
