// Neon Blocks — READY / PAUSED / GAMEOVER 覆盖层与设置弹窗（规格 S04.3/S07，任务 T044/T048）。
// 三种覆盖层均为真实 HTML role=dialog 对话框（S04.3：不是只在 Canvas 绘制文字），
// 由外部状态驱动显示/隐藏（update 由 T053/T055 装配调用；本任务不绑定交互）。
// 隐藏使用 hidden 属性 + [hidden]{display:none}：隐藏控件不可聚焦（T044 步骤 3）。
// T048：设置弹窗 = 三个 labeled checkbox（Sound/Ghost/Reduced motion）+ 保存/关闭；
// 勾选变化即时 saveSettings（S07），运行态自动暂停的接线留 T056；Escape 关闭规则
// 由键盘层（T050）经 close() 接入。

import { loadSettings, saveSettings, type GameSettings } from '../storage/settings';
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

// ---------------------------------------------------------------------------
// T048：设置弹窗（S04.3/S07）
// ---------------------------------------------------------------------------

/** 设置弹窗控制器（键盘 Escape / 设置按钮的接线由 T050/T053/T056 调用）。 */
export interface SettingsDialog {
  root: HTMLElement;
  soundCheckbox: HTMLInputElement;
  ghostCheckbox: HTMLInputElement;
  reducedMotionCheckbox: HTMLInputElement;
  saveButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  /** 用给定设置（缺省读存储）初始化三个勾选项并打开弹窗。 */
  open(settings?: GameSettings): void;
  /** 关闭弹窗（写回由 change/save 完成；此处只隐藏）。 */
  close(): void;
  /** 读取当前勾选项。 */
  readSettings(): GameSettings;
  /** 勾选项变化后的可选监听（T053 用于即时应用音量/特效开关）。 */
  onChange?: (settings: GameSettings) => void;
}

function checkboxRow(
  parent: HTMLElement,
  { id, label, checked }:
  { id: string; label: string; checked: boolean },
): HTMLInputElement {
  const row = document.createElement('label');
  row.className = 'settings-row';
  row.htmlFor = id;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  const text = document.createElement('span');
  text.className = 'settings-label';
  text.textContent = label;
  row.append(input, text);
  parent.appendChild(row);
  return input;
}

/**
 * 在 overlayRoot 内构建设置弹窗。三个 labeled checkbox（label[for] 可见文字），
 * 任一勾选变化即 saveSettings（S07 保存重开保持）；「保存」显式落盘并关闭；
 * 「关闭」隐藏弹窗。Tab 焦点自然可进入（真实控件），隐藏后不可聚焦。
 */
export function createSettingsDialog(overlayRoot: HTMLElement): SettingsDialog {
  const root = document.createElement('div');
  root.className = 'overlay overlay-settings';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '设置');
  root.hidden = true;
  const title = document.createElement('h2');
  title.className = 'overlay-title';
  title.textContent = '设置';
  root.appendChild(title);

  const defaults = loadSettings();
  const soundCheckbox = checkboxRow(root, { id: 'set-sound', label: 'Sound 音效', checked: defaults.soundEnabled });
  const ghostCheckbox = checkboxRow(root, { id: 'set-ghost', label: 'Ghost 落点预判', checked: defaults.ghostEnabled });
  const reducedMotionCheckbox = checkboxRow(root, { id: 'set-reduced', label: 'Reduced motion 减少动画', checked: defaults.reducedMotion });

  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  root.appendChild(actions);
  const saveButton = button(actions, '保存', 'btn-settings-save', true);
  const closeButton = button(actions, '关闭', 'btn-settings-close');

  overlayRoot.appendChild(root);

  const dialog: SettingsDialog = {
    root,
    soundCheckbox,
    ghostCheckbox,
    reducedMotionCheckbox,
    saveButton,
    closeButton,
    open(settings?: GameSettings): void {
      const s = settings ?? loadSettings();
      soundCheckbox.checked = s.soundEnabled;
      ghostCheckbox.checked = s.ghostEnabled;
      reducedMotionCheckbox.checked = s.reducedMotion;
      root.hidden = false;
    },
    close(): void {
      root.hidden = true;
    },
    readSettings(): GameSettings {
      return {
        soundEnabled: soundCheckbox.checked,
        ghostEnabled: ghostCheckbox.checked,
        reducedMotion: reducedMotionCheckbox.checked,
      };
    },
  };

  // 勾选变化即时写回存储（S07：保存后重开浏览器保持）；T048 步骤 3。
  const applyChange = (): void => {
    const s = dialog.readSettings();
    saveSettings(s);
    dialog.onChange?.(s);
  };
  for (const input of [soundCheckbox, ghostCheckbox, reducedMotionCheckbox]) {
    input.addEventListener('change', applyChange);
  }
  saveButton.addEventListener('click', () => {
    applyChange();
    dialog.close();
  });
  closeButton.addEventListener('click', () => {
    dialog.close();
  });
  return dialog;
}
