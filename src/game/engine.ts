// T022：GameEngine 类骨架——私有状态与初始 ready 状态（规格 S03.2,S03.3）。
// 纯逻辑模块：不访问 DOM/Canvas/localStorage；UI 仅经 getState() 只读视图读取状态。
// 动作 API（start/move/rotate/…）由 T023+ 逐个补齐，本任务只建立类与初态。
import { cloneBoard, createEmptyBoard } from './board';
import type { Board, Cell, GameState, PieceType } from './types';

/**
 * 深度只读状态视图（S03.3）：顶层属性与嵌套数组（board 行、nextQueue、bag）
 * 在类型层面均为 readonly，UI/渲染层不得直接修改引擎内部状态。
 */
export type GameStateView = Omit<Readonly<GameState>, 'board' | 'nextQueue' | 'bag'> & {
  readonly board: readonly (readonly Cell[])[];
  readonly nextQueue: readonly PieceType[];
  readonly bag: readonly PieceType[];
};

/** 游戏引擎（S03.2/S03.3）：持有全部可变状态，外部只能经只读视图观察。 */
export class GameEngine {
  #state: GameState;
  #rng: () => number;
  /** 事件自增序号：lastEvent.id 单调递增供渲染层去重（S03.3，T027+ 事件任务使用）。 */
  #eventSeq = 0;

  /**
   * @param rng 随机源（默认 Math.random）；测试可注入确定性 rng（S03.2 7-bag）。
   * @param initialBoard 初始棋盘（默认空棋盘）；仅为确定性边界测试注入，
   *                     正常应用不传，restart 始终从空棋盘开始（S03.3）。
   */
  constructor(rng: () => number = Math.random, initialBoard?: Board) {
    this.#rng = rng;
    this.#state = {
      board: initialBoard !== undefined ? cloneBoard(initialBoard) : createEmptyBoard(),
      active: null,
      nextQueue: [],
      bag: [],
      heldType: null,
      holdUsedThisPiece: false,
      status: 'ready',
      score: 0,
      lines: 0,
      level: 1,
      gravityElapsedMs: 0,
      lockElapsedMs: 0,
      lockResetCount: 0,
      lastEvent: null,
    };
    this.#assertInternals();
  }

  /**
   * 内部构造后断言：rng 必须可调用（TS 类型无法约束 JS 调用方，显式拒绝非法注入），
   * 事件序号从 0 起（首个事件 id=1，S03.3 单调递增，T027+ 事件任务消费）。
   */
  #assertInternals(): void {
    if (typeof this.#rng !== 'function') {
      throw new TypeError(`GameEngine rng 必须为函数，实际：${String(this.#rng)}`);
    }
    if (this.#eventSeq !== 0) {
      throw new Error('GameEngine 内部错误：事件序号初值非 0');
    }
  }

  /** 只读状态快照（S03.3）：嵌套数组同为只读视图，UI 不得修改。 */
  getState(): GameStateView {
    return this.#state;
  }
}
