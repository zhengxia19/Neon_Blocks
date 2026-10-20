/**
 * N35：独立远程棋盘渲染。
 * 只用服务器转发的 `remote_snapshot`（SnapshotPayload）绘制远程 Canvas：
 * 远程侧不构造任何引擎实例、无音效、无每帧网络要求；复用 `BoardRenderer` 保证
 * 视觉与主棋盘完全一致（同一格绘制路径与色板）。
 * 语义：seq 严格递增才重绘（无新帧不重复绘制）；`freeze()` 淘汰者冻结
 * 最后画面；`setDisconnected()` 叠加「同步中断」提示（不残影假画面），
 * 新快照到达即恢复。本文件不出现任何网络代码或自驱动画循环。
 */
import type { SnapshotPayload } from '../../shared/protocol';
import type { GameStateView } from '../game/engine';
import type { Cell, PieceType, Rotation } from '../game/types';
import { BoardRenderer } from './renderer';

/** 快照字符 → 方块类型（与编码端 N23 首字母约定一致）。 */
const PIECE_BY_LETTER: Readonly<Record<string, PieceType>> = {
  I: 'I', O: 'O', T: 'T', S: 'S', Z: 'Z', J: 'J', L: 'L',
};

/**
 * 快照 → 渲染层只读视图（纯函数）：board 24 行 × 10 字符，`.` 空、
 * 其余为类型首字母；未知字符按空处理（服务端 validateSnapshot 已先行把关）。
 * 预览/Hold/计时字段远程不可见，置空值——渲染层不读取它们。
 */
export function snapshotToView(snap: SnapshotPayload): GameStateView {
  const board: Cell[][] = snap.board.map((row) =>
    [...row].map((ch): Cell => (ch === '.' ? null : PIECE_BY_LETTER[ch] ?? null)),
  );
  const active = snap.active === null
    ? null
    : { type: snap.active.t, rotation: snap.active.r as Rotation, x: snap.active.x, y: snap.active.y };
  return {
    board,
    active,
    nextQueue: [],
    bag: [],
    heldType: null,
    holdUsedThisPiece: false,
    status: snap.status,
    score: snap.score,
    lines: snap.lines,
    level: snap.level,
    gravityElapsedMs: 0,
    lockElapsedMs: 0,
    lockResetCount: 0,
    lastEvent: null,
  };
}

/** 重绘判定（纯函数，钉死语义）：冻结后一律不重绘；seq 必须严格递增。 */
export function shouldDraw(lastSeq: number, seq: number, frozen: boolean): boolean {
  if (frozen) return false;
  return seq > lastSeq;
}

/** 初始/复位空帧的棋盘（底色+网格，等待首帧快照）。 */
const EMPTY_BOARD_ROWS: readonly string[] = new Array<string>(24).fill('..........');

/** 远程棋盘控制器。 */
export class RemoteBoard {
  readonly #renderer: BoardRenderer;
  #lastSeq = -1;
  #frozen = false;
  #disconnected = false;
  /** 最近一次成功绘制的视图（resize 后重绘最后画面，不留空白）。 */
  #lastView: GameStateView | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#renderer = new BoardRenderer(canvas);
    // 初始空帧：底色+网格（等待首帧快照，不留透明假画面）。
    this.#renderer.render(snapshotToView({
      seq: 0, board: [...EMPTY_BOARD_ROWS], active: null,
      score: 0, lines: 0, level: 1, status: 'running',
    }), { ghostEnabled: false });
  }

  /** 收到新快照：seq 递增才重绘；重绘即清除「同步中断」遮罩。返回是否绘制。 */
  applySnapshot(snap: SnapshotPayload): boolean {
    if (!shouldDraw(this.#lastSeq, snap.seq, this.#frozen)) return false;
    this.#lastSeq = snap.seq;
    this.#disconnected = false;
    const view = snapshotToView(snap);
    this.#lastView = view;
    this.#renderer.render(view, { ghostEnabled: false });
    return true;
  }

  /**
   * 切换观察目标/新一局：复位 seq 水位、解冻、清断线态。
   * 不清 Canvas——旧目标最后画面保留至新目标首帧到达（服务器切换即补发
   * 目标最后一帧），避免瞬时闪白。
   */
  resetForTarget(): void {
    this.#lastSeq = -1;
    this.#frozen = false;
    this.#disconnected = false;
    this.#lastView = null;
  }

  /**
   * 远程 Canvas CSS 尺寸变化（N36 响应式双棋盘）：透传 BoardRenderer.resize
   * （会清空 backing store），随后重绘最后画面；断线态下重贴「同步中断」遮罩。
   */
  resize(): void {
    this.#renderer.resize();
    if (this.#lastView !== null) {
      this.#renderer.render(this.#lastView, { ghostEnabled: false });
    } else {
      this.#renderer.render(snapshotToView({
        seq: 0, board: [...EMPTY_BOARD_ROWS], active: null,
        score: 0, lines: 0, level: 1, status: 'running',
      }), { ghostEnabled: false });
    }
    if (this.#disconnected) {
      this.#renderer.overlayNotice('同步中断');
    }
  }

  /** 淘汰/冻结：保留最后画面，此后任何快照都不再重绘。 */
  freeze(): void {
    this.#frozen = true;
  }

  /** 观察对象断线：在当前帧上叠加一次「同步中断」提示（幂等）。 */
  setDisconnected(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#renderer.overlayNotice('同步中断');
  }

  /** 点读诊断（测试/调试）。 */
  get state(): { lastSeq: number; frozen: boolean; disconnected: boolean } {
    return { lastSeq: this.#lastSeq, frozen: this.#frozen, disconnected: this.#disconnected };
  }
}
