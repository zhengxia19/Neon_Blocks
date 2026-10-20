// Neon Blocks — 联网对局结果与倒计时状态组件（方案 §5/§6，任务 N39-b）。
// 明确展示：600 秒剩余（服务器 deadlineAt 校准墙钟驱动，本文件只格式化不计时）、
// 终局原因、独立胜负信息（胜者/并列胜者与「得分第一」语义分离——昵称按服务端
// 榜单顺序取，全员文案一致）、房主专属「下一局」按钮（发送路径由装配层决定）。
// 纯 DOM + 纯函数，无网络代码、无时钟。

import type { EndReason } from '../../shared/protocol';

/** 剩余毫秒 → 'mm:ss'（负值钳 0；600000 → '10:00'）。 */
export function formatRemaining(ms: number): string {
  const clamped = ms < 0 ? 0 : ms;
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 终局原因中文标签（服务端 EndReason → 文案；未知值兜底「比赛结束」）。 */
export function endReasonLabel(reason: EndReason): string {
  switch (reason) {
    case 'survival': return '比赛结束';
    case 'timeout': return '时间到';
    case 'abandoned': return '比赛结束（房间解散）';
    default: return '比赛结束';
  }
}

/**
 * 胜负独立文案：昵称列表由装配层按**服务端榜单顺序**提取（全员一致）；
 * 单人 → 「胜者：X」，多人 → 「并列胜者：X、Y」，空 → 「本局无胜者」。
 */
export function winnersText(winnerNicknames: readonly string[]): string {
  if (winnerNicknames.length === 0) return '本局无胜者';
  if (winnerNicknames.length === 1) return `胜者：${winnerNicknames[0]}`;
  return `并列胜者：${winnerNicknames.join('、')}`;
}

export interface ResultsInfo {
  reasonLabel: string;
  winnersText: string;
  /** 房主才渲染「下一局」按钮（服务端仍裁决权限，UI 只是入口收敛）。 */
  isHost: boolean;
}

export interface ResultsPanel {
  /** 显示/刷新结果面板（match_end 驱动；重复调用以最后一次为准）。 */
  show(info: ResultsInfo): void;
  /** 隐藏（装配销毁时随根容器一并移除，这里只解除按钮监听）。 */
  destroy(): void;
}

/**
 * 在 root 内挂载结果面板：`#mp-results`（原因 + 胜负独立文案）与房主专属
 * `#mp-next-round` 按钮。默认隐藏，`show` 才可见。
 */
export function createResultsPanel(root: HTMLElement, handlers: { onNextRound: () => void }): ResultsPanel {
  const panel = document.createElement('div');
  panel.id = 'mp-results';
  panel.setAttribute('role', 'status');
  panel.hidden = true;

  const title = document.createElement('div');
  title.className = 'mp-results-title';
  const winners = document.createElement('div');
  winners.className = 'mp-results-winners';
  panel.appendChild(title);
  panel.appendChild(winners);

  let nextButton: HTMLButtonElement | null = null;

  root.appendChild(panel);

  return {
    show(info: ResultsInfo): void {
      title.textContent = info.reasonLabel;
      winners.textContent = info.winnersText;
      if (info.isHost && nextButton === null) {
        nextButton = document.createElement('button');
        nextButton.id = 'mp-next-round';
        nextButton.type = 'button';
        nextButton.textContent = '下一局';
        nextButton.addEventListener('click', handlers.onNextRound);
        panel.appendChild(nextButton);
      }
      if (!info.isHost && nextButton !== null) {
        nextButton.removeEventListener('click', handlers.onNextRound);
        nextButton.remove();
        nextButton = null;
      }
      panel.hidden = false;
    },
    destroy(): void {
      if (nextButton !== null) {
        nextButton.removeEventListener('click', handlers.onNextRound);
        nextButton = null;
      }
      panel.remove();
    },
  };
}
