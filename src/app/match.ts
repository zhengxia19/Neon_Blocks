/**
 * N34：联网本地比赛初始化与时钟。
 * 服务器权威计时：`startAt/deadlineAt` 为服务器墙钟毫秒；客户端用最近一次
 * `room_state.serverTime` 校准偏差（`serverNow = Date.now() + offset`），
 * 倒计时与开局判定只依赖墙钟偏差，不依赖 rAF 可见帧推进。
 * 联网对局禁用个人暂停/重开：本装配从不调用 togglePause/restart，Esc 空操作；
 * 后台冻结防护：rAF 在隐藏页停摆，恢复后单帧 dt 封顶（MAX_CATCHUP_MS），
 * 不补跑大量游戏帧；继续/淘汰由服务器 room_state 决定（N39 接入结果 UI）。
 * 纯助手（偏差/标签/封顶）导出供单测钉死；本文件不出现任何网络代码。
 */
import { GameEngine } from '../game/engine';
import { createSeededRng } from '../game/seeded-rng';
import type { MatchStartMsg } from '../../shared/protocol';
import { mountMultiplayerLayout, type MultiplayerLayoutRefs } from '../ui/multiplayer-layout';
import { BoardRenderer } from '../ui/renderer';
import { EffectsController } from '../ui/effects';
import { createHud } from '../ui/hud';
import { KeyboardController } from '../input/keyboard';
import { RepeatController } from '../input/repeat';
import { createTouchControls } from '../input/touch';

/** 掉帧/后台恢复的单帧推进封顶（与单人主循环 T054 同值）。 */
export const MAX_CATCHUP_MS = 250;

/** 服务器墙钟偏差：serverTime − 本地时刻；serverNow = Date.now() + offset。 */
export function computeClockOffset(serverTime: number, clientNow: number): number {
  return serverTime - clientNow;
}

/** 倒计时标签：剩余毫秒 → '3'/'2'/'1'；到点及以后 → 'GO'。 */
export function countdownLabel(remainingMs: number): string {
  if (remainingMs <= 0) return 'GO';
  const seconds = Math.ceil(remainingMs / 1000);
  return String(Math.min(3, seconds));
}

/** 主循环单帧推进量：负值归零、超过封顶截断（不补跑积压帧）。 */
export function clampFrameDelta(dtMs: number): number {
  if (dtMs < 0) return 0;
  return dtMs > MAX_CATCHUP_MS ? MAX_CATCHUP_MS : dtMs;
}

/** 对局装配句柄。 */
export interface MatchHandle {
  matchId: string;
  engine: GameEngine;
  destroy(): void;
}

/**
 * 按服务器 match_start 参数装配本地对局：种子/初始等级来自服务器（全员锁定），
 * 开局时刻由校准墙钟判定；个人暂停/重开禁用。
 */
export function bootMatch(
  root: HTMLElement,
  match: MatchStartMsg,
  clockOffset: number,
  deps: { now?: () => number } = {},
): MatchHandle {
  const wallNow = deps.now ?? ((): number => Date.now());
  // N36：联网装配使用双棋盘布局（本人棋盘与单人完全一致 + 对手棋盘/排行榜槽）。
  const refs: MultiplayerLayoutRefs = mountMultiplayerLayout(root);

  // 个人暂停/重开禁用：隐藏暂停按钮并禁用（键盘 Esc 亦空操作）。
  refs.pauseButton.hidden = true;
  refs.pauseButton.disabled = true;

  const engine = new GameEngine(createSeededRng(match.seatSeed), undefined, match.startLevel);
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

  // 倒计时遮罩：只依赖校准墙钟（rAF 停摆期间时间照样推进，恢复即正确）。
  const countdown = document.createElement('div');
  countdown.id = 'mp-countdown';
  countdown.setAttribute('role', 'status');
  refs.overlayRoot.appendChild(countdown);
  const statusLine = document.createElement('div');
  statusLine.id = 'mp-match-status';
  statusLine.setAttribute('role', 'status');
  statusLine.textContent = '对局初始化';
  refs.overlayRoot.appendChild(statusLine);

  const keyboard = new KeyboardController(engine, {
    onEscape(): void {
      // 联网对局禁用个人暂停：Esc 空操作。
    },
    onConfirm(): void {
      // 开局/重开由服务器驱动：Enter 空操作。
    },
  });
  keyboard.attach(window);

  // N36：触屏按键与单人同一套装配（RepeatController 共享节奏），手机可操作。
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

  // N36：窗口尺寸变化同步本人棋盘 backing store（对手棋盘随 RemoteBoard.resize
  // 在 N38 接线）；BoardRenderer.resize 幂等，同尺寸不写 canvas.width。
  const onResize = (): void => {
    renderer.resize();
  };
  window.addEventListener('resize', onResize);

  let rafId = 0;
  let lastFrameMs = performance.now();
  let started = false;
  let destroyed = false;
  let lastHudKey = '';
  let lastLabel = '';
  let statusShown = false;

  const frame = (nowMs: number): void => {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    const dtMs = clampFrameDelta(nowMs - lastFrameMs);
    lastFrameMs = nowMs;

    // 长按节奏推进（与单人主循环同构）：键盘 ↓ 与触屏 ↓ 的软降节奏
    // 由 update(dt) 累加驱动（RepeatController 无独立计时器）。
    keyboard.update(dtMs);
    touchRepeat.update(dtMs);

    // 开局判定：校准墙钟到达 startAt 即启动（不依赖隐藏页里停摆的 rAF 计数）。
    if (!started && wallNow() + clockOffset >= match.startAt) {
      started = true;
      engine.start();
    }
    engine.step(dtMs);

    const state = engine.getState();
    renderer.render(state, {
      effects,
      now: nowMs,
      ghostEnabled: true,
      reducedMotion: false,
    });
    const hudKey = `${state.score}|${state.lines}|${state.level}`;
    if (hudKey !== lastHudKey) {
      hud.update(state, 0);
      lastHudKey = hudKey;
    }

    // 倒计时显示（3→2→1→隐藏）；进行中状态行。
    // 服务器 match_start 于 startAt 到点才广播：装配时倒计时通常已走完，
    // 首帧即切换「比赛进行中」（预倒计时由 multiplayer 在大厅阶段展示）。
    if (!started) {
      const label = countdownLabel(match.startAt - (wallNow() + clockOffset));
      if (label !== lastLabel) {
        lastLabel = label;
        countdown.textContent = `即将开始：${label}`;
      }
    } else if (!statusShown) {
      statusShown = true;
      countdown.textContent = '';
      countdown.hidden = true;
      statusLine.textContent = '比赛进行中';
    }
  };
  rafId = requestAnimationFrame(frame);

  // 后台冻结防护：隐藏/失焦不暂停服务端比赛，只释放输入并重置时间戳；
  // 恢复后由封顶 dt 单帧续跑，继续/淘汰以服务器 room_state 为准。
  const releaseInputs = (): void => {
    keyboard.releaseAll();
    touchRepeat.releaseAll();
    touch.releaseAll();
  };
  const onVisibilityChange = (): void => {
    if (!document.hidden) lastFrameMs = performance.now();
    releaseInputs();
  };
  const onBlur = (): void => releaseInputs();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('blur', onBlur);

  return {
    matchId: match.matchId,
    engine,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      keyboard.dispose();
      touch.dispose();
    },
  };
}
