// N19：生存赛最终名次（方案 §1.6/§1.7/§1.8）。与对局中「积分榜」（N27 房间统一
// 榜单）**完全独立**：本模块生存者优先、已淘汰按淘汰时间排序；两套排序结果绝不
// 互相复用。纯函数、无副作用、确定性（并列显式表达，不凭玩家 ID 暗判胜负）。
import type { StandingEntry } from '../../shared/protocol';

/** 终局排序输入（N25 接线后由服务端接收的快照成绩与淘汰时间构成）。 */
export interface RankInput {
  playerId: string;
  nickname: string;
  /** 加入顺序（仅稳定显示顺序用，不影响并列判定）。 */
  joinOrder: number;
  /** null = 存活到终局；否则为服务端接受的淘汰时刻。 */
  eliminatedAt: number | null;
  score: number;
  lines: number;
}

export interface FinalRanking {
  /** 排序后的终局名次表：存活者在前（placement 1 起，并列共享），已淘汰者按淘汰时间其后（placement=null）。 */
  standings: StandingEntry[];
  /** 胜者（独立表示，不依赖 standings 的排序位置）：并列第一可多人。 */
  winners: string[];
}

/** 终局名次比较：存活者优先 → 存活者分数/消行降序 → 已淘汰者淘汰时刻降序再分数/消行 → 加入顺序升序（仅显示）。 */
function compareForStandings(a: RankInput, b: RankInput): number {
  const aAlive = a.eliminatedAt === null ? 0 : 1;
  const bAlive = b.eliminatedAt === null ? 0 : 1;
  if (aAlive !== bAlive) return aAlive - bAlive;
  if (aAlive === 0) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.lines !== b.lines) return b.lines - a.lines;
  } else {
    const at = (x: RankInput) => x.eliminatedAt as number;
    if (at(a) !== at(b)) return at(b) - at(a);
    if (a.score !== b.score) return b.score - a.score;
    if (a.lines !== b.lines) return b.lines - a.lines;
  }
  return a.joinOrder - b.joinOrder;
}

/** 名次键是否完全一致（并列判定；显示顺序键不参与）。 */
function sameRankKey(a: RankInput, b: RankInput): boolean {
  if ((a.eliminatedAt === null) !== (b.eliminatedAt === null)) return false;
  if (a.eliminatedAt === null) return a.score === b.score && a.lines === b.lines;
  return a.eliminatedAt === b.eliminatedAt && a.score === b.score && a.lines === b.lines;
}

/**
 * 计算生存赛最终名次。规则（方案 §1.6～§1.8）：
 * - 存活者优先于任何已淘汰者（**已死高分不夺冠**）；
 * - 存活者间：分数降序 → 消行数降序；完全相同 → 并列第一（显式并列）；
 * - 已淘汰者间：淘汰时刻降序（存活越久越靠前）→ 分数降序 → 消行数降序；
 * - 胜者独立：有存活者 → 并列第一的存活者；零存活（极端同时淘汰）→
 *   最晚淘汰时刻组内按分数/消行判定，完全同条件并列；
 * - 名次为竞赛排名（并列共享名次，后续跳号，如 1,1,3）。
 */
export function computeFinalRanking(inputs: readonly RankInput[]): FinalRanking {
  const sorted = [...inputs].sort(compareForStandings);
  const standings: StandingEntry[] = [];
  let placement = 0;
  sorted.forEach((p, index) => {
    const tied = index > 0 && sameRankKey(sorted[index - 1], p);
    if (!tied) placement = index + 1; // 竞赛排名：并列共享名次、后续跳号（1,1,3）
    standings.push({
      playerId: p.playerId,
      nickname: p.nickname,
      score: p.score,
      lines: p.lines,
      placement: p.eliminatedAt === null ? placement : null,
      eliminatedAt: p.eliminatedAt,
    });
  });
  const survivors = sorted.filter((p) => p.eliminatedAt === null);
  const pool = survivors.length > 0 ? survivors : sorted;
  const winners =
    pool.length === 0 ? [] : pool.filter((p) => sameRankKey(pool[0], p)).map((p) => p.playerId);
  return { standings, winners };
}
