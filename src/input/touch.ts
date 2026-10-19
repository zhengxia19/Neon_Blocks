// Neon Blocks — 移动端虚拟触控按钮（规格 S03.3/S04.3，任务 T052）。
// 7 按键：←、→、↓（长按复用 repeat.ts 的 RepeatController，与键盘同一
// DAS/ARR/软降节奏）、旋转左、旋转右、硬降、Hold（一次性）；顶部 Pause 由
// layout 头部的 #btn-pause 提供（装配层 T053 接线）。
// 事件卫生：pointerdown 触发；pointerup / pointercancel / pointerleave 任一
// 即释放长按（手指移出按钮不粘连）；window 级 pointerup 兜底防泄漏。
// 按钮 ≥44×44、pressed 态明显、中文 aria-label；仅按钮 touch-action:none，
// 页面其余区域保持正常滚动。

import type { RepeatController } from './repeat';

/** 一次性动作（长按三键由 RepeatController 承载，不走这里）。 */
export interface TouchActions {
  rotate(direction: 1 | -1): void;
  hardDrop(): void;
  hold(): void;
}

export interface TouchControlsOptions {
  /** 与键盘共享的长按控制器（T053 装配同一实例，保证左右优先级统一）。 */
  repeat: RepeatController;
  actions: TouchActions;
}

export interface TouchControls {
  /** 按钮元素（测试点读）。 */
  buttons: ReadonlyMap<string, HTMLButtonElement>;
  dispose(): void;
}

interface ButtonSpec {
  key: string;
  glyph: string;
  label: string;
  /** 按下行为：长按键 press / 一次性键 action。 */
  press(): void;
  /** 抬起/取消/移出行为（一次性键无需释放）。 */
  release?(): void;
}

/**
 * 在 container（layout 提供的 #touch-controls）内渲染 7 个虚拟按键。
 * 每个持续键复用 RepeatController：按下立即执行并遵循相同 DAS=150/ARR=45、
 * 软降 35ms（T052 步骤 2）；一次性键 pointerdown 单次触发。
 */
export function createTouchControls(container: HTMLElement, options: TouchControlsOptions): TouchControls {
  const { repeat, actions } = options;
  const specs: ButtonSpec[] = [
    { key: 'left', glyph: '←', label: '向左移动', press: () => repeat.pressDirection('left'), release: () => repeat.releaseDirection('left') },
    { key: 'right', glyph: '→', label: '向右移动', press: () => repeat.pressDirection('right'), release: () => repeat.releaseDirection('right') },
    { key: 'down', glyph: '↓', label: '软降', press: () => repeat.pressSoft(), release: () => repeat.releaseSoft() },
    { key: 'hard', glyph: '⤓', label: '硬降', press: () => actions.hardDrop() },
    { key: 'rotL', glyph: '↺', label: '旋转（逆时针）', press: () => actions.rotate(-1) },
    { key: 'rotR', glyph: '↻', label: '旋转（顺时针）', press: () => actions.rotate(1) },
    { key: 'hold', glyph: '⤒', label: '暂存（Hold）', press: () => actions.hold() },
  ];

  const buttons = new Map<string, HTMLButtonElement>();
  const pressedByButton = new WeakMap<Element, boolean>();
  const disposers: Array<() => void> = [];

  for (const spec of specs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-btn';
    btn.dataset.touchKey = spec.key;
    btn.setAttribute('aria-label', spec.label);
    btn.textContent = spec.glyph;
    container.appendChild(btn);
    buttons.set(spec.key, btn);

    const press = (): void => {
      pressedByButton.set(btn, true);
      btn.classList.add('pressed');
      spec.press();
    };
    const release = (): void => {
      if (pressedByButton.get(btn) !== true) {
        return;
      }
      pressedByButton.set(btn, false);
      btn.classList.remove('pressed');
      spec.release?.();
    };

    const onPointerDown = (event: PointerEvent): void => {
      event.preventDefault(); // 阻止合成点击与拖拽滚动（仅按钮区域）
      press();
    };
    const onPointerUp = (): void => release();
    const onPointerCancel = (): void => release(); // pointercancel 终止输入（步骤 2）
    const onPointerLeave = (): void => release(); // 手指移出立即停（不粘连）
    const onBlur = (): void => release();
    const onContextMenu = (event: Event): void => event.preventDefault(); // 长按不出菜单

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('pointerup', onPointerUp);
    btn.addEventListener('pointercancel', onPointerCancel);
    btn.addEventListener('pointerleave', onPointerLeave);
    btn.addEventListener('blur', onBlur);
    btn.addEventListener('contextmenu', onContextMenu);
    disposers.push(() => {
      btn.removeEventListener('pointerdown', onPointerDown);
      btn.removeEventListener('pointerup', onPointerUp);
      btn.removeEventListener('pointercancel', onPointerCancel);
      btn.removeEventListener('pointerleave', onPointerLeave);
      btn.removeEventListener('blur', onBlur);
      btn.removeEventListener('contextmenu', onContextMenu);
    });
  }

  // window 级兜底：pointerup/cancel 若发生在按钮外（移出后仍按住拖拽）也释放。
  const globalUp = (): void => {
    for (const btn of buttons.values()) {
      if (pressedByButton.get(btn) === true) {
        pressedByButton.set(btn, false);
        btn.classList.remove('pressed');
        const spec = specs.find((s) => s.key === btn.dataset.touchKey);
        spec?.release?.();
      }
    }
  };
  window.addEventListener('pointerup', globalUp);
  window.addEventListener('pointercancel', globalUp);
  disposers.push(() => {
    window.removeEventListener('pointerup', globalUp);
    window.removeEventListener('pointercancel', globalUp);
  });

  return {
    buttons,
    dispose(): void {
      globalUp(); // 释放全部长按
      for (const off of disposers) {
        off();
      }
      for (const btn of buttons.values()) {
        btn.remove();
      }
      buttons.clear();
    },
  };
}
