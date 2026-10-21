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
 * N39-b：对局状态行明确展示 600 秒剩余（`deadlineAt − 校准墙钟` 逐秒刷新）与
 * 本人淘汰（服务端榜单 status=eliminated 驱动，不本地另算）；match_end 全量
 * 消费（原因 + 胜者独立文案 + 房主「下一局」按钮，match-results.ts 组件）。
 */
import { GameEngine } from '../game/engine';
import { createSeededRng } from '../game/seeded-rng';
import type { LeaderboardEntry, MatchEndMsg, MatchStartMsg, SnapshotPayload } from '../../shared/protocol';
import { mountMultiplayerLayout, type MultiplayerLayoutRefs } from '../ui/multiplayer-layout';
import { BoardRenderer } from '../ui/renderer';
import { EffectsController } from '../ui/effects';
import { createHud } from '../ui/hud';
import { RemoteBoard } from '../ui/remote-board';
import { createLeaderboardView, statusLabel } from '../ui/leaderboard';
import { createResultsPanel, endReasonLabel, formatRemaining, winnersText } from '../ui/match-results';
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
  applyMatchEnd(msg: MatchEndMsg): void;
  /** N40：断线冻结/恢复——冻结期间本地棋盘不步进、键盘卸载（服务端比赛不停摆）。 */
  setFrozen(frozen: boolean): void;
  /** N40：重连进 FINISHED（错过 match_end）：无明细终局展示，等待房主下一局。 */
  applyRoomFinished(): void;
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
  // 复审 N39-b P2-2：isHost 用 getter 而非快照——房主局中离开触发转让后，
  // 新房主的结果面板仍出现「下一局」按钮（match_end 时刻读实时值）。
  ui: { isHost: () => boolean; onNextRound: () => void } = { isHost: () => false, onNextRound: () => undefined },
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

  // 复审 N40-a P1：刷新重建后服务端不补发 watch_target（订阅映射跨断线存活，
  // 仅「目标改变」才补发），但 remote_snapshot 已按服务端映射路由到正确观看者
  // ⇒ 无目标时以首帧采纳目标（自愈，无需额外缓存；水位随采纳复位）。
  const adoptWatchTarget = (targetPlayerId: string): void => {
    watchTargetId = targetPlayerId;
    remoteBoard.resetForTarget();
    syncOpponentPanel();
  };

  // N39-b：结果面板（match_end 驱动显示；房主才渲染「下一局」按钮）。
  const results = createResultsPanel(refs.overlayRoot, { onNextRound: ui.onNextRound });

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
  // N40：动作经 inputLive 门控——断线冻结/终局后触屏不再触碰引擎。
  const touchRepeat = new RepeatController({
    move: (direction) => {
      if (inputLive()) engine.move(direction);
    },
    softDrop: () => {
      if (inputLive()) engine.softDrop();
    },
  });
  const touch = createTouchControls(refs.touchControls, {
    repeat: touchRepeat,
    actions: {
      rotate: (direction) => {
        if (inputLive()) engine.rotate(direction);
      },
      hardDrop: () => {
        if (inputLive()) engine.hardDrop();
      },
      hold: () => {
        if (inputLive()) engine.hold();
      },
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
  // N39-b：终局标记与本人淘汰标记（均由服务端消息驱动，不本地裁决）。
  let ended = false;
  let selfEliminated = false;
  let lastStatusLabel = '';
  // N40：断线冻结标记（由装配层按连接事件驱动；服务端比赛不停摆）。
  let frozen = false;
  // N40：冻结或终局后本地操作不可信/无意义——触屏与节奏一律不触碰引擎。
  const inputLive = (): boolean => !frozen && !ended;

  const frame = (nowMs: number): void => {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    const dtMs = clampFrameDelta(nowMs - lastFrameMs);
    lastFrameMs = nowMs;

    // 长按节奏推进（与单人主循环同构）：键盘 ↓ 与触屏 ↓ 的软降节奏
    // 由 update(dt) 累加驱动（RepeatController 无独立计时器）。
    // 复审 N39-b P2-1：match_end 后冻结本地棋盘（不再步进/推进节奏）。
    // N40：断线冻结同样跳过步进与节奏（服务端比赛不停摆，恢复后续跑）。
    if (!frozen && !ended) {
      keyboard.update(dtMs);
      touchRepeat.update(dtMs);
    }

    // 开局判定：校准墙钟到达 startAt 即启动（不依赖隐藏页里停摆的 rAF 计数）。
    if (!started && !ended && !frozen && wallNow() + clockOffset >= match.startAt) {
      started = true;
      engine.start();
    }
    if (!frozen && !ended) engine.step(dtMs);

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
    } else {
      if (!statusShown) {
        statusShown = true;
        countdown.textContent = '';
        countdown.hidden = true;
      }
      // N39-b：状态行明确展示 600 秒剩余（服务器 deadlineAt − 校准墙钟，逐秒
      // 刷新；隐藏页 rAF 停摆但墙钟照样推进，恢复即正确）与本人淘汰
      // （服务端榜单 status=eliminated 驱动，不本地另算）。
      // N40：冻结期间保留「连接中断」提示（解冻后 lastStatusLabel 已清空，
      // 下一帧重算续跑文案）。
      if (!frozen && !ended) {
        const selfTag = selfEliminated ? '你已淘汰，等待比赛结束' : '比赛进行中';
        const label = `${selfTag} · 剩余 ${formatRemaining(match.deadlineAt - (wallNow() + clockOffset))}`;
        if (label !== lastStatusLabel) {
          lastStatusLabel = label;
          statusLine.textContent = label;
        }
      }
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
      // N39-b：本人淘汰以服务端榜单状态为准（gameover 上报后 ≤500ms 批量广播）。
      const selfEntry = entries.find((entry) => entry.playerId === selfPlayerId);
      if (selfEntry?.status === 'eliminated') selfEliminated = true;
      leaderboardView.update(entries, selfPlayerId);
      syncOpponentPanel();
    },
    applyWatchTarget(targetPlayerId: string): void {
      if (targetPlayerId === watchTargetId) return;
      // 切换即复位水位（旧目标最后画面保留至新目标补帧到达，无闪白）。
      adoptWatchTarget(targetPlayerId);
    },
    applyRemoteSnapshot(targetPlayerId: string, snapshot: SnapshotPayload): boolean {
      // 复审 N40-a P1：无目标（刷新重建后服务端不补发 watch_target）⇒ 首帧采纳；
      // 陈旧目标的迟到帧直接丢弃（无第三棋盘语义）。
      if (watchTargetId === null) {
        adoptWatchTarget(targetPlayerId);
      } else if (targetPlayerId !== watchTargetId) {
        return false;
      }
      const drawn = remoteBoard.applySnapshot(snapshot);
      // 复审 N38 P2-1：当前目标首帧绘制成功后补一次面板同步——此前被延迟的
      // 淘汰冻结/断线遮罩在目标自己的最后画面上生效。
      if (drawn) syncOpponentPanel();
      return drawn;
    },
    applyMatchEnd(msg: MatchEndMsg): void {
      // N39-b：全员收到同一条 match_end → 全员显示同一结果。胜者昵称按服务端
      // 榜单顺序提取（与 winnersSummary 同规则），保证各客户端文案一致；
      // 胜负独立文案与「得分第一」语义分离（榜单行序不因胜者改变）。
      ended = true;
      leaderboardView.markWinners(msg.winners);
      const winnerSet = new Set(msg.winners);
      const names = lastEntries
        .filter((entry) => winnerSet.has(entry.playerId))
        .map((entry) => entry.nickname);
      const reasonLabel = endReasonLabel(msg.reason);
      statusLine.textContent = reasonLabel;
      results.show({ reasonLabel, winnersText: winnersText(names), isHost: ui.isHost() });
      // 复审 N39-b P2-1：终局即释放并卸载输入（键盘监听移除、触屏按钮移除），
      // 死局棋盘不可再操作；dispose 幂等（destroy 二次调用安全）。
      releaseInputs();
      keyboard.dispose();
      touch.dispose();
    },
    setFrozen(frozenNow: boolean): void {
      // N40：断线⇒停止不可信本地操作（卸载键盘、释放长按、棋盘不步进）；
      // 恢复⇒重挂键盘、重置帧时间戳（dt 封顶双保险），状态行下一帧重算。
      if (destroyed || ended || frozenNow === frozen) return;
      frozen = frozenNow;
      if (frozenNow) {
        releaseInputs();
        keyboard.dispose();
        statusLine.textContent = '连接中断，比赛仍在服务器进行……';
      } else {
        keyboard.attach(window);
        lastFrameMs = performance.now();
        lastStatusLabel = '';
      }
    },
    applyRoomFinished(): void {
      // N40（复审 N39-b O-7）：断线错过 match_end 后重连进 FINISHED——
      // 无胜负明细的终局展示（match_end 不可补发），等待房主下一局回大厅。
      if (destroyed || ended) return;
      ended = true;
      statusLine.textContent = '比赛已结束，等待房主开始下一局';
      releaseInputs();
      keyboard.dispose();
      touch.dispose();
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
      results.destroy();
    },
  };
}
