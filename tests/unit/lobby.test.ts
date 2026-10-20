/**
 * N33 等待大厅测试：纯助手（权限/门槛/表单预校验/阶段文案）+ 装配结构断言
 * （node 环境，无 DOM）。真实大厅交互由 tests/e2e/mp-lobby.spec.ts 覆盖。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlayerView } from '../../shared/protocol';
import {
  canEditRoom,
  canStartMatch,
  copyCodeMessage,
  phaseLabel,
  validateSettingsForm,
} from '../../src/ui/lobby';

const SRC = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

function view(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: 'p_aaaaaaaaaaaa',
    nickname: 'host1',
    seatIndex: 1,
    isHost: true,
    ready: true,
    status: 'ready',
    score: 0,
    lines: 0,
    level: 1,
    ...overrides,
  };
}

describe('N33 大厅权限与开局门槛（与服务端裁决同源）', () => {
  it('正向：房主 + LOBBY 可编辑；开局需全员准备且 ≥2 人', () => {
    expect(canEditRoom(true, 'LOBBY')).toBe(true);
    expect(canStartMatch(true, 'LOBBY', [view(), view({ playerId: 'p_b', nickname: 'g2', isHost: false })])).toBe(true);
  });

  it('反向：非房主/非 LOBBY 不可编辑；人数不足、未全准备、非房主不可开局', () => {
    expect(canEditRoom(false, 'LOBBY')).toBe(false);
    for (const phase of ['COUNTDOWN', 'RUNNING', 'FINISHED'] as const) {
      expect(canEditRoom(true, phase)).toBe(false);
      expect(canStartMatch(true, phase, [view(), view({ playerId: 'p_b' })])).toBe(false);
    }
    expect(canStartMatch(true, 'LOBBY', [view()])).toBe(false); // 仅 1 人
    expect(canStartMatch(true, 'LOBBY', [view(), view({ playerId: 'p_b', ready: false })])).toBe(false);
    expect(canStartMatch(false, 'LOBBY', [view(), view({ playerId: 'p_b' })])).toBe(false);
  });
});

describe('N33 房主设置表单本地预校验（服务端为最终权威）', () => {
  it('正向：S1/S2 忽略种子；S3 需合法种子并随值下发', () => {
    const a = validateSettingsForm({ capacity: 2, randomMode: 'S1', customSeed: 'ignored', startLevel: 10 });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.value).toEqual({ capacity: 2, randomMode: 'S1', startLevel: 10 });
    const b = validateSettingsForm({ capacity: 6, randomMode: 'S3', customSeed: 'abc123', startLevel: 1 });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.customSeed).toBe('abc123');
  });

  it('反向：人数越界/等级越界/S3 空种子或超长种子 ⇒ 中文提示', () => {
    for (const cap of [1, 7, 2.5, Number.NaN]) {
      const bad = validateSettingsForm({ capacity: cap, randomMode: 'S1', customSeed: '', startLevel: 1 });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.field).toBe('capacity');
        expect(bad.message).toBe('房间人数需为 2–6 人。');
      }
    }
    const lvl = validateSettingsForm({ capacity: 4, randomMode: 'S2', customSeed: '', startLevel: 11 });
    expect(!lvl.ok && lvl.message).toBe('初始等级需为 1–10。');
    const seed = validateSettingsForm({ capacity: 4, randomMode: 'S3', customSeed: '种子', startLevel: 1 });
    expect(seed.ok).toBe(false);
    if (!seed.ok) {
      expect(seed.field).toBe('customSeed');
      expect(seed.message).toBe('自定义种子需为 1–32 位英文字母或数字。');
    }
    const long = validateSettingsForm({ capacity: 4, randomMode: 'S3', customSeed: 'a'.repeat(33), startLevel: 1 });
    expect(long.ok).toBe(false);
  });
});

describe('N33 阶段文案与复制文案', () => {
  it('正向：四阶段中文文案；COUNTDOWN 附剩余秒数（不为负）', () => {
    expect(phaseLabel('LOBBY', null, 1000)).toBe('等待大厅');
    expect(phaseLabel('COUNTDOWN', 4000, 1000)).toBe('即将开始（约 3 秒）');
    expect(phaseLabel('COUNTDOWN', 0, 5000)).toBe('即将开始（约 0 秒）');
    expect(phaseLabel('RUNNING', null, 0)).toBe('比赛进行中');
    expect(phaseLabel('FINISHED', null, 0)).toBe('本局已结束');
  });

  it('正向：复制提示含 6 位房间码', () => {
    expect(copyCodeMessage('246810')).toContain('246810');
  });
});

describe('N33 大厅装配结构（纯 DOM、无网络；接线经 NetClient）', () => {
  it('正向：lobby.ts 无 fetch/WebSocket/NetClient；中文控件齐备', () => {
    const lobby = SRC('ui/lobby.ts');
    expect(lobby).not.toMatch(/\b(fetch|WebSocket|NetClient)\b/);
    for (const label of [
      '房间码', '复制房间码', '玩家席位', '房主', '连接中断', '已准备', '未准备',
      '房间人数', '随机模式', '自定义种子', '初始等级', '应用设置',
      '准备', '开始对局', '离开房间', '离开将把房主转交给下一位玩家',
    ]) {
      expect(lobby).toContain(label);
    }
  });

  it('正向：multiplayer.ts 接线——room_state 驱动大厅、动作经 client.send、teardown 清理', () => {
    const mp = SRC('app/multiplayer.ts');
    expect(mp).toMatch(/from\s+['"]\.\.\/ui\/lobby['"]/);
    expect(mp).toMatch(/case 'room_state':[\s\S]{0,80}lobby\?\.update\(msg\)/);
    for (const t of ["type: 'ready'", "type: 'start'", "type: 'leave'", "type: 'settings_update'"]) {
      expect(mp).toContain(t);
    }
    expect(mp).toMatch(/case 'error':[\s\S]{0,80}lobby\?\.showMessage\('error', msg\.message\)/);
    expect(mp).toMatch(/client\.close\(\)/);
    expect(mp).toMatch(/lobby\?\.destroy\(\)/);
  });
});
