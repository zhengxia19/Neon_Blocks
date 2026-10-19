// Neon Blocks — 唯一装配入口（规格 S02/S05/S07/S08，任务 T053–T056）。
// 单实例创建：GameEngine、BoardRenderer、HUD、预览、覆盖层、设置弹窗、
// EffectsController、SoundManager、键盘/触控输入。
// requestAnimationFrame 单循环：dt → 长按节奏 → engine.step(dt) → render →
// HUD 仅变化时更新。getState() 只读。模块级 teardown() 清理监听/RAF/音频。
// 设置跨刷新生效（S07）：Ghost/减少动画实时传给渲染层；音量传 SoundManager；
// 最终减少动画 = 系统 prefers-reduced-motion OR 用户设置（S07）。

import './styles/tokens.css';
import './styles/app.css';
import './styles/responsive.css';

import { GameEngine } from './game/engine';
import type { PieceType } from './game/types';
import { loadSettings, readBestScore, writeBestScore, type GameSettings } from './storage/settings';
import { SoundManager } from './audio/sound';
import { KeyboardController } from './input/keyboard';
import { RepeatController } from './input/repeat';
import { createTouchControls, type TouchControls } from './input/touch';
import { BoardRenderer } from './ui/renderer';
import { EffectsController } from './ui/effects';
import { createHud, createPiecePreview } from './ui/hud';
import { createOverlays, createSettingsDialog } from './ui/overlays';
import { mountLayout, type LayoutRefs } from './ui/layout';

/** 全局装配句柄（E2E/手动调试与 teardown 使用）。 */
interface AppHandle {
  engine: GameEngine;
  renderer: BoardRenderer;
  teardown(): void;
}

function boot(rootElement: HTMLElement): AppHandle {
  const refs: LayoutRefs = mountLayout(rootElement);

  // ── 持久化读取（S07：启动读设置/最高分，异常安全降级） ──────────────────
  let settings: GameSettings = loadSettings();
  let bestScore = readBestScore();
  const reducedMotionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };
  /** 最终减少动画：系统偏好 OR 用户设置（S07）。 */
  const finalReducedMotion = (): boolean => reducedMotionQuery.matches || settings.reducedMotion;

  // ── 单实例核心 ─────────────────────────────────────────────────────────────
  const engine = new GameEngine();
  const renderer = new BoardRenderer(refs.boardCanvas);
  const effects = new EffectsController();
  const sound = new SoundManager({ enabled: settings.soundEnabled }); // 默认静音：不实例化上下文
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

  // ── 音效代理（S08 四声）：move/rotate 属输入动作即时发声（move 内部节流）；
  //    lock/clear/hardDrop 走引擎事件单次消费（frame 内），互不重复。 ────────
  const audioEngine = {
    move: (dx: -1 | 1): void => {
      engine.move(dx);
      sound.playSound('move');
    },
    rotate: (dir: 1 | -1): void => {
      engine.rotate(dir);
      sound.playSound('rotate');
    },
    softDrop: (): void => engine.softDrop(),
    hardDrop: (): void => engine.hardDrop(),
    hold: (): void => engine.hold(),
    togglePause: (): void => engine.togglePause(),
    start: (): void => engine.start(),
    restart: (): void => engine.restart(),
    step: (dt: number): void => engine.step(dt),
    getState: () => engine.getState(),
  } as unknown as GameEngine;

  // ── 覆盖层/头部按钮行为（S03.3/S04.3/S06，T055）──────────────────────────
  const commitBestScore = (): void => {
    writeBestScore(engine.getState().score);
    bestScore = readBestScore();
  };
  overlays.startButton.addEventListener('click', () => {
    if (engine.getState().status === 'ready') {
      engine.start();
    }
  });
  overlays.resumeButton.addEventListener('click', () => {
    if (engine.getState().status === 'paused') {
      engine.togglePause();
    }
  });
  overlays.restartButton.addEventListener('click', () => {
    if (engine.getState().status !== 'paused') {
      return;
    }
    // 活跃对局的重开需确认；取消状态不变，确认先落盘最高分。
    if (window.confirm('重新开始将丢弃当前进度，确认吗？')) {
      commitBestScore();
      engine.restart();
    }
  });
  overlays.replayButton.addEventListener('click', () => {
    if (engine.getState().status === 'gameover') {
      engine.restart();
    }
  });
  refs.pauseButton.addEventListener('click', () => {
    const status = engine.getState().status;
    if (status === 'running' || status === 'paused') {
      engine.togglePause();
    }
  });

  // ── 设置弹窗（S07/S04.3，T056）：打开即自动暂停（防偷跑），关闭后保持 ────
  // paused 由用户显式继续；勾选变化即时落盘 + 立即应用（Ghost 即时渲染、
  // 音量即时生效、减少动画即时生效）。
  const settingsDialog = createSettingsDialog(refs.overlayRoot);
  settingsDialog.onChange = (next): void => {
    settings = next;
    sound.setEnabled(next.soundEnabled);
  };
  refs.settingsButton.addEventListener('click', () => {
    if (engine.getState().status === 'running') {
      engine.togglePause(); // 弹设置不偷跑游戏（T056 验收）
    }
    settingsDialog.open(settings);
  });

  // ── 输入：键盘（内置长按）+ 触控（独立长按控制器，同 DAS/ARR 参数） ──────
  const keyboard = new KeyboardController(audioEngine, {
    onEscape: () => {
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
        commitBestScore();
        engine.restart();
      }
    },
  });
  keyboard.attach(window);

  const touchRepeat = new RepeatController({
    move: (direction) => audioEngine.move(direction),
    softDrop: () => engine.softDrop(),
  });
  let touch: TouchControls | null = createTouchControls(refs.touchControls, {
    repeat: touchRepeat,
    actions: {
      rotate: (direction) => audioEngine.rotate(direction),
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
  const suspendGame = (): void => {
    if (engine.getState().status === 'running') {
      engine.togglePause();
    }
    keyboard.releaseAll();
    touchRepeat.releaseAll();
    touch?.releaseAll();
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

  // ── 单 rAF 主循环（S05）───────────────────────────────────────────────────
  let rafId = 0;
  let lastFrameMs = performance.now();
  let lastHudKey = '';
  let lastPreviewKey = '';
  let lastOverlayStatus = '';
  let lastSoundEventId: number | null = null;
  let rafRunning = false;

  const frame = (nowMs: number): void => {
    rafId = requestAnimationFrame(frame);
    let dtMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    if (dtMs < 0) {
      dtMs = 0;
    }
    if (dtMs > 250) {
      dtMs = 250; // 掉帧/后台恢复封顶（T054 配合）
    }
    // 长按节奏 → 引擎推进 → 渲染（只读 state；Ghost/减少动画来自实时设置）
    keyboard.update(dtMs);
    touchRepeat.update(dtMs);
    engine.step(dtMs);
    const state = engine.getState();
    renderer.render(state, {
      effects,
      now: nowMs,
      ghostEnabled: settings.ghostEnabled,
      reducedMotion: finalReducedMotion(),
    });

    // 引擎事件仅消费一次：清行/锁定/硬降短音（S08；同 id 不重播）。
    const lastEvent = state.lastEvent;
    if (lastEvent !== null && lastEvent !== undefined && lastEvent.id !== lastSoundEventId) {
      lastSoundEventId = lastEvent.id;
      if (lastEvent.kind === 'clear') {
        sound.playSound('clear');
      } else if (lastEvent.kind === 'lock' || lastEvent.kind === 'hardDrop') {
        sound.playSound('lock');
      }
    }

    // HUD 仅在数值指纹变化时写 DOM；最高分跨会话来自存储。
    if (state.score > bestScore) {
      bestScore = state.score; // 会话内即时可见
    }
    const hudKey = `${state.score}|${state.lines}|${state.level}`;
    if (hudKey !== lastHudKey) {
      hud.update(state, bestScore);
      lastHudKey = hudKey;
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
      if (state.status === 'gameover') {
        writeBestScore(state.score); // 新高落盘（T047 语义：仅新高写入）
        bestScore = readBestScore();
        overlays.setFinalScores(state.score, bestScore);
      }
      overlays.setStatus(state.status);
      lastOverlayStatus = state.status;
    }
  };

  if (!rafRunning) {
    rafRunning = true;
    rafId = requestAnimationFrame(frame);
  }

  // 初始一帧：READY 覆盖层与最高分读数立即正确。
  overlays.setStatus(engine.getState().status);
  hud.update({ score: 0, lines: 0, level: 1 }, bestScore);

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
    touch?.dispose();
    touch = null;
    sound.dispose(); // 关闭 AudioContext（T056 步骤 3）
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
