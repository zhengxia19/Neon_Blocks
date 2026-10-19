// Neon Blocks — READY / PAUSED / GAMEOVER 覆盖层（规格 S04.3，任务 T044）。
// 三种覆盖层均为真实 HTML role=dialog 对话框（S04.3：不是只在 Canvas 绘制文字），
// 由外部状态驱动显示/隐藏（update 由 T053/T055 装配调用；本任务不绑定交互）。
// 隐藏使用 hidden 属性 + [hidden]{display:none}：隐藏控件不可聚焦（T044 步骤 3）。

import { formatScore } from './hud';

export type OverlayStatus = 'ready' | 'running' | 'paused' | 'gameover';

/** 覆盖层内部关键元素引用（按钮行为绑定在 T055 接入）。 */
export interface OverlayControls {
  readyRoot: HTMLElement;
  pausedRoot: HTMLElement;
  gameoverRoot: HTMLElement;
  startButton: HTMLButtonElement;
  resumeButton: HTMLButtonElement;
  restartButton: HTMLButtonElement;
  replayButton: HTMLButtonElement;
  finalScore: HTMLElement;
  finalBest: HTMLElement;
}

function dialog(
  parent: HTMLElement,
  { className, title, body }:
  { className: string; title: string; body: string },
): HTMLElement {
  const box = document.createElement('div');
  box.className = `overlay ${className}`;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  box.hidden = true;
  const h2 = document.createElement('h2');
  h2.className = 'overlay-title';
  h2.textContent = title;
  box.appendChild(h2);
  const p = document.createElement('p');
  p.className = 'overlay-body';
  p.textContent = body;
  box.appendChild(p);
  parent.appendChild(box);
  return box;
}

function button(parent: HTMLElement, label: string, id: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.className = primary ? 'overlay-button primary' : 'overlay-button';
  b.textContent = label;
  b.setAttribute('aria-label', label);
  parent.appendChild(b);
  return b;
}

/**
 * 在 overlayRoot（layout 提供，位于棋盘 Canvas 之后）内构建三种覆盖层。
 * setStatus() 按状态单显；GAMEOVER 内嵌本局 SCORE 与 BEST 读数（S04.3/S06）。
 */
export function createOverlays(overlayRoot: HTMLElement): OverlayControls & {
  setStatus(status: OverlayStatus): void;
  setFinalScores(score: number, best: number): void;
} {
  // ── READY：欢迎介绍 + 高辨识度开始按钮 + 简短操作说明（S04.3） ──
  const readyRoot = dialog(overlayRoot, {
    className: 'overlay-ready',
    title: '准备开始',
    body: '霓虹方块 · 无尽马拉松。← → 移动，Z / X 旋转，↓ 软降，Space 硬降，C 暂存。整行填满即消除，堆到顶部结束。',
  });
  const startButton = button(readyRoot, '开始游戏', 'btn-start', true);

  // ── PAUSED：暂停中 + 继续 / 重新开始（S04.3） ──
  const pausedRoot = dialog(overlayRoot, {
    className: 'overlay-paused',
    title: '暂停中',
    body: '按 P 或点击继续回到棋盘。',
  });
  const resumeButton = button(pausedRoot, '继续', 'btn-resume', true);
  const restartButton = button(pausedRoot, '重新开始', 'btn-restart');

  // ── GAMEOVER：本局成绩 + 最高分 + 再玩一次（S04.3/S06） ──
  const gameoverRoot = dialog(overlayRoot, {
    className: 'overlay-gameover',
    title: '游戏结束',
    body: '',
  });
  const scoreLine = document.createElement('p');
  scoreLine.className = 'overlay-score';
  const scoreLabel = document.createElement('span');
  scoreLabel.className = 'overlay-stat-label';
  scoreLabel.textContent = 'SCORE';
  const finalScore = document.createElement('span');
  finalScore.className = 'overlay-stat-value';
  finalScore.id = 'over-score';
  finalScore.textContent = '000000';
  scoreLine.append(scoreLabel, finalScore);
  const bestLine = document.createElement('p');
  bestLine.className = 'overlay-score';
  const bestLabel = document.createElement('span');
  bestLabel.className = 'overlay-stat-label';
  bestLabel.textContent = 'BEST';
  const finalBest = document.createElement('span');
  finalBest.className = 'overlay-stat-value';
  finalBest.id = 'over-best';
  finalBest.textContent = '000000';
  bestLine.append(bestLabel, finalBest);
  gameoverRoot.append(scoreLine, bestLine);
  const replayButton = button(gameoverRoot, '再玩一次', 'btn-replay', true);

  const roots: Record<OverlayStatus, HTMLElement | null> = {
    ready: readyRoot,
    running: null,
    paused: pausedRoot,
    gameover: gameoverRoot,
  };
  return {
    readyRoot,
    pausedRoot,
    gameoverRoot,
    startButton,
    resumeButton,
    restartButton,
    replayButton,
    finalScore,
    finalBest,
    setStatus(status: OverlayStatus): void {
      for (const root of [readyRoot, pausedRoot, gameoverRoot]) {
        root.hidden = root !== roots[status];
      }
    },
    setFinalScores(score: number, best: number): void {
      finalScore.textContent = formatScore(score);
      finalBest.textContent = formatScore(best);
    },
  };
}
