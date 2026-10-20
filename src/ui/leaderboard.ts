// Neon Blocks — 全员统一排行榜组件（方案 §5，任务 N37）。
// 只渲染服务端 `scoreboard` 广播的同一份榜单（LeaderboardEntry[]，同 revision
// 全员一致）：客户端**不排序、不计算名次**——名单/顺序/分数/名次逐行照抄，
// 不同客户端仅本人高亮不同。已淘汰者留在榜上分数固定；断线显示「连接中断」。
// 生存赛胜者（match_end winners）在榜单上方独立标识，与「得分第一」语义分离，
// 且标识不改变榜单行序（终局仍按得分排）。纯 DOM，无网络代码。

import type { LeaderboardEntry, PlayerStatus } from '../../shared/protocol';

/** 玩家状态的中文标签（服务端 status → 文案；未知值兜底「—」）。 */
export function statusLabel(status: PlayerStatus): string {
  switch (status) {
    case 'lobby': return '等待中';
    case 'ready': return '已准备';
    case 'playing': return '比赛中';
    case 'disconnected': return '连接中断';
    case 'eliminated': return '已淘汰';
    case 'finished': return '已结束';
    default: return '—';
  }
}

/** 榜单行视图：逐行照抄服务端顺序，仅附加本人/胜者的显示标记。 */
export interface LeaderboardRowView {
  playerId: string;
  nickname: string;
  score: number;
  lines: number;
  rank: number;
  statusLabel: string;
  isSelf: boolean;
  isWinner: boolean;
}

/**
 * 由服务端 entries 构建行视图：**保持输入顺序**（服务端权威排序，客户端
 * 禁止重排——含终局后与胜者标识时）；selfId 仅标记高亮行；winnerIds 仅标记
 * 胜者行（可空）。未知 winnerId 忽略（不影响任何行）。
 */
export function buildRows(
  entries: readonly LeaderboardEntry[],
  selfId: string | null,
  winnerIds: readonly string[] = [],
): LeaderboardRowView[] {
  const winners = new Set(winnerIds);
  return entries.map((entry) => ({
    playerId: entry.playerId,
    nickname: entry.nickname,
    score: entry.score,
    lines: entry.lines,
    rank: entry.rank,
    statusLabel: statusLabel(entry.status),
    isSelf: selfId !== null && entry.playerId === selfId,
    isWinner: winners.has(entry.playerId),
  }));
}

/**
 * 胜者独立标识文案（榜单上方，与名次无关）：按服务端榜单顺序取昵称，
 * 保证不同客户端文案完全一致；无胜者返回空串。
 */
export function winnersSummary(
  entries: readonly LeaderboardEntry[],
  winnerIds: readonly string[],
): string {
  if (winnerIds.length === 0) return '';
  const winners = new Set(winnerIds);
  const names = entries.filter((entry) => winners.has(entry.playerId)).map((entry) => entry.nickname);
  return names.length === 0 ? '' : `本局胜者：${names.join('、')}`;
}

export interface LeaderboardView {
  /** 渲染/刷新服务端榜单（selfId 仅高亮本人行）。 */
  update(entries: readonly LeaderboardEntry[], selfId: string | null): void;
  /** 终局胜者独立标识（match_end winners；不改变榜单行序）。 */
  markWinners(winnerIds: readonly string[]): void;
  /** 清空（离开房间/新一局装配时）。 */
  clear(): void;
}

function cell(tag: 'th' | 'td', text: string, parent: HTMLElement, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== undefined) node.className = className;
  parent.appendChild(node);
  return node;
}

/**
 * 在 slot 内创建排行榜视图：胜者横幅 + 名次/玩家/分数/消行/状态五列表格。
 * 每次 update 全量重建 tbody（榜单 ≤6 行，简单可靠）；不排序、不算名次。
 */
export function createLeaderboardView(slot: HTMLElement): LeaderboardView {
  let lastEntries: readonly LeaderboardEntry[] = [];
  let lastSelfId: string | null = null;
  let lastWinnerIds: readonly string[] = [];

  const banner = document.createElement('div');
  banner.className = 'lb-winners';
  banner.setAttribute('aria-live', 'polite');
  banner.hidden = true;
  slot.appendChild(banner);

  const table = document.createElement('table');
  table.className = 'lb-table';
  const headRow = document.createElement('tr');
  for (const title of ['名次', '玩家', '分数', '消行', '状态']) cell('th', title, headRow);
  const thead = document.createElement('thead');
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  slot.appendChild(table);

  const render = (): void => {
    banner.textContent = winnersSummary(lastEntries, lastWinnerIds);
    banner.hidden = lastWinnerIds.length === 0 || banner.textContent === '';
    tbody.replaceChildren();
    for (const row of buildRows(lastEntries, lastSelfId, lastWinnerIds)) {
      const tr = document.createElement('tr');
      if (row.isSelf) {
        tr.className = 'lb-self';
        tr.setAttribute('aria-current', 'true');
      }
      if (row.isWinner) tr.classList.add('lb-winner');
      cell('td', String(row.rank), tr, 'lb-rank');
      cell('td', row.nickname, tr, 'lb-name');
      cell('td', String(row.score), tr, 'lb-score');
      cell('td', String(row.lines), tr, 'lb-lines');
      cell('td', row.statusLabel, tr, 'lb-status');
      tbody.appendChild(tr);
    }
  };

  return {
    update(entries, selfId) {
      // 复制保存（复审 N37 O-2）：调用方复用/改写数组不影响后续重渲染。
      lastEntries = [...entries];
      lastSelfId = selfId;
      render();
    },
    markWinners(winnerIds) {
      lastWinnerIds = winnerIds;
      render();
    },
    clear() {
      lastEntries = [];
      lastSelfId = null;
      lastWinnerIds = [];
      render();
    },
  };
}
