/**
 * N34：联网本地比赛初始化与时钟——纯助手（墙钟偏差/倒计时标签/封顶 dt）
 * 与装配结构断言（种子注入、暂停禁用、服务器计时可信、单人不受影响）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CATCHUP_MS,
  clampFrameDelta,
  computeClockOffset,
  countdownLabel,
} from '../../src/app/match';

const SRC = {
  match: readFileSync(join(process.cwd(), 'src', 'app', 'match.ts'), 'utf8'),
  multiplayer: readFileSync(join(process.cwd(), 'src', 'app', 'multiplayer.ts'), 'utf8'),
  main: readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8'),
};

describe('N34 服务器墙钟偏差', () => {
  it('正向：serverTime 领先/落后本地时刻的偏差符号与量级正确', () => {
    expect(computeClockOffset(1_700_000_000_500, 1_700_000_000_000)).toBe(500);
    expect(computeClockOffset(1_700_000_000_000, 1_700_000_000_250)).toBe(-250);
    expect(computeClockOffset(1_700_000_000_000, 1_700_000_000_000)).toBe(0);
  });
});

describe('N34 倒计时标签（服务器 startAt 驱动）', () => {
  it('正向：3000/2999→3、2000→2、1000/1→1、0/负→GO', () => {
    expect(countdownLabel(3000)).toBe('3');
    expect(countdownLabel(2999)).toBe('3');
    expect(countdownLabel(2000)).toBe('2');
    expect(countdownLabel(1001)).toBe('2');
    expect(countdownLabel(1000)).toBe('1');
    expect(countdownLabel(1)).toBe('1');
    expect(countdownLabel(0)).toBe('GO');
    expect(countdownLabel(-4200)).toBe('GO');
  });
});

describe('N34 后台冻结防护：单帧 dt 封顶', () => {
  it('正向：正常帧原样、负值归零、5000ms 积压截断为 250', () => {
    expect(clampFrameDelta(16.7)).toBeCloseTo(16.7);
    expect(clampFrameDelta(0)).toBe(0);
    expect(clampFrameDelta(-10)).toBe(0);
    expect(clampFrameDelta(5000)).toBe(MAX_CATCHUP_MS);
    expect(MAX_CATCHUP_MS).toBe(250);
  });
});

describe('N34 装配结构断言', () => {
  it('正向：match.ts 注入服务器种子与等级、以校准墙钟判定开局', () => {
    expect(SRC.match).toContain('createSeededRng(match.seatSeed)');
    expect(SRC.match).toContain('match.startLevel');
    expect(SRC.match).toContain('wallNow() + clockOffset >= match.startAt');
  });

  it('正向：联网装配从不触发个人暂停/重开', () => {
    expect(SRC.match).not.toMatch(/\.togglePause\(/);
    expect(SRC.match).not.toMatch(/\.restart\(/);
    expect(SRC.match).toContain('refs.pauseButton.disabled = true');
    // N36：触屏按键装配 + 长按节奏每帧推进（与单人主循环同构）。
    expect(SRC.match).toContain('createTouchControls(refs.touchControls');
    expect(SRC.match).toContain('keyboard.update(dtMs)');
    expect(SRC.match).toContain('touchRepeat.update(dtMs)');
  });

  it('正向：match.ts 无网络代码；multiplayer 以 room_state.serverTime 校准并装配对局', () => {
    expect(SRC.match).not.toMatch(/fetch\(/);
    expect(SRC.match).not.toContain('WebSocket');
    expect(SRC.match).not.toContain('NetClient');
    expect(SRC.multiplayer).toContain('computeClockOffset(msg.serverTime, Date.now())');
    expect(SRC.multiplayer).toContain('bootMatch(root, msg, clockOffset, myPlayerId, {}, matchUi);');
    expect(SRC.multiplayer).toContain('match?.destroy()');
  });

  it('正向：N38 双棋盘与排行榜连接（match 消费、multiplayer 转发）', () => {
    // match.ts：远程棋盘挂对手 Canvas、排行榜视图填槽、切换即复位水位、resize 透传。
    expect(SRC.match).toContain('new RemoteBoard(refs.opponentCanvas)');
    expect(SRC.match).toContain('createLeaderboardView(refs.leaderboardSlot)');
    expect(SRC.match).toContain('remoteBoard.resetForTarget()');
    expect(SRC.match).toContain('remoteBoard.resize()');
    expect(SRC.match).toContain('leaderboardView.markWinners(');
    // 陈旧目标帧丢弃：只绘制当前观察目标（N40-a 复审 P1 后为 else-if 分支）。
    expect(SRC.match).toContain('} else if (targetPlayerId !== watchTargetId) {');
    // multiplayer：四类对局消息接线 + 快照发布 + gameover 单发。
    expect(SRC.multiplayer).toContain("case 'scoreboard':");
    expect(SRC.multiplayer).toContain("case 'watch_target':");
    expect(SRC.multiplayer).toContain("case 'remote_snapshot':");
    expect(SRC.multiplayer).toContain("case 'match_end':");
    expect(SRC.multiplayer).toContain('new SnapshotPublisher(');
    expect(SRC.multiplayer).toContain("type: 'snapshot'");
    expect(SRC.multiplayer).toContain("type: 'gameover'");
    // 发布通道与连接态联动（断开丢弃、重连恢复）。
    expect(SRC.multiplayer).toContain('publisher?.setConnected(true)');
    expect(SRC.multiplayer).toContain('publisher?.setConnected(false)');
  });

  it('正向：复审 N38 P2 修复钉死——淘汰冻结延迟到目标首帧、gameover 成功才置位', () => {
    // P2-1：状态驱动冻结/遮罩仅在当前目标已有帧后生效（resetForTarget 复位水位
    // -1；lastSeq<0 直接返回，补帧到达后 applyRemoteSnapshot 再同步面板冻结）。
    expect(SRC.match).toContain('if (remoteBoard.state.lastSeq < 0) return;');
    expect(SRC.match).toContain('if (drawn) syncOpponentPanel();');
    // 冻结/遮罩仍由榜单状态驱动（同源，不本地另算）。
    expect(SRC.match).toContain("if (entry.status === 'eliminated') remoteBoard.freeze();");
    expect(SRC.match).toContain("else if (entry.status === 'disconnected') remoteBoard.setDisconnected();");
    // P2-2：gameover 上报 send 成功才置 gameoverSent（断线下一 tick 重试）。
    expect(SRC.multiplayer).toMatch(
      /if \(client\.send\(\{ v: PROTOCOL_VERSION, type: 'gameover', reason: 'topout' \}\)\) \{\s*gameoverSent = true;/,
    );
  });

  it('反向：N38 后 match.ts 仍无网络代码；单人包不含发布器', () => {
    expect(SRC.match).not.toMatch(/fetch\(/);
    expect(SRC.match).not.toContain('WebSocket');
    expect(SRC.match).not.toContain('NetClient');
    expect(SRC.match).not.toContain('SnapshotPublisher');
    expect(SRC.match).not.toContain('decodeSnapshot');
    // snapshot-source 纯函数：无网络、无 DOM、无时钟。
    const srcSnap = readFileSync(join(process.cwd(), 'src', 'app', 'snapshot-source.ts'), 'utf8');
    expect(srcSnap).not.toMatch(/fetch\(|WebSocket|NetClient/);
    expect(srcSnap).not.toMatch(/document\.|window\.|Date\.now|Math\.random/);
  });

  it('正向：预倒计时遮罩由 countdown.startAt 校准墙钟驱动，match_start 前清除', () => {
    expect(SRC.multiplayer).toContain("showPreCountdown(msg.startAt)");
    expect(SRC.multiplayer).toContain("id = 'mp-pre-countdown'");
    expect(SRC.multiplayer).toContain('countdownLabel(startAt - (Date.now() + clockOffset))');
    // 装配前清除遮罩（clearPreCountdown 在 bootMatch 之前调用；N40 起中间多一步缓存写入）。
    expect(SRC.multiplayer).toMatch(
      /clearPreCountdown\(\);\s*lobby\?\.destroy\(\);\s*lobby = null;[\s\S]*?writeCache\(MATCH_CACHE_KEY, msg\);\s*match = bootMatch/,
    );
  });

  it('正向：main.ts 暴露联网只读句柄且动态 import 失败有回退（N32 O-7）', () => {
    expect(SRC.main).toContain('window.__NEON_BLOCKS_MP__ = mpHandle');
    expect(SRC.main).toMatch(/import\('\.\/app\/multiplayer'\)\s*\n?\s*\.then\([\s\S]*?\.catch\(/);
  });

  it('反向：单人主循环未被联网装配触碰（main.ts 单人分支仍走 boot()，engine.ts 构造未改签名）', () => {
    expect(SRC.main).toContain("handle = boot(appRoot);");
    const engineSrc = readFileSync(join(process.cwd(), 'src', 'game', 'engine.ts'), 'utf8');
    expect(engineSrc).toContain('constructor(rng: () => number = Math.random, initialBoard?: Board, startLevel = 1)');
  });
});
