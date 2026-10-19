// Neon Blocks — 主棋盘 Canvas 渲染器（规格 S05，任务 T038–T040）。
// 高清缩放契约：CSS 盒子尺寸 × min(devicePixelRatio, 2) 设置内部 backing store；
// 每次绘制前 `setTransform(dpr,0,0,dpr,0,0)` 重置变换，绝不累计 scale；
// resize 幂等（同尺寸不写 canvas.width，避免比例叠加与闪烁）。
// T039：#0B1022 底色 + rgba(255,255,255,0.055) 细网格（1 物理像素、设备像素对齐）；
// T040：锁定块（rows 4..23）与活动块（getMatrix×x/y）共用玻璃糖果单格绘制路径，
// 隐藏区格与界外格跳过；ghost T041、特效 T045 起续写。

import { HIDDEN_ROWS } from '../game/constants';
import { getMatrix } from '../game/pieces';
import type { GameState, PieceType } from '../game/types';

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

/** 主棋盘背景精确色值（S04.1/S04.2 `--board` #0B1022）。 */
const BOARD_FILL = '#0B1022';

/** 细网格线精确色值（S04.1：rgba(255,255,255,0.055)）。 */
const GRID_LINE_COLOR = 'rgba(255, 255, 255, 0.055)';

/** 方块填充精确色板（S04.2 表 I–L；与 tokens.css `--piece-*` 逐一相同的字面值）。 */
const PIECE_FILL: Record<PieceType, string> = {
  I: '#45D6E8',
  O: '#FFD166',
  T: '#C792EA',
  S: '#5EE0A0',
  Z: '#FF6B82',
  J: '#648BFF',
  L: '#FFAC67',
};

/** 格子圆角 = 格宽 × 12%（S04.1：不得大到模糊方形轮廓）。 */
const CELL_RADIUS_RATIO = 0.12;

/** 玻璃糖果质感纵向渐变（S04.1：渐变只用在方块内部；顶部轻亮、底部深阴影）。 */
const CELL_SHEEN_TOP = 'rgba(255, 255, 255, 0.16)';
const CELL_SHEEN_MID = 'rgba(255, 255, 255, 0)';
const CELL_SHADOW_BOTTOM = 'rgba(0, 0, 0, 0.24)';

/** 每格 1px 内描边（S04.1）。 */
const CELL_INNER_STROKE = 'rgba(255, 255, 255, 0.24)';

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
   * 单帧绘制入口（S05：单一主 Canvas；调用方在 rAF 中每帧一次；只读 state）。
   * T039 底色/网格 → T040 锁定块（board rows 4..23）+ 活动块（getMatrix×x/y）；
   * ghost T041、特效 T045 起在此文件续写，签名保持稳定。
   */
  render(state: GameState, opts: RenderOptions = {}): void {
    void opts; // T041/T045 起读取 ghost/reducedMotion 开关
    const ctx = this.#ctx;
    // 每帧重置变换（幂等），再清屏——即使调用方错过 resize 也不会叠加变换。
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#cssWidth, this.#cssHeight);
    // S04.1：主棋盘背景 #0B1022（S04.2 --board 精确色值）。
    ctx.fillStyle = BOARD_FILL;
    ctx.fillRect(0, 0, this.#cssWidth, this.#cssHeight);
    // S04.1：细网格线 rgba(255,255,255,0.055)，1 物理像素、对齐 CSS 格尺寸取整。
    this.#drawGrid();
    if (Array.isArray(state.board)) {
      this.#drawLockedCells(state);
    }
    if (state.active) {
      this.#drawActivePiece(state);
    }
  }

  /**
   * 锁定块：仅遍历可见区 rows 4..23（S03.1 隐藏缓冲区 0..3 不绘制），
   * 每格按类型色板 + 亮边/暗底/圆角（#drawCell）。
   */
  #drawLockedCells(state: GameState): void {
    for (let row = HIDDEN_ROWS; row < HIDDEN_ROWS + GRID_ROWS; row += 1) {
      const line = state.board[row];
      if (!Array.isArray(line)) {
        continue;
      }
      for (let col = 0; col < GRID_COLUMNS; col += 1) {
        const type = line[col];
        if (type !== null && type !== undefined) {
          this.#drawCell(col, row - HIDDEN_ROWS, type);
        }
      }
    }
  }

  /**
   * 活动块：`getMatrix(type, rotation)` 逐实体格映射到棋盘坐标 (x+i, y+j)；
   * 落在隐藏行（y<4）的格跳过（S04.1：不把隐藏缓冲区画出来、不越出 Canvas）。
   * 与锁定块共用同一 #drawCell，保证视觉一致（S04.1）。
   */
  #drawActivePiece(state: GameState): void {
    const active = state.active;
    if (active === null || active === undefined) {
      return;
    }
    const matrix = getMatrix(active.type, active.rotation);
    for (let j = 0; j < matrix.length; j += 1) {
      const line = matrix[j];
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== '1') {
          continue;
        }
        const boardY = active.y + j;
        const boardX = active.x + i;
        if (boardY < HIDDEN_ROWS || boardY >= HIDDEN_ROWS + GRID_ROWS || boardX < 0 || boardX >= GRID_COLUMNS) {
          continue; // 隐藏区与界外格不绘制
        }
        this.#drawCell(boardX, boardY - HIDDEN_ROWS, active.type);
      }
    }
  }

  /**
   * 单格方块（S04.1 玻璃糖果）：类型色填充 + 内部纵向渐变（顶部 rgba 白 .16 →
   * 底部 rgba 黑 .24）+ 1px 内描边；圆角 = 格宽 12%；格间留 1 物理像素缝隙。
   * 锁定块与活动块共用（视觉一致的单一绘制路径）。
   */
  #drawCell(col: number, row: number, type: PieceType): void {
    const ctx = this.#ctx;
    const dpr = this.#dpr;
    const { width: cw, height: ch } = this.cellSize;
    const gap = 0.5 / dpr; // 相邻块间的 1 物理像素缝（两侧各让 0.5）
    const x = col * cw + gap;
    const y = row * ch + gap;
    const w = cw - gap * 2;
    const h = ch - gap * 2;
    const radius = Math.min(w, h) * CELL_RADIUS_RATIO;
    // 类型底色
    ctx.fillStyle = PIECE_FILL[type];
    this.#roundedPath(x, y, w, h, radius);
    ctx.fill();
    // 内部渐变（亮顶/暗底），裁剪到格内后叠加
    ctx.save();
    this.#roundedPath(x, y, w, h, radius);
    ctx.clip();
    const gradient = ctx.createLinearGradient(0, y, 0, y + h);
    gradient.addColorStop(0, CELL_SHEEN_TOP);
    gradient.addColorStop(0.5, CELL_SHEEN_MID);
    gradient.addColorStop(1, CELL_SHADOW_BOTTOM);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    // 1px 内描边（S04.1：每格 1px 内描边）
    ctx.strokeStyle = CELL_INNER_STROKE;
    ctx.lineWidth = 1 / dpr;
    this.#roundedPath(x + 0.5 / dpr, y + 0.5 / dpr, w - 1 / dpr, h - 1 / dpr, Math.max(0, radius - 0.5 / dpr));
    ctx.stroke();
  }

  /** 圆角矩形路径（不依赖 ctx.roundRect，兼容更旧的 2D 上下文实现）。 */
  #roundedPath(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.#ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /**
   * 10×20 可见网格的细线（S03.1：可见区即内部棋盘 rows 4..23 的投影；隐藏
   * 缓冲区 0..3 不在 Canvas 内，画线只覆盖可见区）。为避免半像素模糊，格线
   * 坐标按设备像素取整后回到 CSS 单位，线宽恰为 1 物理像素。
   */
  #drawGrid(): void {
    const ctx = this.#ctx;
    const { width: cellW, height: cellH } = this.cellSize;
    const cssW = this.#cssWidth;
    const cssH = this.#cssHeight;
    const dpr = this.#dpr;
    const snap = (cssValue: number): number => Math.round(cssValue * dpr) / dpr;
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    for (let col = 1; col < GRID_COLUMNS; col += 1) {
      const x = snap(col * cellW);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
    }
    for (let row = 1; row < GRID_ROWS; row += 1) {
      const y = snap(row * cellH);
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
    }
    ctx.stroke();
  }
}
