// Neon Blocks — 长按重复控制器（规格 S03.3/S06，任务 T051）。
// 无独立计时器：由主循环 update(dtMs)（rAF）驱动，抬键即停、失焦 releaseAll。
// 左右方向只响应单次按下；软降间隔 35ms，可长按连续触发。

/** 首次按住后的重复延迟（DAS，S03.3）。 */
export const DAS_MS = 150;

/** DAS 结束后的重复间隔（ARR，S03.3）。 */
export const ARR_MS = 45;

/** 软降长按的固定间隔（S03.3）。 */
export const SOFT_MS = 35;

/** 单帧 update 内最多补发的次数（掉帧追赶上限，防 dt 异常导致动作风暴）。 */
const MAX_REFIRE_PER_UPDATE = 10;

export type HoldDirection = 'left' | 'right';

/** RepeatController 触发的动作（装配层绑定到 Engine 方法）。 */
export interface RepeatActions {
  move(direction: -1 | 1): void;
  softDrop(): void;
}

/**
 * 长按节奏状态机：press 立即执行一次并进入 DAS；DAS 归零后每 ARR 执行一次。
 * 时间完全来自 update(dt) 累加——不创建 setInterval/timeout（S05 单循环）。
 */
export class RepeatController {
  readonly #actions: RepeatActions;
  #softHeld = false;
  #softRemain = 0;

  constructor(actions: RepeatActions) {
    this.#actions = actions;
  }

  /** 按住方向：立即执行一次；若另一方向在按住则覆盖（最后按下优先）。 */
  pressDirection(direction: HoldDirection): void {
    // 左右方向只在按下时移动一格，不允许长按重复。
    this.#actions.move(direction === 'left' ? -1 : 1);
  }

  /** 松开方向：若当前活动方向被释放而另一方向仍按住，恢复另一方向（立即一步）。 */
  releaseDirection(direction: HoldDirection): void {
    // 方向移动是一次性操作，无需维护松开后的重复状态。
    void direction;
  }

  /** 按住软降：立即执行一次，之后每 SOFT_MS 一次。 */
  pressSoft(): void {
    this.#softHeld = true;
    this.#actions.softDrop();
    this.#softRemain = SOFT_MS;
  }

  releaseSoft(): void {
    this.#softHeld = false;
  }

  /** 释放全部按住状态（失焦 / 切后台，T051 步骤 2）。 */
  releaseAll(): void {
    this.#softHeld = false;
  }

  /** 是否仍有按住的方向（装配层可据此显示按压反馈）。 */
  get holdingDirection(): HoldDirection | null {
    return null;
  }

  /**
   * 主循环每帧推进 dtMs：DAS/ARR/软降节奏全在此累加。dt 极大（掉帧/后台恢复）
   * 时单次最多补发 MAX_REFIRE_PER_UPDATE 次，其余丢弃（不做时间旅行追赶）。
   */
  update(dtMs: number): void {
    if (dtMs <= 0) {
      return;
    }
    let refires = 0;
    if (this.#softHeld) {
      this.#softRemain -= dtMs;
      while (this.#softRemain <= 0 && refires < MAX_REFIRE_PER_UPDATE + 6) {
        this.#actions.softDrop();
        refires += 1;
        this.#softRemain += SOFT_MS;
      }
    }
  }
}
