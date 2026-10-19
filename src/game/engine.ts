// T022/T023/T024/T025/T026/T027：GameEngine 类——私有状态、初始 ready 状态、NEXT 队列补充与出生活动块、
// 水平移动、顺逆旋转、单次软降、硬降立即锁块（规格 S03.1,S03.2,S03.3,S03.4,S03.5）。
// 纯逻辑模块：不访问 DOM/Canvas/localStorage；UI 仅经 getState() 只读视图读取状态。
// 动作 API（move/rotate/softDrop/…）由 T024+ 逐个补齐。
import { canPlace, clearFullRows, cloneBoard, createEmptyBoard, getGhostY, mergePiece } from './board';
import { drawFromBag } from './random';
import { dropPoints } from './scoring';
import { tryRotate } from './srs';
import type { ActivePiece, Board, Cell, GameState, PieceType, Rotation } from './types';

/** 出生列（S03.2：出生位置 x=3）。constants.ts 不在本任务允许修改文件内，故在此定义。 */
const SPAWN_X = 3;
/** 出生行（S03.2：出生位置 y=2，位于隐藏行）。 */
const SPAWN_Y = 2;
/** 出生旋转态（S03.2：r0）。 */
const SPAWN_ROTATION: Rotation = 0;
/** NEXT 队列长度（S03.2：始终补充到 5，UI 仅显示前 3）。 */
const NEXT_QUEUE_SIZE = 5;

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

  /**
   * 补充 NEXT 队列到 5（S03.2）：经 7-bag `drawFromBag` 逐枚抽取（随机仅在袋空时消耗），
   * 同步更新内部袋；不改变其他字段。
   */
  #refillQueue(): void {
    while (this.#state.nextQueue.length < NEXT_QUEUE_SIZE) {
      const draw = drawFromBag(this.#state.bag, this.#rng);
      this.#state.bag = [...draw.bag];
      this.#state.nextQueue.push(draw.type);
    }
  }

  /**
   * 生成下一块（S03.2）：先补队列再 shift 队首，在 x=3/y=2/r0 放置，随后补回队列，
   * 使 NEXT 在任何时刻均为 5。入场碰撞（出生位置与锁定格重叠）→ status=gameover、
   * active=null。新块开始：holdUsedThisPiece 复位，重力/锁定计时复位（S03.3 计时基准）。
   */
  #spawnNext(): void {
    this.#refillQueue();
    const type = this.#state.nextQueue.shift();
    if (type === undefined) {
      throw new Error('spawnNext: 补充后 NEXT 仍为空（不应发生）');
    }
    this.#refillQueue();
    const piece: ActivePiece = {
      type,
      rotation: SPAWN_ROTATION,
      x: SPAWN_X,
      y: SPAWN_Y,
    };
    if (!canPlace(this.#state.board, piece)) {
      this.#state.active = null;
      this.#state.status = 'gameover';
      return;
    }
    this.#state.active = piece;
    this.#state.holdUsedThisPiece = false;
    this.#state.gravityElapsedMs = 0;
    this.#state.lockElapsedMs = 0;
    this.#state.lockResetCount = 0;
  }

  /**
   * 旋转（S03.3/S03.4）：仅 running 且存在活动块时处理；直接委托 `srs.tryRotate`
   * （引擎不实现第二套自制踢墙），成功返回的新位置和旋转态写回 state，
   * 全败时 tryRotate 原样返回入参引用，状态完全不变。旋转本身不加分。
   */
  rotate(dir: 1 | -1): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    this.#state.active = tryRotate(this.#state.board, this.#state.active, dir);
  }

  /**
   * 开始游戏（S03.2/S03.3）：仅 ready→running，其余状态调用无效；
   * 进入 running 即生成第一块（ready 时 NEXT 可为空，running 后始终为 5）。
   */
  start(): void {
    if (this.#state.status !== 'ready') {
      return;
    }
    this.#state.status = 'running';
    this.#spawnNext();
  }

  /**
   * 水平移动（S03.3）：仅 running 且存在活动块时处理；经 `canPlace` 判定新 x，
   * 横向不能穿过边界/锁定块。成功只改 active.x（不加分、不动其他字段）；
   * 非法移动彻底不改变状态（原子失败，S03.1）。
   */
  move(dx: -1 | 1): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    const moved: ActivePiece = { ...this.#state.active, x: this.#state.active.x + dx };
    if (canPlace(this.#state.board, moved)) {
      this.#state.active = moved;
    }
  }

  /**
   * 单次软降（S03.3/S03.5）：仅 running 且存在活动块时处理；经 `canPlace` 判定
   * 下方一格，可行则 y+1 并按 `dropPoints('soft', 1)` 加 1 分（计分唯一来源为
   * scoring 模块，软降分与自然重力分独立、不双重加分）。不能下降时保持位置、
   * 分数不变、不立即锁定（锁定由 step 的 500ms 延迟计时处理，T028/T029）。
   */
  softDrop(): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    const moved: ActivePiece = { ...this.#state.active, y: this.#state.active.y + 1 };
    if (canPlace(this.#state.board, moved)) {
      this.#state.active = moved;
      this.#state.score += dropPoints('soft', 1);
    }
    // 不可下降：状态完全不变（无事件、无锁定，S03.3）
  }

  /**
   * 硬降并立即锁块（S03.3/S03.5）：仅 running 且存在活动块时处理。
   * 流程：`getGhostY` 求落点 → 落差 = ghostY − y，加分 `dropPoints('hard', 落差)`
   * （0 格 +0）→ 发出 hardDrop 事件（count=落差，id 单调递增）→ 立即锁入棋盘
   * （不等锁定延迟）→ 清行并记录数量 → 生成下一块。
   * 本任务仅保证锁定/清行/事件正确：清行得分、lines 与等级累计统一在 T033
   * 补齐（此处不写临时计分公式），事件 id 经 `#eventSeq` 自增供渲染层去重。
   */
  hardDrop(): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    const active = this.#state.active;
    const ghostY = getGhostY(this.#state.board, active);
    const distance = ghostY - active.y;
    this.#state.score += dropPoints('hard', distance);
    this.#eventSeq += 1;
    this.#state.lastEvent = { id: this.#eventSeq, kind: 'hardDrop', count: distance };
    const landed: ActivePiece = { ...active, y: ghostY };
    this.#state.board = mergePiece(this.#state.board, landed);
    const clear = clearFullRows(this.#state.board);
    this.#state.board = clear.board;
    // clear.cleared（0..4）的得分/行数/等级结算在 T033 接入锁定路径统一处理。
    this.#spawnNext();
  }

  /** 只读状态快照（S03.3）：嵌套数组同为只读视图，UI 不得修改。 */
  getState(): GameStateView {
    return this.#state;
  }
}
