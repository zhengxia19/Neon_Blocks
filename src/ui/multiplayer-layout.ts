// Neon Blocks — 联网对局固定双棋盘布局（方案 §6.1，任务 N36）。
// 在单人骨架 mountLayout 之上叠加且仅叠加一个对手棋盘 Canvas 与一个排行榜槽位：
// 全页严格 2 个 Canvas（本人 #board-canvas + 对手 #opponent-canvas），
// 不绘制第 3～6 张棋盘。桌面：本人 300px 主棋盘 + 对手约 60%（180×360）+
// 旁边全员排行榜槽；手机（<768px，见 multiplayer.css）：对手棋盘缩略条置顶、
// 本人游戏区与触屏按键优先，排行榜可折叠但一键展开全部玩家。
// 本文件只构建 DOM 骨架与返回引用；样式全部在 styles/multiplayer.css。

import { mountLayout, type LayoutRefs } from './layout';

/** 联网布局在单人 LayoutRefs 之上的增量引用（N37/N38 按此挂载，不再 querySelector）。 */
export interface MultiplayerLayoutRefs extends LayoutRefs {
  /** 对手棋盘面板（昵称/分数/消行/状态 + Canvas）。 */
  opponentPanel: HTMLElement;
  /** 对手棋盘 Canvas：唯一第二 Canvas，尺寸由 CSS 控制（桌面 180×360）。 */
  opponentCanvas: HTMLCanvasElement;
  opponentName: HTMLElement;
  opponentScore: HTMLElement;
  opponentLines: HTMLElement;
  opponentStatus: HTMLElement;
  /** 排行榜挂载点（N37 leaderboard.ts 填充；服务端同 revision 榜单）。 */
  leaderboardSlot: HTMLElement;
}

interface BuildOptions {
  id?: string;
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  parent?: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  { id, className, text, attrs, parent }: BuildOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (id !== undefined) node.id = id;
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs !== undefined) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  if (parent !== undefined) parent.appendChild(node);
  return node;
}

/**
 * 在 root 内构建联网对局骨架：先复用 mountLayout 保证单人体验不变，
 * 再在 .playfield 网格尾部追加对手棋盘面板与排行榜面板（桌面第 4/5 列；
 * 移动端经 CSS 重排为顶部缩略条 + 可折叠区）。root 加 `mp-mode` 类，
 * 使双棋盘样式只作用于联网装配，单人 CSS 零影响。
 */
export function mountMultiplayerLayout(root: HTMLElement): MultiplayerLayoutRefs {
  const refs = mountLayout(root);
  root.classList.add('mp-mode');

  const playfield = root.querySelector('main.playfield');
  if (playfield === null) {
    throw new Error('mountLayout 未生成 .playfield（联网布局前置缺失）');
  }

  // ── 对手棋盘面板：信息行 + 第二 Canvas ──────────────────────────────────
  const opponentPanel = el('section', {
    className: 'panel panel-opponent', attrs: { 'aria-label': '对手棋盘' }, parent: playfield as HTMLElement,
  });
  el('h2', { className: 'panel-title', text: '对手棋盘', parent: opponentPanel });
  const opponentName = el('div', {
    className: 'opponent-name', id: 'opponent-name', text: '等待对手…',
    attrs: { 'aria-live': 'polite' }, parent: opponentPanel,
  });
  const opponentMeta = el('div', { className: 'opponent-meta', parent: opponentPanel });
  const opponentScore = el('span', { className: 'opponent-stat', id: 'opponent-score', text: '分数 0', parent: opponentMeta });
  const opponentLines = el('span', { className: 'opponent-stat', id: 'opponent-lines', text: '消行 0', parent: opponentMeta });
  const opponentStatus = el('span', { className: 'opponent-stat', id: 'opponent-status', text: '等待中', parent: opponentMeta });
  const opponentCanvas = el('canvas', {
    className: 'opponent-canvas', id: 'opponent-canvas', parent: opponentPanel,
    attrs: { width: '180', height: '360', 'aria-label': '对手棋盘快照，10 列 20 行', role: 'img' },
  });

  // ── 排行榜面板：原生 details 折叠（移动端默认收起、一键展开全部玩家） ────
  const leaderboardPanel = el('section', {
    className: 'panel panel-leaderboard', attrs: { 'aria-label': '全员排行榜' }, parent: playfield as HTMLElement,
  });
  const details = el('details', { className: 'leaderboard-details', attrs: { open: '' }, parent: leaderboardPanel });
  // 手机断点默认折叠排行榜（方案 §6.1「可折叠但全员可即时查看」）：
  // 首屏优先让位给本人游戏区与触屏按键，点 summary 即展开全部玩家。
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767.98px)').matches) {
    details.removeAttribute('open');
  }
  el('summary', { className: 'leaderboard-summary', text: '排行榜', parent: details });
  const leaderboardSlot = el('div', {
    className: 'leaderboard-slot', id: 'leaderboard-slot',
    attrs: { 'aria-live': 'polite' }, parent: details,
  });

  return {
    ...refs,
    opponentPanel, opponentCanvas, opponentName, opponentScore, opponentLines, opponentStatus,
    leaderboardSlot,
  };
}
