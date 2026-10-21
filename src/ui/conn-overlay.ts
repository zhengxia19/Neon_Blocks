/**
 * N40：对局期连接中断遮罩——方案 §「断开后本地比赛如何处理」：本地显示遮罩并
 * 停止输入，恢复后按服务端 room_state 重建显示。纯 DOM 组件：无计时器、
 * 无网络、无 Date.now；文案由装配层（multiplayer）按 NetClient 事件供给。
 */

export interface ConnOverlayController {
  /** 显示遮罩（重复调用只更新文案）。 */
  show(text: string): void;
  hide(): void;
  destroy(): void;
}

export function createConnOverlay(root: HTMLElement): ConnOverlayController {
  const box = document.createElement('div');
  box.id = 'mp-conn-overlay';
  box.setAttribute('role', 'status');
  box.hidden = true;
  root.appendChild(box);
  // 复审 N40-a P2-1：destroy 后 show 为空操作——teardown 的 client.close() 会
  // 触发异步 onClose，届时不得把已销毁遮罩重新挂回文档（僵尸全屏遮罩）。
  let destroyed = false;
  return {
    show(text: string): void {
      if (destroyed) return;
      // bootMatch 的 mountMultiplayerLayout 会重建 root 子树（清掉本遮罩节点）——
      // 显示前若已脱离文档则重新挂载（E2E 首跑教训：断线时元素不存在）。
      if (!box.isConnected) {
        root.appendChild(box);
      }
      box.textContent = text;
      box.hidden = false;
    },
    hide(): void {
      box.hidden = true;
      box.textContent = '';
    },
    destroy(): void {
      destroyed = true;
      box.remove();
    },
  };
}
