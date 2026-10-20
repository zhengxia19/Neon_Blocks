/**
 * N34：联网本地比赛初始化与时钟。
 * 服务器权威计时：`startAt/deadlineAt` 为服务器墙钟毫秒；客户端用最近一次
 * `room_state.serverTime` 校准偏差（`serverNow = Date.now() + offset`），
 * 倒计时与开局判定只依赖墙钟偏差，不依赖 rAF 可见帧推进。
 * 联网对局禁用个人暂停/重开：本装配从不调用 togglePause/restart，Esc 空操作；
 * 后台冻结防护：rAF 在隐藏页停摆，恢复后单帧 dt 封顶（MAX_CATCHUP_MS），
 * 不补跑大量游戏帧；继续/淘汰由服务器 room_state 决定（N39 接入结果 UI）。
 * 纯助手（偏差/标签/封顶）导出供单测钉死；本文件不出现任何网络代码。
 * N38：双棋盘与排行榜连接——远程棋盘（RemoteBoard）挂在 #opponent-canvas，
 * 排行榜视图（leaderboard.ts）填 #leaderboard-slot；`applyScoreboard/
 * applyWatchTarget/applyRemoteSnapshot/applyMatchEnd` 由 multiplayer 接线转发
 * 服务器消息（本文件只消费，不收发）。切换观察目标即 `resetForTarget`
 * （旧目标最后画面保留至新目标补帧到达，无闪白）；resize 透传远程 Canvas。
 */
import { GameEngine } from '../game/engine';
import { createSeededRng } from '../game/seeded-rng';
import type { LeaderboardEntry, MatchStartMsg, SnapshotPayload } from '../../shared/protocol';
import { mountMultiplayerLayout, type MultiplayerLayoutRefs } from '../ui/multiplayer-layout';
import { BoardRenderer } from '../ui/renderer';
import { EffectsController } from '../ui/effects';
import { createHud } from '../ui/hud';
import { RemoteBoard } from '../ui/remote-board';
import { createLeaderboardView, statusLabel } from '../ui/leaderboard';
import { snapshotFromState } from './snapshot-source';
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
  /** N38：服务器 scoreboard → 排行榜视图与对手面板（榜单逐行照抄，不重排）。 */
  applyScoreboard(entries: LeaderboardEntry[]): void;
  /** N38：watch_target 切换观察目标（同步生效：<1s；同目标重复通知幂等）。 */
  applyWatchTarget(targetPlayerId: string): void;
  /** N38：remote_snapshot 仅接受当前观察目标的帧（陈旧目标帧丢弃）。 */
  applyRemoteSnapshot(targetPlayerId: string, snapshot: SnapshotPayload): boolean;
  /** N38：match_end 胜者标记（仅高亮，不改服务端榜单行序）。 */
  applyMatchEnd(winnerPlayerIds: string[]): void;
  /** N38：本人状态 → 快照载荷（seq 由装配层发布计数供给，本文件不发送）。 */
  buildSnapshot(seq: number): SnapshotPayload;
  /** 诊断/E2E：当前观察目标与远程棋盘水位。 */
  readonly debug: { watchTargetId(): string | null; remoteSeq(): number };
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
  selfPlayerId: string,
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

  // N38：远程棋盘与排行榜视图（消费服务器消息；本文件不收发任何消息）。
  const remoteBoard = new RemoteBoard(refs.opponentCanvas);
  const leaderboardView = createLeaderboardView(refs.leaderboardSlot);
  let watchTargetId: string | null = null;
  let lastEntries: LeaderboardEntry[] = [];

  // 对手面板与观察目标同步（数据源=同一份服务端榜单，绝不本地另算）。
  const syncOpponentPanel = (): void => {
    if (watchTargetId === null) return;
    const entry = lastEntries.find((e) => e.playerId === watchTargetId);
    if (entry === undefined) return;
    refs.opponentName.textContent = entry.nickname;
    refs.opponentScore.textContent = `分数 ${entry.score}`;
    refs.opponentLines.textContent = `消行 ${entry.lines}`;
    refs.opponentStatus.textContent = statusLabel(entry.status);
    // 复审 N38 P2-1：状态驱动冻结/遮罩延迟到当前目标首帧绘制后——服务端顺序为
    // scoreboard(eliminated)→watch_target→补帧，若先 freeze 则补帧被 shouldDraw
    // 丢弃、Canvas 残留上一目标帧。resetForTarget 复位水位（-1），lastSeq>=0
    // 即「当前目标已有帧」，此时冻结保留的才是目标自己的最后画面。
    if (remoteBoard.state.lastSeq < 0) return;
    if (entry.status === 'eliminated') remoteBoard.freeze();
    else if (entry.status === 'disconnected') remoteBoard.setDisconnected();
  };

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

  // N36：窗口尺寸变化同步本人棋盘 backing store；N38：远程棋盘同一 resize
  // 透传（BoardRenderer.resize 幂等，同尺寸不写 canvas.width）。
  const onResize = (): void => {
    renderer.resize();
    remoteBoard.resize();
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
    applyScoreboard(entries: LeaderboardEntry[]): void {
      lastEntries = entries;
      leaderboardView.update(entries, selfPlayerId);
      syncOpponentPanel();
    },
    applyWatchTarget(targetPlayerId: string): void {
      if (targetPlayerId === watchTargetId) return;
      watchTargetId = targetPlayerId;
      // 切换即复位水位（旧目标最后画面保留至新目标补帧到达，无闪白）。
      remoteBoard.resetForTarget();
      syncOpponentPanel();
    },
    applyRemoteSnapshot(targetPlayerId: string, snapshot: SnapshotPayload): boolean {
      // 只绘制当前观察目标的帧：陈旧目标的迟到帧直接丢弃（无第三棋盘语义）。
      if (targetPlayerId !== watchTargetId) return false;
      const drawn = remoteBoard.applySnapshot(snapshot);
      // 复审 N38 P2-1：当前目标首帧绘制成功后补一次面板同步——此前被延迟的
      // 淘汰冻结/断线遮罩在目标自己的最后画面上生效。
      if (drawn) syncOpponentPanel();
      return drawn;
    },
    applyMatchEnd(winnerPlayerIds: string[]): void {
      leaderboardView.markWinners(winnerPlayerIds);
    },
    buildSnapshot(seq: number): SnapshotPayload {
      return snapshotFromState(engine.getState(), seq);
    },
    debug: {
      watchTargetId: (): string | null => watchTargetId,
      remoteSeq: (): number => remoteBoard.state.lastSeq,
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      keyboard.dispose();
      touch.dispose();
      leaderboardView.clear();
    },
  };
}
