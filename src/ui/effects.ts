// Neon Blocks — 清行/硬降短特效控制器（规格 S04.1/S08，任务 T045）。
// 消费 engine.lastEvent.id：同一事件 id 只触发一次（重复渲染不无限重播）；
// 效果在到期后由 update/snapshot 自动清理；渲染只读快照，不修改棋盘。
// reducedMotion 开启时 consume 直接忽略新事件（无 blur/粒子等昂贵绘制，S04.1）。

/** 引擎事件的读数子集（与 GameState.lastEvent 形状兼容）。 */
export interface EffectEvent {
  id: number;
  kind: 'lock' | 'hardDrop' | 'clear' | 'gameover';
  count?: number;
}

/** 一条进行中的视觉效果（时间为 performance.now 时间轴上的毫秒）。 */
export interface ActiveEffect {
  kind: 'clear' | 'hardDrop';
  startedAt: number;
  durationMs: number;
  /** clear：被清除的棋盘行（内部行号 4..23）；hardDrop：落点起始可见行。 */
  rows: number[];
  /** hardDrop： affected 列号（0..9）。 */
  cols: number[];
}

/** 清行闪烁+横向扫光时长（S04.1：约 140ms）。 */
export const CLEAR_EFFECT_MS = 140;

/** 硬降竖直光尾时长（S04.1：120ms）。 */
export const HARD_DROP_EFFECT_MS = 120;

/**
 * 从上一帧棋盘快照推导被清除的行：上一帧中整行填满、且数量与事件 count 一致
 * 的行即被清除行（内部行号 4..23）。无上一帧信息时回退为底部 count 行。
 */
function deriveClearedRows(previousBoard: readonly (readonly (string | null)[])[] | null, count: number): number[] {
  if (previousBoard !== null && previousBoard.length >= 24) {
    const fullRows: number[] = [];
    for (let row = 4; row < 24; row += 1) {
      const line = previousBoard[row];
      if (line && line.length >= 10 && line.every((cell) => cell !== null && cell !== undefined)) {
        fullRows.push(row);
      }
    }
    if (fullRows.length > 0) {
      // 与事件行数对齐：取最近（最靠下）的 count 行。
      return fullRows.slice(Math.max(0, fullRows.length - Math.max(1, count)));
    }
  }
  const n = Math.min(4, Math.max(1, count));
  return Array.from({ length: n }, (_, i) => 24 - n + i);
}

/** 计算活动块占用的列（供硬降光尾定位）。 */
export function occupiedCols(piece: { type: string; x: number; y: number; rotation: number } | null, matrix: readonly string[]): number[] {
  if (piece === null) {
    return [];
  }
  const cols = new Set<number>();
  for (const line of matrix) {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '1') {
        cols.add(piece.x + i);
      }
    }
  }
  return [...cols].sort((a, b) => a - b);
}

/**
 * 特效控制器：由渲染循环（或测试）以显式时间调用 consume/snapshot；
 * 内部无定时器、无 DOM——清理完全由时间到期驱动（S05 单循环）。
 */
export class EffectsController {
  #consumedEventId: number | null = null;
  #effects: ActiveEffect[] = [];

  /**
   * 消费引擎状态中的 lastEvent：id 与上次已消费不同才触发（禁止同事件反复触发，
   * T045 步骤 1）。`previousBoard`/`droppedPiece` 供推导清除行与光尾位置。
   */
  consume(
    lastEvent: EffectEvent | null,
    nowMs: number,
    context: {
      previousBoard?: readonly (readonly (string | null)[])[] | null;
      reducedMotion?: boolean;
      clearRows?: number[];
      hardDropCols?: number[];
      hardDropRow?: number;
    } = {},
  ): void {
    if (lastEvent === null || lastEvent.id === this.#consumedEventId) {
      return;
    }
    this.#consumedEventId = lastEvent.id;
    if (context.reducedMotion === true) {
      return; // 减少动画：直接取消效果（S04.1/S08）
    }
    if (lastEvent.kind === 'clear' && (lastEvent.count ?? 0) > 0) {
      this.#effects.push({
        kind: 'clear',
        startedAt: nowMs,
        durationMs: CLEAR_EFFECT_MS,
        rows: context.clearRows ?? deriveClearedRows(context.previousBoard ?? null, lastEvent.count ?? 1),
        cols: [],
      });
    } else if (lastEvent.kind === 'hardDrop' && (lastEvent.count ?? 0) > 0) {
      const cols = context.hardDropCols ?? [];
      if (cols.length > 0) {
        this.#effects.push({
          kind: 'hardDrop',
          startedAt: nowMs,
          durationMs: HARD_DROP_EFFECT_MS,
          rows: [context.hardDropRow ?? 20],
          cols,
        });
      }
    }
    // lock/gameover 无视觉特效（S04.1 仅定义清行与硬降两类效果）。
  }

  /** 读取 nowMs 时刻的效果快照（渲染专用，只读）；到期效果在读取时自动清理。 */
  snapshot(nowMs: number): readonly ActiveEffect[] {
    if (this.#effects.length > 0) {
      this.#effects = this.#effects.filter((fx) => nowMs - fx.startedAt < fx.durationMs);
    }
    return this.#effects;
  }

  /** 进行中的效果数（测试与 T057 泄漏检查点读）。 */
  get activeCount(): number {
    return this.#effects.length;
  }

  /** 清空全部效果（重开/暂停时由装配层调用；T045 提供能力，T055 接线）。 */
  clear(): void {
    this.#effects = [];
  }
}
