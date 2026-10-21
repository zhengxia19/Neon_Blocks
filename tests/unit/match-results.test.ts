/**
 * N39-b：对局结果与倒计时组件——纯函数（剩余时间格式化/终局原因/胜负文案）
 * 与装配结构断言（600 秒展示、房主专属下一局、对局期 LOBBY 拆局重建大厅）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MATCH_DURATION_MS, type EndReason } from '../../shared/protocol';
import { endReasonLabel, formatRemaining, winnersText } from '../../src/ui/match-results';

const SRC = {
  results: readFileSync(join(process.cwd(), 'src', 'ui', 'match-results.ts'), 'utf8'),
  match: readFileSync(join(process.cwd(), 'src', 'app', 'match.ts'), 'utf8'),
  multiplayer: readFileSync(join(process.cwd(), 'src', 'app', 'multiplayer.ts'), 'utf8'),
  css: readFileSync(join(process.cwd(), 'src', 'styles', 'multiplayer.css'), 'utf8'),
};

describe('N39-b 剩余时间格式化', () => {
  it('正向：600 秒整局显示 10:00，逐秒递减格式 mm:ss', () => {
    expect(formatRemaining(MATCH_DURATION_MS)).toBe('10:00');
    expect(formatRemaining(599_999)).toBe('09:59');
    expect(formatRemaining(61_500)).toBe('01:01');
    expect(formatRemaining(1_000)).toBe('00:01');
    expect(formatRemaining(999)).toBe('00:00');
  });

  it('反向：负值与 0 钳为 00:00（超时瞬间不显示负剩余）', () => {
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(-1)).toBe('00:00');
    expect(formatRemaining(-999_999)).toBe('00:00');
  });
});

describe('N39-b 终局原因中文标签', () => {
  it('正向：survival/timeout/abandoned 三种原因均有独立文案', () => {
    expect(endReasonLabel('survival')).toBe('比赛结束');
    expect(endReasonLabel('timeout')).toBe('时间到');
    expect(endReasonLabel('abandoned')).toBe('比赛结束（房间解散）');
  });

  it('反向：未知原因兜底「比赛结束」，不显示英文枚举', () => {
    expect(endReasonLabel('weird' as EndReason)).toBe('比赛结束');
  });
});

describe('N39-b 胜负独立文案（与得分第一语义分离）', () => {
  it('正向：单人胜者/多人并列/无胜者三种文案', () => {
    expect(winnersText(['小明'])).toBe('胜者：小明');
    expect(winnersText(['小明', '小红'])).toBe('并列胜者：小明、小红');
    expect(winnersText([])).toBe('本局无胜者');
  });
});

describe('N39-b 装配结构断言', () => {
  it('正向：match.ts 状态行逐秒展示剩余、本人淘汰由服务端榜单驱动、match_end 全量消费', () => {
    expect(SRC.match).toContain('剩余 ${formatRemaining(match.deadlineAt - (wallNow() + clockOffset))}');
    expect(SRC.match).toContain("if (selfEntry?.status === 'eliminated') selfEliminated = true;");
    expect(SRC.match).toContain('你已淘汰，等待比赛结束');
    expect(SRC.match).toContain('applyMatchEnd(msg: MatchEndMsg): void');
    expect(SRC.match).toContain('results.show({ reasonLabel, winnersText: winnersText(names), isHost: ui.isHost() });');
    // 复审 P2-1：终局冻结本地棋盘（不步进、不推进节奏）并卸载输入。
    expect(SRC.match).toContain('if (!frozen && !ended) engine.step(dtMs);');
    expect(SRC.match).toMatch(/releaseInputs\(\);\s*keyboard\.dispose\(\);\s*touch\.dispose\(\);/);
    // 胜者昵称按服务端榜单顺序提取（全员文案一致），不本地排序。
    expect(SRC.match).toContain('.filter((entry) => winnerSet.has(entry.playerId))');
    expect(SRC.match).toContain('results.destroy();');
  });

  it('正向：multiplayer 对局期收到 LOBBY 即拆局重建大厅；下一局走 start（§7.2 白名单零改动）', () => {
    expect(SRC.multiplayer).toContain("if (match !== null && msg.phase === 'LOBBY') {");
    expect(SRC.multiplayer).toMatch(/stopSnapshotPublishing\(\);\s*match\.destroy\(\);\s*match = null;/);
    expect(SRC.multiplayer).toContain('lobby = renderLobby(root, myPlayerId, lobbyHandlers);');
    // 复审 P2-2：isHost 为 getter（match_end 时刻读实时转让后的房主）。
    expect(SRC.multiplayer).toContain('isHost: (): boolean => myIsHost,');
    expect(SRC.multiplayer).toMatch(/onNextRound: \(\): void => \{\s*client\.send\(\{ v: PROTOCOL_VERSION, type: 'start' \}\);/);
    // 复审 P2-1：match_end 即停快照上行（不等 LOBBY 拆局）。
    expect(SRC.multiplayer).toMatch(/stopSnapshotPublishing\(\);\s*match\?\.applyMatchEnd\(msg\);/);
    expect(SRC.multiplayer).toContain('match?.applyMatchEnd(msg);');
  });

  it('反向：结果组件无网络/无时钟/无 innerHTML（纯 DOM + 纯函数）', () => {
    expect(SRC.results).not.toMatch(/fetch\(|WebSocket|NetClient/);
    expect(SRC.results).not.toMatch(/Date\.now|Math\.random|setInterval|setTimeout/);
    expect(SRC.results).not.toContain('innerHTML');
    // 房主专属按钮 id 固定（E2E 断言锚点）。
    expect(SRC.results).toContain("nextButton.id = 'mp-next-round'");
  });

  it('反向：C→S 白名单未新增消息类型（下一局承载于 start，§7.2 封闭契约）', () => {
    const proto = readFileSync(join(process.cwd(), 'shared', 'protocol.ts'), 'utf8');
    expect(proto).not.toContain('next_round');
  });

  it('正向：结果面板 CSS 重新开启 pointer-events（overlay-root 全局 none，按钮必须可点）', () => {
    // E2E 首跑教训：.overlay-root{pointer-events:none} 下按钮点击被拦截超时。
    expect(SRC.css).toMatch(/#mp-results \{[^}]*pointer-events: auto;/);
    // E2E 二跑教训：display:flex 覆盖 [hidden] 的 UA display:none，必须显式恢复。
    expect(SRC.css).toContain('#mp-results[hidden] {');
    expect(SRC.css).toMatch(/#mp-results\[hidden\] \{\s*display: none;/);
  });
});
