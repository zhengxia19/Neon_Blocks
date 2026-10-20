/**
 * N32/N33：联网模式装配入口——首页分流后的创建/加入面板 + 等待大厅接线。
 * 动态路径下才导入 `src/net/`（单人主包不含网络代码）；面板与大厅纯 DOM
 * （`src/ui/mp-entry.ts`、`src/ui/lobby.ts`），本文件只做接线：
 * NetClient 生命周期、room_state 权威视图驱动、协议消息发送与中文错误回显。
 * 对局界面属 N34–N40。
 */
import { PROTOCOL_VERSION, type ServerMessage } from '../../shared/protocol';
import { NetClient } from '../net';
import { bootMatch, computeClockOffset, countdownLabel, type MatchHandle } from './match';
import { renderLobby, type LobbyController } from '../ui/lobby';
import { renderMultiplayerEntry, type EntryController } from '../ui/mp-entry';

/** 联网装配句柄（连接与 teardown）。 */
export interface MultiplayerHandle {
  apiBaseUrl: string;
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
          match = bootMatch(root, msg, clockOffset);
          break;
        }
        case 'error':
          lobby?.showMessage('error', msg.message);
          break;
        default:
          break;
      }
    },
    onClose: (info): void => {
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
    teardown(): void {
      if (tornDown) return;
      tornDown = true;
      client.close();
      clearPreCountdown();
      entry?.destroy();
      lobby?.destroy();
      match?.destroy();
    },
  };
}
