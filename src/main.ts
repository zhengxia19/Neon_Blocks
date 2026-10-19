// Neon Blocks — 唯一装配入口（规格 S02/S05，任务 T053）。
// 单实例创建：GameEngine、BoardRenderer、HUD、预览、覆盖层、特效、键盘/触控。
// requestAnimationFrame 单循环：dt → 长按节奏 → engine.step(dt) → render →
// HUD 仅变化时更新。getState() 只读取。模块级 teardown() 供热重载/E2E 清理，
// 防止重复监听与重复 RAF。音效/设置持久化接线在 T056。

import './styles/tokens.css';
import './styles/app.css';
import './styles/responsive.css';

import { GameEngine } from './game/engine';
import type { PieceType } from './game/types';
import { KeyboardController } from './input/keyboard';
import { RepeatController } from './input/repeat';
import { createTouchControls } from './input/touch';
import { BoardRenderer } from './ui/renderer';
import { EffectsController } from './ui/effects';
import { createHud, createPiecePreview } from './ui/hud';
import { createOverlays } from './ui/overlays';
import { mountLayout, type LayoutRefs } from './ui/layout';

/** 全局装配句柄（E2E/手动调试与 teardown 使用）。 */
interface AppHandle {
  engine: GameEngine;
  renderer: BoardRenderer;
  teardown(): void;
}

function boot(rootElement: HTMLElement): AppHandle {
  const refs: LayoutRefs = mountLayout(rootElement);

  // ── 单实例核心 ─────────────────────────────────────────────────────────────
  const engine = new GameEngine();
  const renderer = new BoardRenderer(refs.boardCanvas);
  const effects = new EffectsController();
  const hud = createHud({
    scoreValue: refs.scoreValue,
    bestValue: refs.bestValue,
    levelValue: refs.levelValue,
    linesValue: refs.linesValue,
    miniScore: refs.miniScore,
    miniLevel: refs.miniLevel,
  });
  const holdPreview = createPiecePreview(refs.holdPreview);
  const nextPreviews = refs.nextSlots.map((slot) => createPiecePreview(slot));
  const overlays = createOverlays(refs.overlayRoot);

  // ── 输入：键盘（内置长按）+ 触控（独立长按控制器，同 DAS/ARR 参数） ──────
  const keyboard = new KeyboardController(engine, {
    onEscape: () => {
      // Escape：游戏中暂停 / 暂停中恢复（覆盖层按钮语义 T055 完整化）。
      const status = engine.getState().status;
      if (status === 'running' || status === 'paused') {
        engine.togglePause();
      }
    },
    onConfirm: () => {
      const status = engine.getState().status;
      if (status === 'ready') {
        engine.start();
      } else if (status === 'gameover') {
        engine.restart();
      }
    },
  });
  keyboard.attach(window);

  const touchRepeat = new RepeatController({
    move: (direction) => engine.move(direction),
    softDrop: () => engine.softDrop(),
  });
  const touch = createTouchControls(refs.touchControls, {
    repeat: touchRepeat,
    actions: {
      rotate: (direction) => engine.rotate(direction),
      hardDrop: () => engine.hardDrop(),
      hold: () => engine.hold(),
    },
  });

  // ── 尺寸同步（S05）：窗口尺寸变化统一走 renderer.resize（幂等） ──────────
  const onResize = (): void => {
    renderer.resize();
  };
  window.addEventListener('resize', onResize);
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(refs.boardCanvas);

  // ── 失焦 / 切后台自动暂停（S03.3/S06，T054）──────────────────────────────
  // running 时立即暂停并释放全部长按；恢复可见仅重置帧时间戳（防止巨大 dt 被
  // 折算进重力/长按），绝不自动恢复运行——由用户显式继续。
  const suspendGame = (): void => {
    if (engine.getState().status === 'running') {
      engine.togglePause();
    }
    keyboard.releaseAll();
    touchRepeat.releaseAll();
    touch.releaseAll();
  };
  const onBlur = (): void => suspendGame();
  const onVisibilityChange = (): void => {
    if (document.hidden) {
      suspendGame();
    } else {
      lastFrameMs = performance.now(); // 只重置时间戳，不自动恢复
    }
  };
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  // ── 单 rAF 主循环（S05）：渲染每帧、HUD/预览仅变化时更新 ─────────────────
  let rafId = 0;
  let lastFrameMs = performance.now();
  let lastHudKey = '';
  let lastPreviewKey = '';
  let lastOverlayStatus: string = '';
  let bestScore = 0; // T056 接持久化；此处游戏内会话最高分
  let rafRunning = false;

  const frame = (nowMs: number): void => {
    rafId = requestAnimationFrame(frame);
    let dtMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    if (dtMs < 0) {
      dtMs = 0;
    }
    if (dtMs > 250) {
      dtMs = 250; // 掉帧/后台恢复封顶：不做时间旅行追赶（T054 配合）
    }
    // 长按节奏 → 引擎推进 → 渲染（只读 state）
    keyboard.update(dtMs);
    touchRepeat.update(dtMs);
    engine.step(dtMs);
    const state = engine.getState();
    renderer.render(state, { effects, now: nowMs });

    // HUD 仅在数值指纹变化时写 DOM（createHud 内部也有同项防护）。
    const hudKey = `${state.score}|${state.lines}|${state.level}`;
    if (hudKey !== lastHudKey) {
      hud.update(state, Math.max(bestScore, state.score));
      lastHudKey = hudKey;
    }
    if (state.score > bestScore) {
      bestScore = state.score;
    }

    // 预览（HOLD + NEXT 前 3）仅队列/暂存变化时更新颜色。
    const previewKey = `${state.heldType ?? '-'}|${state.nextQueue.slice(0, 3).join(',')}`;
    if (previewKey !== lastPreviewKey) {
      holdPreview.set((state.heldType ?? null) as PieceType | null);
      for (let i = 0; i < nextPreviews.length; i += 1) {
        nextPreviews[i].set((state.nextQueue[i] ?? null) as PieceType | null);
      }
      lastPreviewKey = previewKey;
    }

    // 覆盖层状态机（T044 setStatus 幂等；仅状态变化时写）。
    if (state.status !== lastOverlayStatus) {
      overlays.setStatus(state.status as 'ready' | 'running' | 'paused' | 'gameover');
      if (state.status === 'gameover') {
        overlays.setFinalScores(state.score, bestScore);
      }
      lastOverlayStatus = state.status;
    }
  };

  if (!rafRunning) {
    rafRunning = true;
    rafId = requestAnimationFrame(frame);
  }

  // 初始一帧：READY 覆盖层立即显示（首帧 rAF 之前也有正确 UI）。
  overlays.setStatus(engine.getState().status);

  let tornDown = false;
  const teardown = (): void => {
    if (tornDown) {
      return;
    }
    tornDown = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    resizeObserver?.disconnect();
    keyboard.dispose();
    touch.dispose();
    effects.clear();
  };

  return { engine, renderer, teardown };
}

// ── 启动 + 模块级 teardown（Vite 热重载不泄漏监听/RAF，T053 步骤 3） ────────
const appRoot = document.getElementById('app');
let handle: AppHandle | null = null;
if (appRoot !== null) {
  handle = boot(appRoot);
}

// 调试与自动化测试点读句柄（E2E 经 window 读取引擎状态）。
declare global {
  interface Window {
    __NEON_BLOCKS__?: AppHandle;
  }
}
window.__NEON_BLOCKS__ = handle ?? undefined;

/** 测试与热重载清理入口（幂等）。 */
export function teardown(): void {
  handle?.teardown();
  handle = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    teardown();
  });
}
