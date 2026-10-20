// N27：房间统一积分排行榜纯函数（方案 §5）。与生存赛最终名次（N19 ranking.ts）
// **完全独立**：本模块是得分降序的房间共享榜单，存活/淘汰一律同列；两套排序
// 结果绝不互相复用。纯函数、无 IO/Date/random，且**无观看者身份参数**——
// 同一输入恒得同一份榜单，不可能因某客户端的名字或观察目标而重排。
import type { LeaderboardEntry, PlayerStatus } from '../../shared/protocol';

/** 榜单输入行：joinOrder 为 startGame 冻结的加入序号（唯一，全序最后决胜键）。 */
export interface LeaderboardRow {
  playerId: string;
  nickname: string;
  score: number;
  lines: number;
  joinOrder: number;
  status: PlayerStatus;
}

/**
 * 显示顺序全序键：分数降序 → 消行数降序 → 加入顺序升序。
 * joinOrder 每席位唯一 ⇒ 任意两人比较结果确定，与输入数组顺序无关。
 */
function compareForDisplay(a: LeaderboardRow, b: LeaderboardRow): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.lines !== b.lines) return b.lines - a.lines;
  return a.joinOrder - b.joinOrder;
}

/**
 * 构建房间统一榜单（全员同一份）。规则（方案 §5）：
 * - 全员（含已淘汰/断线者）一律先按分数降序；死人留在榜上、分数固定；
 * - 分数相同显示**并列得分名次**（竞赛排名：并列共享、后续跳号，如 1,1,3）；
 *   消行数降序 → 加入顺序升序仅稳定显示顺序，不影响并列名次；
 * - 玩家本人仅视觉高亮属客户端职责，本函数无观看者参数，榜单顺序与谁查看无关；
 * - 胜者不在榜单内标记：得分第一不一定是本局获胜者（生存赛胜者由 N19
 *   computeFinalRanking 的 winners 独立表达），此处仅提供得分领先者集合
 *   （topScorePlayerIds）供 UI 另行突出显示。
 */
export function buildLeaderboard(rows: readonly LeaderboardRow[]): LeaderboardEntry[] {
  const sorted = [...rows].sort(compareForDisplay);
  const entries: LeaderboardEntry[] = [];
  let prevScore: number | null = null;
  let prevRank = 0;
  sorted.forEach((row, index) => {
    // 并列判定只看分数（消行/加入序不参与并列，方案 §5 明确）。
    const rank = prevScore !== null && row.score === prevScore ? prevRank : index + 1;
    prevScore = row.score;
    prevRank = rank;
    entries.push({
      playerId: row.playerId,
      nickname: row.nickname,
      score: row.score,
      lines: row.lines,
      rank,
      status: row.status,
    });
  });
  return entries;
}

/**
 * 得分领先者（可并列多人）：供 UI 在榜单外独立标记「得分第一」，与生存赛
 * 胜者（N19 winners）语义分离。顺序无关（复审 O1：不依赖输入已降序前提）。
 * 空输入 → 空数组。
 */
export function topScorePlayerIds(entries: readonly LeaderboardEntry[]): string[] {
  if (entries.length === 0) return [];
  const top = Math.max(...entries.map((e) => e.score));
  return entries.filter((e) => e.score === top).map((e) => e.playerId);
}
