/**
 * N32/N33：联网模式装配入口——首页分流后的创建/加入面板 + 等待大厅接线。
 * 动态路径下才导入 `src/net/`（单人主包不含网络代码）；面板与大厅纯 DOM
 * （`src/ui/mp-entry.ts`、`src/ui/lobby.ts`），本文件只做接线：
 * NetClient 生命周期、room_state 权威视图驱动、协议消息发送与中文错误回显。
 * N38：对局期消息接线——本人快照发布（SnapshotPublisher 5Hz 上限 + 连接态
 * 联动）、scoreboard/watch_target/remote_snapshot/match_end 转发对局句柄、
 * 引擎 gameover 单发上报（淘汰时刻由服务器接收时刻裁决）。
 */
import { PROTOCOL_VERSION, decodeSnapshot, type ServerMessage, SnapshotPublisher } from '../net';
import { NetClient } from '../net';
import { bootMatch, computeClockOffset, countdownLabel, type MatchHandle } from './match';
import { renderLobby, type LobbyController } from '../ui/lobby';
import { renderMultiplayerEntry, type EntryController } from '../ui/mp-entry';
import { mountMultiplayerLayout } from '../ui/multiplayer-layout';

// N36：模块级暴露布局装配函数——E2E 可在无 Worker 时直接挂载双棋盘骨架做布局断言。
(window as unknown as Record<string, unknown>).__NEON_BLOCKS_MP_LAYOUT__ = mountMultiplayerLayout;

/** 联网装配句柄（连接与 teardown）。 */
export interface MultiplayerHandle {
  apiBaseUrl: string;
  /** N38：诊断/E2E——对局观察目标与远程棋盘水位（无对局时 null）。 */
  matchDebug(): { watchTargetId: string | null; remoteSeq: number } | null;
  teardown(): void;
}

/**
 * 挂载联网入口（全中文、无登录）。
 * @param root 页面根元素
 * @param apiBaseUrl 已校验非空的公开 API 地址（由 main.ts 分流时保证）
 */
export function bootMultiplayer(root: HTMLElement, apiBaseUrl: string): MultiplayerHandle {
  let entry: EntryController | null = null;
  let lobby: LobbyController | null = null;
  let match: MatchHandle | null = null;
  let myPlayerId = '';
  let leftIntentionally = false;
  // N34：服务器墙钟偏差（最近一次 room_state.serverTime 校准）。
  let clockOffset = 0;
  // N34：预倒计时遮罩（countdown→match_start 之间；只依赖校准墙钟显示）。
  let preCountdownEl: HTMLElement | null = null;
  let preCountdownTimer: number | null = null;
  // N38：本人快照发布（seq 由发布计数单调供给；gameover 单发一次）。
  let publisher: SnapshotPublisher | null = null;
  let snapTimer: number | null = null;
  let snapSeq = 0;
  let gameoverSent = false;

  const stopSnapshotPublishing = (): void => {
    if (snapTimer !== null) {
      window.clearInterval(snapTimer);
      snapTimer = null;
    }
    publisher?.stop();
    publisher = null;
  };

  const startSnapshotPublishing = (): void => {
    if (match === null) return;
    snapSeq = 0;
    gameoverSent = false;
    publisher = new SnapshotPublisher({
      // 发布器出口是编码后文本：解码回对象走 NetClient.send（统一 seq 信封）。
      send: (text): boolean => {
        const decoded = decodeSnapshot(text);
        return decoded.ok
          ? client.send({ v: PROTOCOL_VERSION, type: 'snapshot', snapshot: decoded.snapshot })
          : false;
      },
    });
    publisher.setActive(true);
    publisher.setConnected(client.state === 'open');
    snapTimer = window.setInterval((): void => {
      if (match === null || publisher === null) return;
      const state = match.engine.getState();
      snapSeq += 1;
      publisher.publish(match.buildSnapshot(snapSeq));
      if (!gameoverSent && state.status === 'gameover') {
        // 复审 N38 P2-2：send 成功才置位——断线瞬间的 gameover 上报在重连后的
        // 下一 tick 重试（服务端仅经 gameover 消息裁决淘汰时刻）。
        if (client.send({ v: PROTOCOL_VERSION, type: 'gameover', reason: 'topout' })) {
          gameoverSent = true;
        }
      }
    }, 250);
  };

  const clearPreCountdown = (): void => {
    if (preCountdownTimer !== null) {
      window.clearInterval(preCountdownTimer);
      preCountdownTimer = null;
    }
    preCountdownEl?.remove();
    preCountdownEl = null;
  };

  const showPreCountdown = (startAt: number): void => {
    if (preCountdownEl !== null) return;
    preCountdownEl = document.createElement('div');
    preCountdownEl.id = 'mp-pre-countdown';
    preCountdownEl.setAttribute('role', 'status');
    root.appendChild(preCountdownEl);
    const tick = (): void => {
      const label = countdownLabel(startAt - (Date.now() + clockOffset));
      preCountdownEl!.textContent = label === 'GO' ? '即将开始……' : `即将开始：${label}`;
    };
    tick();
    preCountdownTimer = window.setInterval(tick, 200);
  };

  const client = new NetClient({
    apiBaseUrl,
    onMessage: (msg: ServerMessage): void => {
      switch (msg.type) {
        case 'room_state':
          clockOffset = computeClockOffset(msg.serverTime, Date.now());
          lobby?.update(msg);
          break;
        case 'player_joined':
          lobby?.showMessage('info', `${msg.player.nickname} 加入了房间。`);
          break;
        case 'player_left':
          lobby?.showMessage('info', '有玩家离开了房间。');
          break;
        case 'countdown':
          lobby?.showMessage('info', '比赛即将开始……');
          showPreCountdown(msg.startAt);
          break;
        case 'match_start': {
          // N34：按服务器种子/等级装配本地对局，开局时刻由校准墙钟判定。
          if (match !== null) break; // 同局重传防重复装配
          clearPreCountdown();
          lobby?.destroy();
          lobby = null;
          match = bootMatch(root, msg, clockOffset, myPlayerId);
          // N38：装配完成即开始 5Hz 快照发布（对局期数据上行）。
          startSnapshotPublishing();
          break;
        }
        case 'scoreboard':
          // N38：全员同一份榜单（服务端排序），逐行照抄进排行榜视图。
          match?.applyScoreboard(msg.entries);
          break;
        case 'watch_target':
          // N38：切换对手预览（同步生效；服务器已按 ≤500ms 批次去抖）。
          match?.applyWatchTarget(msg.targetPlayerId);
          break;
        case 'remote_snapshot':
          // N38：只绘制当前观察目标帧（陈旧目标迟到帧在对局句柄内丢弃）。
          match?.applyRemoteSnapshot(msg.targetPlayerId, msg.snapshot);
          break;
        case 'match_end':
          // N38：胜者仅标记高亮（结果面板完整语义属 N39）。
          match?.applyMatchEnd(msg.winners);
          break;
        case 'error':
          lobby?.showMessage('error', msg.message);
          break;
        default:
          break;
      }
    },
    onOpen(): void {
      // N38：重连成功即恢复快照发布通道（断开期间的帧已被发布器丢弃）。
      publisher?.setConnected(true);
    },
    onClose: (info): void => {
      publisher?.setConnected(false);
      if (leftIntentionally) return;
      if (info.willReconnect) {
        lobby?.showMessage('info', '连接中断，正在自动重连……');
      } else {
        lobby?.showMessage('error', '与服务器断开连接，请刷新页面重试。');
      }
    },
    onFatal: (err): void => {
      lobby?.showMessage('error', err.message);
    },
  });

  async function enterLobby(code: string, playerId: string): Promise<void> {
    myPlayerId = playerId;
    const res = await client.connect();
    if (!res.ok) {
      entry?.showMessage('error', res.message);
      return;
    }
    entry?.destroy();
    entry = null;
    lobby = renderLobby(root, myPlayerId, {
      onReady(): void {
        client.send({ v: PROTOCOL_VERSION, type: 'ready' });
      },
      onStart(): void {
        client.send({ v: PROTOCOL_VERSION, type: 'start' });
      },
      onLeave(): void {
        client.send({ v: PROTOCOL_VERSION, type: 'leave' });
        leftIntentionally = true;
        client.leave();
        leftIntentionally = false;
        clearPreCountdown();
        stopSnapshotPublishing();
        lobby?.destroy();
        lobby = null;
        entry = renderMultiplayerEntry(root, entryHandlers);
        entry.showMessage('info', '已离开房间。');
      },
      onSettingsUpdate(settings): void {
        client.send({ v: PROTOCOL_VERSION, type: 'settings_update', ...settings });
      },
    });
    lobby.showMessage('info', `房间码 ${code}，分享给好友加入；全员准备后房主可开局。`);
  }

  const entryHandlers = {
    onCreate: (nickname: string): void => {
      entry?.setBusy(true);
      void client
        .createRoom({ nickname, capacity: 4, randomMode: 'S1', startLevel: 1 })
        .then((res) => {
          if (res.ok) return enterLobby(res.data.code, res.data.playerId);
          entry?.showMessage('error', res.message);
          return undefined;
        })
        .catch(() => {
          entry?.showMessage('error', '服务器暂时无法访问，请稍后再试。');
        })
        .finally(() => entry?.setBusy(false));
    },
    onJoin: (nickname: string, roomCode: string): void => {
      entry?.setBusy(true);
      void client
        .joinRoom(roomCode, nickname)
        .then((res) => {
          if (res.ok) return enterLobby(res.data.code, res.data.playerId);
          entry?.showMessage('error', res.message);
          return undefined;
        })
        .catch(() => {
          entry?.showMessage('error', '服务器暂时无法访问，请稍后再试。');
        })
        .finally(() => entry?.setBusy(false));
    },
  };

  entry = renderMultiplayerEntry(root, entryHandlers);

  let tornDown = false;
  return {
    apiBaseUrl,
    matchDebug(): { watchTargetId: string | null; remoteSeq: number } | null {
      if (match === null) return null;
      return { watchTargetId: match.debug.watchTargetId(), remoteSeq: match.debug.remoteSeq() };
    },
    teardown(): void {
      if (tornDown) return;
      tornDown = true;
      client.close();
      clearPreCountdown();
      stopSnapshotPublishing();
      entry?.destroy();
      lobby?.destroy();
      match?.destroy();
    },
  };
}
