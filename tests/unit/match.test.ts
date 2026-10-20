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
  });

  it('正向：match.ts 无网络代码；multiplayer 以 room_state.serverTime 校准并装配对局', () => {
    expect(SRC.match).not.toMatch(/fetch\(/);
    expect(SRC.match).not.toContain('WebSocket');
    expect(SRC.match).not.toContain('NetClient');
    expect(SRC.multiplayer).toContain('computeClockOffset(msg.serverTime, Date.now())');
    expect(SRC.multiplayer).toContain('bootMatch(root, msg, clockOffset)');
    expect(SRC.multiplayer).toContain('match?.destroy()');
  });

  it('正向：预倒计时遮罩由 countdown.startAt 校准墙钟驱动，match_start 前清除', () => {
    expect(SRC.multiplayer).toContain("showPreCountdown(msg.startAt)");
    expect(SRC.multiplayer).toContain("id = 'mp-pre-countdown'");
    expect(SRC.multiplayer).toContain('countdownLabel(startAt - (Date.now() + clockOffset))');
    // 装配前清除遮罩（clearPreCountdown 在 bootMatch 之前调用）。
    expect(SRC.multiplayer).toMatch(/clearPreCountdown\(\);\s*lobby\?\.destroy\(\);\s*lobby = null;\s*match = bootMatch/);
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
