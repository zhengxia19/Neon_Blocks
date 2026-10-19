// Neon Blocks — HOLD/NEXT 方块预览与状态读数（规格 S04.2/S04.3/S05，任务 T042/T043）。
// 预览为 4×4 CSS 小格网格（16 格 DOM 一次性创建）；set() 只更新既有格子的
// background-color，绝不每帧重建 DOM（S05：预览不依赖主循环重生成）。
// 读数 updateHud 仅在数值变化时写 textContent；分数/最高分至少 6 位左补零。
// 颜色一律取 tokens.css 的 --piece-* 变量 —— 与主 Canvas 共用同一精确色板（S05）。

import { getMatrix } from '../game/pieces';
import type { PieceType } from '../game/types';

/** 预览网格边长（4×4；3×3 及 I 的 4×1 形状在其中居中）。 */
const PREVIEW_SIZE = 4;

/** 方块色 → CSS 变量（S04.2 精确色板的同一来源）。 */
const PIECE_VAR: Record<PieceType, string> = {
  I: 'var(--piece-i)',
  O: 'var(--piece-o)',
  T: 'var(--piece-t)',
  S: 'var(--piece-s)',
  Z: 'var(--piece-z)',
  J: 'var(--piece-j)',
  L: 'var(--piece-l)',
};

export interface PiecePreview {
  /** 更新为指定方块类型（出生 0 态形状）；null 显示空槽占位。仅改既有格子颜色。 */
  set(type: PieceType | null): void;
}

/**
 * 在 container 内构建一枚 4×4 预览；返回 set() 控制器。
 * 结构：container（.preview-box，layout 已建）> .piece-grid > 16×.piece-cell。
 * 形状取 getMatrix(type, 0) 的实体格包围盒，四舍五入地板级居中放入 4×4。
 */
export function createPiecePreview(container: HTMLElement): PiecePreview {
  const grid = document.createElement('div');
  grid.className = 'piece-grid';
  const cells: HTMLElement[][] = [];
  for (let row = 0; row < PREVIEW_SIZE; row += 1) {
    const line: HTMLElement[] = [];
    for (let col = 0; col < PREVIEW_SIZE; col += 1) {
      const cell = document.createElement('div');
      cell.className = 'piece-cell';
      grid.appendChild(cell);
      line.push(cell);
    }
    cells.push(line);
  }
  grid.setAttribute('aria-hidden', 'true');
  container.appendChild(grid);

  return {
    set(type: PieceType | null): void {
      // 每次调用重置全部 16 格为透明（更新颜色，非重建 DOM）。
      for (const line of cells) {
        for (const cell of line) {
          cell.style.backgroundColor = '';
        }
      }
      if (type === null) {
        grid.classList.add('is-empty');
        return;
      }
      grid.classList.remove('is-empty');
      const matrix = getMatrix(type, 0);
      // 实体格包围盒（r0 形状）→ 4×4 内地板级居中。
      let minR = matrix.length;
      let maxR = -1;
      let minC = Number.POSITIVE_INFINITY;
      let maxC = -1;
      for (let r = 0; r < matrix.length; r += 1) {
        for (let c = 0; c < matrix[r].length; c += 1) {
          if (matrix[r][c] === '1') {
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
          }
        }
      }
      const shapeH = maxR - minR + 1;
      const shapeW = maxC - minC + 1;
      const offsetR = Math.floor((PREVIEW_SIZE - shapeH) / 2);
      const offsetC = Math.floor((PREVIEW_SIZE - shapeW) / 2);
      const fill = PIECE_VAR[type];
      for (let r = minR; r <= maxR; r += 1) {
        for (let c = minC; c <= maxC; c += 1) {
          if (matrix[r][c] !== '1') {
            continue;
          }
          const gridRow = r - minR + offsetR;
          const gridCol = c - minC + offsetC;
          if (gridRow >= 0 && gridRow < PREVIEW_SIZE && gridCol >= 0 && gridCol < PREVIEW_SIZE) {
            cells[gridRow][gridCol].style.backgroundColor = fill;
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// T043：分数 / 最高分 / 等级 / 行数读数（S04.2/S04.3）
// ---------------------------------------------------------------------------

/** updateHud 需要的读数元素（layout.ts 的 LayoutRefs 是其超集）。 */
export interface HudRefs {
  scoreValue: HTMLElement;
  bestValue: HTMLElement;
  levelValue: HTMLElement;
  linesValue: HTMLElement;
  miniScore: HTMLElement;
  miniLevel: HTMLElement;
}

/** updateHud 的输入（GameState 的读数子集；best 来自本地存储）。 */
export interface HudState {
  score: number;
  lines: number;
  level: number;
}

/** 数值健壮化：非有限值归零并取整，杜绝 NaN/undefined 出现在页面（S04.3）。 */
function safeInt(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** 分数显示：至少 6 位左补 0；超过 6 位完整显示（T043 步骤 2）。 */
export function formatScore(value: number): string {
  return String(Math.max(0, safeInt(value))).padStart(6, '0');
}

/**
 * 创建读数更新器：update(state, best) 仅在数值相对上次变化时写 textContent
 * （S05「UI 数字仅变化时更新 DOM」）。移动端 mini 读数与桌面侧栏同源同步，
 * 保证两处数值永远一致（T043 步骤 3）。
 */
export function createHud(refs: HudRefs): { update(state: HudState, best: number): void } {
  let lastScore: number | null = null;
  let lastBest: number | null = null;
  let lastLevel: number | null = null;
  let lastLines: number | null = null;
  return {
    update(state: HudState, best: number): void {
      const score = safeInt(state.score);
      const level = Math.max(1, safeInt(state.level));
      const lines = Math.max(0, safeInt(state.lines));
      const bestScore = safeInt(best);
      if (score !== lastScore) {
        refs.scoreValue.textContent = formatScore(score);
        refs.miniScore.textContent = `SCORE ${formatScore(score)}`;
        lastScore = score;
      }
      if (bestScore !== lastBest) {
        refs.bestValue.textContent = formatScore(bestScore);
        lastBest = bestScore;
      }
      if (level !== lastLevel) {
        refs.levelValue.textContent = String(level); // 等级不截断
        refs.miniLevel.textContent = `LV ${level}`;
        lastLevel = level;
      }
      if (lines !== lastLines) {
        refs.linesValue.textContent = String(lines); // 行数不截断
        lastLines = lines;
      }
    },
  };
}
