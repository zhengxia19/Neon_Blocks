// N29：自动观战目标纯函数（方案 §6.2 精确定义，A10）。
// 候选=本局全部参赛者排除自己（含已淘汰者，其分数冻结仍参与比较）；
// 1) 选 score 严格高于本人者中分数最低者（「刚好更高」），同分按消行数降序、
//    加入顺序升序稳定选择；2) 无更高者（本人独占/并列最高）→ 其他玩家中分数
//    最低者，最低分并列按消行数升序、加入顺序升序稳定选择；3) 永不选自己。
// 纯函数：无时间/随机/网络依赖，输入顺序无关（joinOrder 唯一保证全序确定）。

export interface WatchCandidate {
  playerId: string;
  score: number;
  lines: number;
  joinOrder: number;
}

/**
 * 计算 viewerId 的自动观战目标。
 * @param viewerId 观看者（须在 candidates 内，否则返回 null）
 * @param candidates 本局冻结名单全体（含淘汰者）；不会被修改。
 * @returns 目标 playerId；无其他参赛者/观看者不在名单 → null。
 */
export function pickWatchTarget(
  viewerId: string,
  candidates: readonly WatchCandidate[],
): string | null {
  const me = candidates.find((c) => c.playerId === viewerId);
  if (me === undefined) return null;
  const others = candidates.filter((c) => c.playerId !== viewerId);
  if (others.length === 0) return null;
  // 规则 1：严格更高者中「高得最少」；同分消行数降序→加入顺序升序。
  const higher = others.filter((c) => c.score > me.score);
  if (higher.length > 0) {
    higher.sort(
      (a, b) => a.score - b.score || b.lines - a.lines || a.joinOrder - b.joinOrder,
    );
    return higher[0].playerId;
  }
  // 规则 2：本人独占/并列最高 → 其他玩家最低分；并列消行数升序→加入顺序升序。
  const lowest = others.slice().sort(
    (a, b) => a.score - b.score || a.lines - b.lines || a.joinOrder - b.joinOrder,
  );
  return lowest[0].playerId;
}
