// Neon Blocks — 主棋盘 Canvas 渲染器骨架（规格 S05，任务 T038）。
// 高清缩放契约：CSS 盒子尺寸 × min(devicePixelRatio, 2) 设置内部 backing store；
// 每次绘制前 `setTransform(dpr,0,0,dpr,0,0)` 重置变换，绝不累计 scale；
// resize 幂等（同尺寸不写 canvas.width，避免比例叠加与闪烁）。
// 背景网格/锁定块/幽灵/活动块的绘制自 T039 起在本文件逐步接入。

import type { GameState } from '../game/types';

/** 每帧渲染选项（后续任务扩展：ghost 开关 T041、清行/硬降特效与 reducedMotion T045）。 */
export interface RenderOptions {
  /** 减少动画：跳过清行扫光、硬降光尾等特效（T045 接入，本任务仅预留契约位）。 */
  reducedMotion?: boolean;
}

/** 主棋盘逻辑网格（S03.1：可见区 10×20；Canvas 只画可见区）。 */
const GRID_COLUMNS = 10;
const GRID_ROWS = 20;

/** DPR 上限 2（S05：CSS 尺寸 × min(devicePixelRatio, 2)，3x 屏不继续翻倍省内存）。 */
const MAX_DPR = 2;

export class BoardRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;

  /** 当前生效的缩放系数（CSS 像素 → 内部像素）。 */
  #dpr = 1;

  /** 最近一次测得的 CSS 盒子尺寸（render 以此为单位绘制，setTransform 已含 dpr）。 */
  #cssWidth = 0;
  #cssHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('无法获取 2D 渲染上下文（Canvas 2D 不可用）');
    }
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.resize();
  }

  /** 内部 backing store 宽度（测试与调试点读用；等于 round(CSS 宽 × dpr)）。 */
  get backingWidth(): number {
    return this.#canvas.width;
  }

  /** 内部 backing store 高度。 */
  get backingHeight(): number {
    return this.#canvas.height;
  }

  /** 当前每格 CSS 像素尺寸（等宽等高；T039 起用于格线对齐）。 */
  get cellSize(): { width: number; height: number } {
    return { width: this.#cssWidth / GRID_COLUMNS, height: this.#cssHeight / GRID_ROWS };
  }

  /**
   * 依据 canvas 当前 CSS 尺寸重设内部像素与变换。可高频调用（ResizeObserver/
   * window resize 共用此一处）：同尺寸时不写 canvas.width/height，保证 resize
   * 不叠加缩放比例；始终 setTransform 重置（S05，杜绝累计 scale）。
   */
  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    this.#dpr = dpr;
    this.#cssWidth = rect.width;
    this.#cssHeight = rect.height;
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 单帧绘制入口（S05：单一主 Canvas；调用方在 rAF 中每帧一次）。
   * 本任务（T038）仅完成清屏；底色与网格线 T039、锁定块 T040、ghost T041、
   * 活动块与特效 T042/T045 起在此文件续写，签名保持稳定。
   */
  render(state: GameState, opts: RenderOptions = {}): void {
    void state; // T039 起读取 board/active/ghost
    void opts; // T041/T045 起读取 ghost/reducedMotion 开关
    const ctx = this.#ctx;
    // 每帧重置变换（幂等），再清屏——即使调用方错过 resize 也不会叠加变换。
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#cssWidth, this.#cssHeight);
  }
}
