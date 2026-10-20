/**
 * N32：联网模式装配入口——首页分流后的创建/加入面板接线。
 * 动态路径下才导入 `src/net/`（单人主包不含网络代码）；面板纯 DOM（`src/ui/mp-entry.ts`），
 * 本文件只做接线：NetClient 生命周期 + 中文错误回显（服务端再验证昵称）。
 * 房主设置与等待大厅属 N33；对局界面属 N34–N40。
 */
import { NetClient } from '../net';
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
  const client = new NetClient({ apiBaseUrl });

  const entry: EntryController = renderMultiplayerEntry(root, {
    onCreate: (nickname) => {
      entry.setBusy(true);
      void client
        .createRoom({ nickname, capacity: 4, randomMode: 'S1', startLevel: 1 })
        .then((res) => {
          if (res.ok) {
            entry.showMessage('info', `已创建房间 ${res.data.code}，席位已保留。`);
          } else {
            entry.showMessage('error', res.message);
          }
        })
        .catch(() => {
          entry.showMessage('error', '服务器暂时无法访问，请稍后再试。');
        })
        .finally(() => entry.setBusy(false));
    },
    onJoin: (nickname, roomCode) => {
      entry.setBusy(true);
      void client
        .joinRoom(roomCode, nickname)
        .then((res) => {
          if (res.ok) {
            entry.showMessage('info', `已加入房间 ${res.data.code}，席位已保留。`);
          } else {
            entry.showMessage('error', res.message);
          }
        })
        .catch(() => {
          entry.showMessage('error', '服务器暂时无法访问，请稍后再试。');
        })
        .finally(() => entry.setBusy(false));
    },
  });

  let tornDown = false;
  return {
    apiBaseUrl,
    teardown(): void {
      if (tornDown) return;
      tornDown = true;
      client.close();
      entry.destroy();
    },
  };
}
