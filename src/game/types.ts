// Neon Blocks — 核心类型与状态结构（规格 S03.1–S03.3）。
// 本文件仅类型定义，无运行时代码；game/ 层禁止访问 DOM/Canvas/localStorage。

/** 七种方块类型（S03.1）。 */
export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

/** 棋盘单元格：空格为 null，占用格存方块类型（S03.1）。 */
export type Cell = PieceType | null;

/** 棋盘：Cell[][]，10 列 × 24 行（行 0–3 隐藏，4–23 可见）；索引 [y][x]（S03.1）。 */
export type Board = Cell[][];

/** 旋转态：0–3，每次顺时针 90°（S03.1）。 */
export type Rotation = 0 | 1 | 2 | 3;

/** 活动方块；x/y 为形状方阵左上角在棋盘坐标系中的位置（S03.1）。 */
export interface ActivePiece {
  type: PieceType;
  rotation: Rotation;
  x: number;
  y: number;
}

/** 游戏状态机（S03.3）：页面初始 ready。 */
export type GameStatus = 'ready' | 'running' | 'paused' | 'gameover';

/**
 * 最近一次视觉事件（S03.3/S03.5）：
 * lock=锁定、hardDrop=硬降光尾、clear=消行、gameover=结束；
 * count 为消行块数（kind==='clear' 时给出）；id 单调递增供渲染层去重。
 */
export type LastEvent =
  | { id: number; kind: 'lock' | 'hardDrop' | 'clear' | 'gameover'; count?: number }
  | null;

/** 引擎完整状态快照（S03.2/S03.3）；engine.getState() 对外提供只读视图。 */
export interface GameState {
  /** 棋盘 [y][x]，24 行 × 10 列。 */
  board: Board;
  /** 当前活动方块；ready/gameover 时为 null。 */
  active: ActivePiece | null;
  /** 预览队列：running/paused 时恒为 5 枚，UI 仅显示前 3 枚（S03.2）。 */
  nextQueue: PieceType[];
  /** 当前 7-bag 剩余待发放序列（袋耗尽即重洗，S03.2）。 */
  bag: PieceType[];
  /** Hold 槽（S03.2）。 */
  heldType: PieceType | null;
  /** 当前块是否已使用过 Hold；锁定后重置（S03.2）。 */
  holdUsedThisPiece: boolean;
  /** 状态机。 */
  status: GameStatus;
  /** 累计得分（S03.5）。 */
  score: number;
  /** 累计消行数（S03.5）。 */
  lines: number;
  /** 等级 = 1 + floor(lines/10)（S03.5）。 */
  level: number;
  /** 重力累积毫秒（S03.3）。 */
  gravityElapsedMs: number;
  /** 锁定延迟累积毫秒（S03.3）。 */
  lockElapsedMs: number;
  /** 当前块已使用的锁定延迟重置次数，上限 15（S03.3）。 */
  lockResetCount: number;
  /** 最近一次视觉事件，供渲染层播放特效（S03.3）。 */
  lastEvent: LastEvent;
}
