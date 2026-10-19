// Neon Blocks — 键盘输入映射（规格 S03.3/S06，任务 T050/T051）。
// KeyboardController 只做「键 → Engine 方法」的映射与输入卫生：
// 不改变 UI（开始/覆盖层快捷键经回调交给 main）、文本输入与打开的对话框
// 内不劫持快捷键、一次性动作忽略 event.repeat、仅在游戏进行中对映射键
// preventDefault。dispose() 完整移除监听。
// T051：只有 ↓ 长按交给 RepeatController（DAS 150/ARR 45/软降 35）——首次
// 按下立即执行，节奏由装配层每帧调用 update(dtMs) 推进（无独立计时器）；
// event.repeat 不再触发动作（首次 keydown 已记录按住态）。

import type { GameEngine } from '../game/engine';
import { RepeatController } from './repeat';

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
  // 打开中的对话框（设置弹窗等）内控件获得焦点时不劫持游戏快捷键；
  // 已关闭（hidden/未渲染）的对话框不算——其按钮焦点回归 body 前，
  // 快捷键不得被误吞（T056 关闭设置后立即按键继续的健壮性）。
  const dialog = target.closest('[role="dialog"]');
  if (dialog !== null) {
    const box = dialog as HTMLElement;
    if (box.hidden || box.offsetParent === null) {
      return false;
    }
    return true;
  }
  return false;
}

export class KeyboardController {
  readonly #engine: GameEngine;
  readonly #callbacks: KeyboardCallbacks;
  readonly #repeat: RepeatController;
  #target: Window | null = null;
  #handler: ((event: KeyboardEvent) => void) | null = null;
  #keyupHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(engine: GameEngine, callbacks: KeyboardCallbacks = {}) {
    this.#engine = engine;
    this.#callbacks = callbacks;
    this.#repeat = new RepeatController({
      move: (direction) => this.#engine.move(direction),
      softDrop: () => this.#engine.softDrop(),
    });
  }

  /** 主循环每帧调用（T053 由 rAF 传入 dtMs）：推进 DAS/ARR/软降节奏。 */
  update(dtMs: number): void {
    this.#repeat.update(dtMs);
  }

  /** 释放全部长按状态（失焦 / 切后台时由装配层调用，T051 步骤 2）。 */
  releaseAll(): void {
    this.#repeat.releaseAll();
  }

  /** 挂到 window（或测试指定的事件目标）开始监听；重复调用先卸载旧监听。 */
  attach(target: Window = window): void {
    this.detach();
    const handler = (event: KeyboardEvent): void => {
      this.#handleKey(event);
    };
    const keyupHandler = (event: KeyboardEvent): void => {
      this.#handleKeyUp(event);
    };
    this.#target = target;
    this.#handler = handler;
    this.#keyupHandler = keyupHandler;
    target.addEventListener('keydown', handler);
    target.addEventListener('keyup', keyupHandler);
  }

  /** 移除键盘监听（T050 步骤 3）并清空按住状态。 */
  dispose(): void {
    this.detach();
  }

  private detach(): void {
    if (this.#target !== null) {
      if (this.#handler !== null) {
        this.#target.removeEventListener('keydown', this.#handler);
      }
      if (this.#keyupHandler !== null) {
        this.#target.removeEventListener('keyup', this.#keyupHandler);
      }
      this.#target = null;
      this.#handler = null;
      this.#keyupHandler = null;
    }
    this.#repeat.releaseAll();
  }

  /** 松开：←/→/↓ 解除长按（抬键后立即停止，T051 验收）。 */
  #handleKeyUp(event: KeyboardEvent): void {
    switch (event.code) {
      case 'ArrowLeft':
        this.#repeat.releaseDirection('left');
        break;
      case 'ArrowRight':
        this.#repeat.releaseDirection('right');
        break;
      case 'ArrowDown':
        this.#repeat.releaseSoft();
        break;
      default:
        break;
    }
  }

  #handleKey(event: KeyboardEvent): void {
    // 修饰键组合（Ctrl/Alt/Meta）留给浏览器/辅助技术。
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const code = event.code;
    // 已按住的自动重复：一次性动作直接忽略（步骤 2）；←/→/↓ 的长按节奏由
    // RepeatController 推进，repeat 事件不再触发 press（按住态已在首次记录）。
    if (event.repeat) {
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
        this.#repeat.pressDirection('left'); // 立即一步 + 进入 DAS（T051）
        break;
      case 'ArrowRight':
        this.#repeat.pressDirection('right');
        break;
      case 'ArrowDown':
        this.#repeat.pressSoft();
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
