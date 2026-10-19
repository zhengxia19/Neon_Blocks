// N07：模式装配分流（配置模式：URL 参数 + 公开 API 地址双条件，否则单机）。
import { describe, expect, it } from 'vitest';
import { resolveAppMode } from '../../src/app/mode';

const API = 'https://neon-blocks-room.example.workers.dev';

describe('N07 resolveAppMode 分流', () => {
  it('正向：默认与显式 single 均为单人装配', () => {
    expect(resolveAppMode({ search: '', apiUrl: API })).toBe('single');
    expect(resolveAppMode({ search: '?mode=single', apiUrl: API })).toBe('single');
    expect(resolveAppMode({ search: 'mode=single' })).toBe('single');
  });

  it('正向：mode=multiplayer 且已配置 API 才进入联网装配', () => {
    expect(resolveAppMode({ search: '?mode=multiplayer', apiUrl: API })).toBe('multiplayer');
    expect(resolveAppMode({ search: '?mode=MULTIPLAYER&x=1', apiUrl: API })).toBe('multiplayer');
    expect(resolveAppMode({ search: 'mode=multiplayer', apiUrl: ' ' + API + ' ' })).toBe('multiplayer');
  });

  it('反向：API 未配置/空白时 multiplayer 请求安全回退单机', () => {
    expect(resolveAppMode({ search: '?mode=multiplayer' })).toBe('single');
    expect(resolveAppMode({ search: '?mode=multiplayer', apiUrl: '' })).toBe('single');
    expect(resolveAppMode({ search: '?mode=multiplayer', apiUrl: '   ' })).toBe('single');
  });

  it('反向：非法/缺失 mode 值一律回退单机（不抛异常）', () => {
    for (const s of ['?mode=net', '?mode=', '?mode=multiplayerx', '?mod=multiplayer', '?mode=']) {
      expect(resolveAppMode({ search: s, apiUrl: API })).toBe('single');
    }
    expect(resolveAppMode({ search: 42 as unknown as string, apiUrl: API })).toBe('single');
    expect(resolveAppMode({ search: '?mode=multiplayer', apiUrl: 42 as unknown as string })).toBe('single');
  });
});
