/**
 * N32 模式入口与创建/加入 UI 测试：纯校验助手 + 装配结构断言（node 环境，无 DOM）。
 * DOM 行为与移动端触控尺寸由 tests/e2e/mp-entry.spec.ts 钉死。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateEntryInputs,
  validateNicknameInput,
} from '../../src/ui/mp-entry';

const SRC = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('N32 入口本地预校验（服务端为最终权威）', () => {
  it('正向：合法昵称 + 边界房间码（100000/999999）通过并 trim', () => {
    const v = validateEntryInputs(' alice ', ' 100000 ');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.nickname).toBe('alice');
      expect(v.roomCode).toBe('100000');
    }
    const v2 = validateEntryInputs('Bob99', '999999');
    expect(v2.ok).toBe(true);
  });

  it('反向：中文昵称/超长昵称 ⇒ 中文提示（与服务端 NICKNAME_PATTERN 同源）', () => {
    const bad = validateEntryInputs('你好', '123456');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.field).toBe('nickname');
      expect(bad.message).toBe('昵称需为 1–16 位英文字母或数字。');
    }
    const long = validateEntryInputs('a'.repeat(17), '123456');
    expect(long.ok).toBe(false);
    const empty = validateEntryInputs('   ', '123456');
    expect(empty.ok).toBe(false);
  });

  it('反向：房间码 5 位/7 位/低于 100000 ⇒ 中文提示', () => {
    for (const code of ['12345', '1234567', '012345', 'abcdef']) {
      const bad = validateEntryInputs('alice', code);
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.field).toBe('roomCode');
        expect(bad.message).toBe('房间码需为 100000–999999 的 6 位数字。');
      }
    }
  });

  it('正向/反向：validateNicknameInput（创建路径无房间码）', () => {
    expect(validateNicknameInput('player01')).toBeNull();
    const bad = validateNicknameInput('玩家');
    expect(bad).not.toBeNull();
    expect(bad?.message).toBe('昵称需为 1–16 位英文字母或数字。');
  });
});

describe('N32 装配结构（分流条仅配置 API 时渲染；面板无网络依赖、无登录）', () => {
  it('正向：main.ts 静态导入 renderModeSwitch 且仅在 configuredApiUrl 非空时渲染', () => {
    const main = SRC('main.ts');
    expect(main).toMatch(/from\s+['"]\.\/ui\/mp-entry['"]/);
    expect(main).toMatch(/if\s*\(configuredApiUrl\s*!==\s*''\)\s*\{[\s\S]{0,120}?renderModeSwitch\(/);
  });

  it('正向：multiplayer.ts 经 ../net 的 NetClient 接线，不直接 fetch/WebSocket', () => {
    const mp = SRC('app/multiplayer.ts');
    expect(mp).toMatch(/from\s+['"]\.\.\/net['"]/);
    expect(mp).toMatch(/new\s+NetClient\s*\(/);
    expect(mp).not.toMatch(/\bfetch\s*\(/);
    expect(mp).not.toMatch(/new\s+WebSocket\b/);
    expect(mp).toMatch(/client\.close\(\)/); // teardown 断连
  });

  it('正向：mp-entry.ts 纯 DOM 无网络 API；界面全中文关键控件齐备；无登录/密码', () => {
    const entry = SRC('ui/mp-entry.ts');
    expect(entry).not.toMatch(/\b(fetch|WebSocket)\b/);
    for (const label of ['联网对战', '昵称', '房间码', '创建房间', '加入房间', '返回单人模式', '无需登录']) {
      expect(entry).toContain(label);
    }
    expect(entry).not.toMatch(/type\s*=\s*['"]password['"]/);
    expect(entry).not.toMatch(/密码|注册账号|用户名/);
    expect(entry).not.toMatch(/\bpassword\b|\bsign\s?in\b|\blogin\b/i);
  });

  it('正向：样式钉死触控目标 ≥44px 与输入 16px（防 iOS 聚焦缩放）', () => {
    const css = SRC('styles/app.css');
    expect(css).toMatch(/\.mp-btn\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.mp-field input\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.mp-field input\s*\{[^}]*font-size:\s*16px/);
  });
});
