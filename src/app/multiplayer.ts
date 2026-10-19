/**
 * N07：联网模式装配入口（最小占位实现）。
 * 仅证明装配分流与网络边界：动态路径下才导入 `src/net/`（单人主包不含网络代码）。
 * 完整大厅/双棋盘/排行榜属 N32–N40；本文件不创建 GameEngine、不引入 WebSocket 细节。
 */
import { PROTOCOL_VERSION, describeError } from '../net';

/** 联网装配句柄（后续任务扩展连接与 teardown）。 */
export interface MultiplayerHandle {
  apiBaseUrl: string;
  teardown(): void;
}

/**
 * 挂载联网占位面板（全中文）。
 * @param root 页面根元素
 * @param apiBaseUrl 已校验非空的公开 API 地址（由 main.ts 分流时保证）
 */
export function bootMultiplayer(root: HTMLElement, apiBaseUrl: string): MultiplayerHandle {
  const panel = document.createElement('section');
  panel.className = 'mp-entry-panel';
  panel.setAttribute('aria-label', '联网对战');

  const title = document.createElement('h2');
  title.textContent = '联网对战（实施中）';
  const body = document.createElement('p');
  body.textContent =
    `协议 v${PROTOCOL_VERSION} 已就绪；房间大厅与双棋盘界面将在后续任务落地。` +
    `当前 API：${apiBaseUrl}`;
  const back = document.createElement('a');
  back.href = `${window.location.pathname}`;
  back.textContent = '返回单人模式';
  panel.append(title, body, back);
  root.append(panel);

  // 占位期错误文案同样走统一错误目录（中文，不外泄内部文本）。
  void describeError('INTERNAL');

  let tornDown = false;
  return {
    apiBaseUrl,
    teardown(): void {
      if (tornDown) return;
      tornDown = true;
      panel.remove();
    },
  };
}
