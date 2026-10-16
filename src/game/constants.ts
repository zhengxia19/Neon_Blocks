// Neon Blocks — 棋盘与时间常量（规格 S03.1、S03.3）。
// 全项目唯一数值来源：其他模块必须导入本文件，禁止重复魔法数字。
// 本文件不导入任何模块，天然无循环引用。

/** 棋盘列数（S03.1）。 */
export const BOARD_WIDTH = 10;
/** 棋盘总行数，含隐藏行（S03.1）。 */
export const BOARD_HEIGHT = 24;
/** 顶部隐藏行数（行 0–3）（S03.1）。 */
export const HIDDEN_ROWS = 4;
/** 可见行数（行 4–23）（S03.1）。 */
export const VISIBLE_ROWS = 20;

/** 锁定延迟毫秒（S03.3）。 */
export const LOCK_DELAY_MS = 500;
/** 每块锁定延迟重置次数上限（S03.3）。 */
export const LOCK_RESET_LIMIT = 15;

/** 左右方向键首次按住到连续移动的延迟毫秒（S03.3）。 */
export const DAS_MS = 150;
/** 连续移动间隔毫秒（S03.3）。 */
export const ARR_MS = 45;
/** 软降长按重复间隔毫秒（S03.3）。 */
export const SOFT_DROP_MS = 35;

/** 等级 1–10 的重力下落间隔毫秒表，索引 = level-1（S03.3）。 */
export const GRAVITY_MS = [
  900, 750, 620, 510, 420, 350, 290, 240, 200, 170,
] as const;
