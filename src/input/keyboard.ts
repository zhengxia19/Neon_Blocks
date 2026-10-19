// Neon Blocks — 键盘输入映射（规格 S03.3/S06，任务 T050；长按 T051 扩展）。
// KeyboardController 只做「键 → Engine 方法」的一次性映射与输入卫生：
// 不改变 UI（开始/覆盖层快捷键经回调交给 main）、文本输入与打开的对话框
// 内不劫持快捷键、一次性动作忽略 event.repeat、仅在游戏进行中对映射键
// preventDefault。dispose() 完整移除监听。

import type { GameEngine } from '../game/engine';

/** 交给装配层（main）处理的非棋盘快捷键。 */
export interface KeyboardCallbacks {
  /** Escape：关闭设置弹窗 / 暂停（由 main 决定语义，T050 步骤 3）。 */
  onEscape?: () => void;
  /** Enter：开始 / 再玩一次（READY、GAMEOVER 态的回车确认）。 */
  onConfirm?: () => void;
}

/** 是否为可编辑输入目标（文本输入不劫持，T050 验收）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  // 对话框内（设置弹窗等）任何控件获得焦点时都不劫持游戏快捷键。
  return target.closest('[role="dialog"]') !== null;
}

export class KeyboardController {
  readonly #engine: GameEngine;
  readonly #callbacks: KeyboardCallbacks;
  #target: Window | null = null;
  #handler: ((event: KeyboardEvent) => void) | null = null;

  constructor(engine: GameEngine, callbacks: KeyboardCallbacks = {}) {
    this.#engine = engine;
    this.#callbacks = callbacks;
  }

  /** 挂到 window（或测试指定的事件目标）开始监听；重复调用先卸载旧监听。 */
  attach(target: Window = window): void {
    this.detach();
    const handler = (event: KeyboardEvent): void => {
      this.#handleKey(event);
    };
    this.#target = target;
    this.#handler = handler;
    target.addEventListener('keydown', handler);
  }

  /** 移除键盘监听（T050 步骤 3）。 */
  dispose(): void {
    this.detach();
  }

  private detach(): void {
    if (this.#target !== null && this.#handler !== null) {
      this.#target.removeEventListener('keydown', this.#handler);
      this.#target = null;
      this.#handler = null;
    }
  }

  #handleKey(event: KeyboardEvent): void {
    // 修饰键组合（Ctrl/Alt/Meta）留给浏览器/辅助技术。
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const code = event.code;
    // 已按住的自动重复：旋转/硬降/Hold/暂停等一次性动作忽略（步骤 2）。
    // 长按移动/软降由 T051 RepeatController 接管，repeat 不作为动作来源。
    if (event.repeat && (code === 'ArrowUp' || code === 'KeyX' || code === 'KeyZ' || code === 'Space' || code === 'KeyC' || code === 'KeyP')) {
      return;
    }
    const status = this.#engine.getState().status;

    // 覆盖层快捷键：READY / GAMEOVER 的 Enter 与全局 Escape 经回调交给 main，
    // 键盘层绝不自行改 UI（T050 步骤 3）。
    if (code === 'Escape') {
      this.#callbacks.onEscape?.();
      if (status === 'running' || status === 'paused') {
        event.preventDefault();
      }
      return;
    }
    if (code === 'Enter' && status !== 'running') {
      this.#callbacks.onConfirm?.();
      return;
    }

    // 文本输入 / 打开的对话框中：不映射、不 preventDefault（验收）。
    if (isEditableTarget(event.target)) {
      return;
    }

    // P / Escape 在暂停层语义：running 或 paused 时暂停切换（Escape 已在上方回调，
    // 由 main 视语义再调用 togglePause）。
    const oneShotPause = code === 'KeyP';

    if (status !== 'running') {
      // 非运行态不驱动棋盘动作；P 也仅在 running/paused 有意义（paused 由覆盖层按钮恢复）。
      if (oneShotPause && status === 'paused') {
        event.preventDefault();
        this.#engine.togglePause();
      }
      return;
    }

    switch (code) {
      case 'ArrowLeft':
        this.#engine.move(-1);
        break;
      case 'ArrowRight':
        this.#engine.move(1);
        break;
      case 'ArrowDown':
        this.#engine.softDrop();
        break;
      case 'ArrowUp':
      case 'KeyX':
        this.#engine.rotate(1);
        break;
      case 'KeyZ':
        this.#engine.rotate(-1);
        break;
      case 'Space':
        this.#engine.hardDrop();
        break;
      case 'KeyC':
        this.#engine.hold();
        break;
      case 'KeyP':
        this.#engine.togglePause();
        break;
      default:
        return; // 非映射键：不吞掉浏览器行为
    }
    // 仅对「游戏中已映射且将生效」的键 preventDefault（防滚动/防焦点跳转）。
    event.preventDefault();
  }
}
