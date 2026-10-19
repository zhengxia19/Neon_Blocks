// T022–T033：GameEngine 类——私有状态、初始 ready 状态、NEXT 队列补充与出生活动块、
// 水平移动、顺逆旋转、单次软降、硬降立即锁块、基于 dt 的自然重力、
// 落地锁定延迟与限次重置、Hold 单块一次、重开与暂停状态转换、
// block-out/lock-out 结束、清行积分/行数/等级结算（规格 S03.1–S03.5）。
// 纯逻辑模块：不访问 DOM/Canvas/localStorage；UI 仅经 getState() 只读视图读取状态。
// 动作 API（move/rotate/softDrop/…）由 T024+ 逐个补齐。
import { canPlace, clearFullRows, cloneBoard, createEmptyBoard, getGhostY, mergePiece } from './board';
import { HIDDEN_ROWS, LOCK_DELAY_MS, LOCK_RESET_LIMIT } from './constants';
import { drawFromBag } from './random';
import { dropPoints, gravityIntervalMs, levelForLines, lineClearPoints } from './scoring';
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
/** 单次 step 可接受的最大 delta（S03.3：单次上限 100ms，超出按 100 截断）。 */
const MAX_STEP_MS = 100;
/** 单帧重力循环最多移动格数（S03.3：避免卡顿循环）。 */
const MAX_GRAVITY_MOVES = 20;

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
    this.#spawnType(type);
  }

  /**
   * 结束游戏（S03.3/T032）：status=gameover、active=null，并携带唯一自增 id
   * 发出 gameover 事件。block-out（出生碰撞）与 lock-out（锁定后隐藏行 0..3
   * 仍被占用）两类 top-out 共用本路径；结束后所有输入因 running 守卫失效。
   */
  #endGame(): void {
    this.#state.active = null;
    this.#state.status = 'gameover';
    this.#eventSeq += 1;
    this.#state.lastEvent = { id: this.#eventSeq, kind: 'gameover' };
  }

  /**
   * lock-out 检测（S03.1/S03.3/T032）：锁定与清行完成后，隐藏区（第 0..
   * `HIDDEN_ROWS`−1 行）若仍有锁定格，说明堆栈顶出可视区 → 判负。
   */
  #hasHiddenOccupancy(): boolean {
    for (let y = 0; y < HIDDEN_ROWS; y += 1) {
      for (const cell of this.#state.board[y]) {
        if (cell !== null) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 在出生位置放置指定类型（S03.2）：x=3/y=2/r0；入场碰撞（与锁定格重叠）→
   * block-out（`#endGame`：gameover + 事件，active=null）。成功则开始新块：
   * holdUsedThisPiece 复位、重力/锁定计时复位（S03.3 计时基准）。
   * #spawnNext 与 Hold 交换共用本路径。
   */
  #spawnType(type: PieceType): void {
    const piece: ActivePiece = {
      type,
      rotation: SPAWN_ROTATION,
      x: SPAWN_X,
      y: SPAWN_Y,
    };
    if (!canPlace(this.#state.board, piece)) {
      this.#endGame(); // block-out（S03.3）
      return;
    }
    this.#state.active = piece;
    this.#state.holdUsedThisPiece = false;
    this.#state.gravityElapsedMs = 0;
    this.#state.lockElapsedMs = 0;
    this.#state.lockResetCount = 0;
  }

  /**
   * Hold 单块一次（S03.2）：仅 running 且存在活动块时处理；本块已用过
   * （`holdUsedThisPiece`，锁定前）再次调用无效。槽空时：active.type 存入槽、
   * 从 NEXT 队首生成新块；槽已有方块时：与槽内容互换，换入块恢复 r0/x=3/y=2
   * （复用 `#spawnType`，入场碰撞 → gameover）。生成新块即复位 hold 限制
   * （成功锁定/换入后下一块可用），本任务测试覆盖锁定后路径。Hold 不随机偷换、
   * 不跳队列（shift 队首后立即补满至 5）。无事件、不加分。
   */
  hold(): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    if (this.#state.holdUsedThisPiece) {
      return; // 锁定前每块仅一次（S03.2）
    }
    const currentType = this.#state.active.type;
    if (this.#state.heldType === null) {
      this.#state.heldType = currentType;
      this.#spawnNext(); // 从队列生成（shift 队首→补队列）
    } else {
      const swapType = this.#state.heldType;
      this.#state.heldType = currentType;
      this.#spawnType(swapType); // 槽内容换入出生位置
    }
    this.#state.holdUsedThisPiece = true; // #spawn* 已复位为 false，本块重新上锁
  }

  /**
   * 清行结算（S03.5/T033，两条锁定路径共用）：`cleared`>0 时按清行发生**之前**
   * 的等级 `lineClearPoints` 加分、累计 `lines` 并经 `levelForLines` 重算等级，
   * 最后发出 `clear` 事件（count=行数，供渲染特效；同帧覆盖 hardDrop/lock 事件，
   * 与 S03.3 “消行视觉事件 clear 优先”一致）。加分一次且仅一次：本方法仅在
   * 锁定后清行处调用，不与其他加分路径重叠。
   */
  #settleClear(cleared: number): void {
    if (cleared <= 0) {
      return;
    }
    this.#state.score += lineClearPoints(cleared, this.#state.level); // 等级取清行前
    this.#state.lines += cleared;
    this.#state.level = levelForLines(this.#state.lines);
    this.#eventSeq += 1;
    this.#state.lastEvent = { id: this.#eventSeq, kind: 'clear', count: cleared };
  }

  /**
   * 锁定当前活动块（S03.3，自然锁定路径；hardDrop 的立即锁定在 T027 内联）：
   * `mergePiece` 锁入 → `clearFullRows` 一次性清行 → 发出 `lock` 事件
   * （count=消行数，id 单调递增）→ 清行结算（T033：得分/lines/等级+`clear`
   * 事件）→ lock-out 检查（T032：清行后隐藏行 0..3 仍被占用 → `#endGame`
   * 且不再生成新块）→ 否则生成下一块。
   */
  #lockPiece(): void {
    const active = this.#state.active;
    if (active === null) {
      return;
    }
    this.#state.board = mergePiece(this.#state.board, active);
    const clear = clearFullRows(this.#state.board);
    this.#state.board = clear.board;
    this.#eventSeq += 1;
    this.#state.lastEvent = { id: this.#eventSeq, kind: 'lock', count: clear.cleared };
    this.#settleClear(clear.cleared);
    if (this.#hasHiddenOccupancy()) {
      this.#endGame(); // lock-out（S03.1/S03.3）：不再生成下一块
      return;
    }
    this.#spawnNext();
  }

  /**
   * 成功动作后的落地检查（S03.3 锁定延迟重置）：着地且计时 >0 时重置计时并
   * 消耗一次重置配额（每块最多 `LOCK_RESET_LIMIT=15` 次）；离地仅清零计时、
   * 不消耗配额（重置次数保留，重落地重新计时）。失败动作不调用本方法。
   */
  #onSuccessfulAction(): void {
    if (this.#state.active === null) {
      return;
    }
    const grounded = !canPlace(this.#state.board, {
      ...this.#state.active,
      y: this.#state.active.y + 1,
    });
    if (!grounded) {
      this.#state.lockElapsedMs = 0; // 离地：停止地面计时，保留 lockResetCount
      return;
    }
    if (this.#state.lockElapsedMs > 0 && this.#state.lockResetCount < LOCK_RESET_LIMIT) {
      this.#state.lockElapsedMs = 0;
      this.#state.lockResetCount += 1;
    }
  }

  /**
   * 水平移动（S03.3）：仅 running 且存在活动块时处理；经 `canPlace` 判定新 x，
   * 横向不能穿过边界/锁定块。成功只改 active.x（不加分、不动其他字段），
   * 着地成功时经 `#onSuccessfulAction` 参与锁定延迟限次重置（T029）；
   * 非法移动彻底不改变状态（原子失败，S03.1）。
   */
  move(dx: -1 | 1): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    const moved: ActivePiece = { ...this.#state.active, x: this.#state.active.x + dx };
    if (canPlace(this.#state.board, moved)) {
      this.#state.active = moved;
      this.#onSuccessfulAction();
    }
  }

  /**
   * 旋转（S03.3/S03.4）：仅 running 且存在活动块时处理；直接委托 `srs.tryRotate`
   * （引擎不实现第二套自制踢墙），成功返回的新位置和旋转态写回 state，
   * 全败时 tryRotate 原样返回入参引用，状态完全不变、不消耗重置配额。
   * 旋转本身不加分；着地成功经 `#onSuccessfulAction` 参与限次重置（T029）。
   */
  rotate(dir: 1 | -1): void {
    if (this.#state.status !== 'running' || this.#state.active === null) {
      return;
    }
    const before = this.#state.active;
    const next = tryRotate(this.#state.board, before, dir);
    this.#state.active = next;
    if (next !== before) {
      this.#onSuccessfulAction();
    }
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
   * 重开（S03.3）：任意状态（ready/running/paused/gameover）均清空全部进度
   * （空棋盘、分数/行数/等级归零、Hold 槽与限制清除、队列与袋清空、三计时器
   * 复位、lastEvent 置 null）并立即进入 running 生成第一块。restart 始终从
   * 空棋盘开始（initialBoard 仅构造注入，不在此复用）。事件自增序号跨局保留，
   * 保证渲染层按 id 去重不受重开影响。
   */
  restart(): void {
    this.#state.board = createEmptyBoard();
    this.#state.active = null;
    this.#state.nextQueue = [];
    this.#state.bag = [];
    this.#state.heldType = null;
    this.#state.holdUsedThisPiece = false;
    this.#state.status = 'running'; // 先置 running 令 #spawnNext 正常生效
    this.#state.score = 0;
    this.#state.lines = 0;
    this.#state.level = 1;
    this.#state.gravityElapsedMs = 0;
    this.#state.lockElapsedMs = 0;
    this.#state.lockResetCount = 0;
    this.#state.lastEvent = null;
    this.#spawnNext();
  }

  /**
   * 暂停/恢复（S03.3）：running↔paused 双向切换；ready/gameover 下调用无效。
   * paused 下 move/rotate/softDrop/hardDrop/hold/step 全部无效（各方法均守卫
   * `status === 'running'`），恢复后按累积计时继续。
   */
  togglePause(): void {
    if (this.#state.status === 'running') {
      this.#state.status = 'paused';
    } else if (this.#state.status === 'paused') {
      this.#state.status = 'running';
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
    // 清行结算（T033）：得分/lines/等级 + clear 事件（消行时覆盖 hardDrop 事件，
    // 视觉 clear 优先，S03.3）。
    this.#settleClear(clear.cleared);
    if (this.#hasHiddenOccupancy()) {
      this.#endGame(); // lock-out（T032）：硬降锁入隐藏行 → 结束，不生成新块
      return;
    }
    this.#spawnNext();
  }

  /**
   * 基于 dt 的自然重力（S03.3）：非 running 直接返回；delta 非有限（NaN/Infinity）
   * 或负数一律按 0 处理，单次有效增量上限 100ms。重力时间累积到当前等级间隔
   * （`gravityIntervalMs(level)`）即下降一格，可循环处理多格但最多 20 次；
   * 不能下降（触底）时时间照常累积但不移动、不给分——不依赖 setInterval，
   * 由外部唯一的 requestAnimationFrame 循环驱动。自然下落零加分。
   */
  step(dtMs: number): void {
    if (this.#state.status !== 'running') {
      return;
    }
    const delta = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, MAX_STEP_MS) : 0;
    this.#state.gravityElapsedMs += delta;
    if (this.#state.active === null) {
      return;
    }
    const interval = gravityIntervalMs(this.#state.level);
    let moves = 0;
    while (moves < MAX_GRAVITY_MOVES && this.#state.gravityElapsedMs >= interval) {
      const moved: ActivePiece = { ...this.#state.active, y: this.#state.active.y + 1 };
      if (!canPlace(this.#state.board, moved)) {
        break; // 触底：保持时间累积，锁定延迟计时在 T029 接管
      }
      this.#state.active = moved;
      this.#state.gravityElapsedMs -= interval;
      moves += 1;
    }
    // 落地锁定延迟（S03.3/T029）：着地时按本次 delta 累计，满 LOCK_DELAY_MS 即锁定
    // （走 #lockPiece：锁入→清行→发事件→生新块）；离地仅清零计时、保留重置次数。
    if (this.#state.active !== null) {
      const grounded = !canPlace(this.#state.board, {
        ...this.#state.active,
        y: this.#state.active.y + 1,
      });
      if (grounded) {
        this.#state.lockElapsedMs += delta;
        if (this.#state.lockElapsedMs >= LOCK_DELAY_MS) {
          this.#lockPiece();
        }
      } else {
        this.#state.lockElapsedMs = 0;
      }
    }
  }

  /** 只读状态快照（S03.3）：嵌套数组同为只读视图，UI 不得修改。 */
  getState(): GameStateView {
    return this.#state;
  }
}
