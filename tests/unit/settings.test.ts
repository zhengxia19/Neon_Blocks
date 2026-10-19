// 单元测试 — 设置持久化（规格 S07，任务 T046）。
// 全部用 stub localStorage，覆盖：默认、保存重读、损坏数据、逐字段回退、禁止写入。

import { describe, expect, it } from 'vitest';
import {
  BEST_SCORE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  readBestScore,
  saveSettings,
  writeBestScore,
  type StorageLike,
} from '../../src/storage/settings';

/** Map 后备的内存存储 stub。 */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** 任意访问都抛 DOMException 的存储 stub（私密模式 / 禁用存储）。 */
class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new DOMException('SecurityError: storage disabled');
  }
  setItem(): void {
    throw new DOMException('SecurityError: storage disabled');
  }
}

/** 可读但写入必抛（配额耗尽 / 只读存储）。 */
class WriteBlockedStorage extends MemoryStorage {
  override setItem(): void {
    throw new DOMException('QuotaExceededError');
  }
}

describe('settings（S07 设置持久化）', () => {
  it('存储键精确匹配 neon-blocks:v1:settings', () => {
    expect(SETTINGS_KEY).toBe('neon-blocks:v1:settings');
  });

  it('默认值为静音、Ghost 开、减少动画关', () => {
    expect({ ...DEFAULT_SETTINGS }).toEqual({
      soundEnabled: false,
      ghostEnabled: true,
      reducedMotion: false,
    });
  });

  it('无存储 / 无数据 / 空字符串 → 返回默认值', () => {
    expect(loadSettings(null)).toEqual({ ...DEFAULT_SETTINGS });
    expect(loadSettings(new MemoryStorage())).toEqual({ ...DEFAULT_SETTINGS });
    const blank = new MemoryStorage();
    blank.setItem(SETTINGS_KEY, '');
    expect(loadSettings(blank)).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('保存后重读得到相同设置（round-trip）', () => {
    const storage = new MemoryStorage();
    const settings = { soundEnabled: true, ghostEnabled: false, reducedMotion: true };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
    // 序列化落在精确键上且内容是合法 JSON 布尔对象
    const raw = storage.map.get(SETTINGS_KEY) as string;
    expect(JSON.parse(raw)).toEqual(settings);
  });

  it('损坏 JSON 与顶层非对象 → 默认值', () => {
    for (const raw of ['not json', '{', '"abc"', '5', 'null', '[1,2]']) {
      const storage = new MemoryStorage();
      storage.setItem(SETTINGS_KEY, raw);
      expect(loadSettings(storage), `raw=${JSON.stringify(raw)}`).toEqual({ ...DEFAULT_SETTINGS });
    }
  });

  it('字段类型不符时逐字段回退，合法字段保留', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ soundEnabled: 'yes', ghostEnabled: false }));
    expect(loadSettings(storage)).toEqual({
      soundEnabled: false, // 非法 "yes" → 默认 false
      ghostEnabled: false, // 合法 false → 保留
      reducedMotion: false, // 缺字段 → 默认 false
    });
    storage.setItem(SETTINGS_KEY, JSON.stringify({ soundEnabled: true, ghostEnabled: null, reducedMotion: 0 }));
    expect(loadSettings(storage)).toEqual({
      soundEnabled: true,
      ghostEnabled: true, // null → 默认 true
      reducedMotion: false, // 0 → 默认 false
    });
  });

  it('读取抛异常 → 默认值；写入抛异常 → 不抛出且内存设置仍可用', () => {
    expect(() => saveSettings({ soundEnabled: true, ghostEnabled: true, reducedMotion: true }, new ThrowingStorage())).not.toThrow();
    expect(loadSettings(new ThrowingStorage())).toEqual({ ...DEFAULT_SETTINGS });
    const blocked = new WriteBlockedStorage();
    const settings = { soundEnabled: true, ghostEnabled: false, reducedMotion: false };
    expect(() => saveSettings(settings, blocked)).not.toThrow(); // 写失败不阻塞
    expect(loadSettings(blocked)).toEqual({ ...DEFAULT_SETTINGS }); // 未写入 → 默认
  });

  it('saveSettings 将非布尔字段规范化为布尔（与默认一致）后写入', () => {
    const storage = new MemoryStorage();
    saveSettings(
      { soundEnabled: 'x', ghostEnabled: undefined, reducedMotion: 1 } as unknown as {
        soundEnabled: boolean;
        ghostEnabled: boolean;
        reducedMotion: boolean;
      },
      storage,
    );
    expect(JSON.parse(storage.map.get(SETTINGS_KEY) as string)).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('loadSettings 每次返回新对象，DEFAULT_SETTINGS 不被调用方污染', () => {
    const first = loadSettings(null);
    first.ghostEnabled = false;
    expect(DEFAULT_SETTINGS.ghostEnabled).toBe(true);
    expect(loadSettings(null).ghostEnabled).toBe(true);
  });
});

describe('best-score（T047 历史最高分）', () => {
  it('存储键精确匹配 neon-blocks:v1:best-score', () => {
    expect(BEST_SCORE_KEY).toBe('neon-blocks:v1:best-score');
  });

  it('无数据 / 存储不可用 → 0', () => {
    expect(readBestScore(null)).toBe(0);
    expect(readBestScore(new MemoryStorage())).toBe(0);
    expect(readBestScore(new ThrowingStorage())).toBe(0);
  });

  it('新高分写入并可重读（刷新后准确）', () => {
    const storage = new MemoryStorage();
    expect(writeBestScore(1234, storage)).toBe(1234);
    expect(readBestScore(storage)).toBe(1234);
    expect(writeBestScore(9999, storage)).toBe(9999); // 更高 → 刷新纪录
    expect(readBestScore(storage)).toBe(9999);
    // 存储内容是纯十进制整数文本（S07「非负安全整数文本」）
    expect(storage.map.get(BEST_SCORE_KEY)).toBe('9999');
  });

  it('非新高不更新也不写入（无变化）', () => {
    const storage = new MemoryStorage();
    writeBestScore(1234, storage);
    const before = storage.map.get(BEST_SCORE_KEY);
    expect(writeBestScore(500, storage)).toBe(1234);
    expect(writeBestScore(1234, storage)).toBe(1234); // 相等也不重写
    expect(storage.map.get(BEST_SCORE_KEY)).toBe(before);
    expect(readBestScore(storage)).toBe(1234);
  });

  it('损坏文本：负数/小数/科学计数/超安全整数/乱码 → 0', () => {
    for (const raw of ['-5', '12.5', '1e9', '9007199254740993', 'abc', '', 'null', ' 42', '+7', '0x1F']) {
      const storage = new MemoryStorage();
      storage.setItem(BEST_SCORE_KEY, raw);
      expect(readBestScore(storage), `raw=${JSON.stringify(raw)}`).toBe(0);
    }
    const zero = new MemoryStorage();
    zero.setItem(BEST_SCORE_KEY, '0');
    expect(readBestScore(zero)).toBe(0); // 合法的 0
  });

  it('非法输入值按 0 参与比较；写入抛异常不阻塞（禁用存储）', () => {
    const storage = new MemoryStorage();
    expect(writeBestScore(-100, storage)).toBe(0);
    expect(writeBestScore(Number.NaN, storage)).toBe(0);
    expect(writeBestScore(Number.POSITIVE_INFINITY, storage)).toBe(0);
    expect(storage.map.size).toBe(0); // 0 分不构成新高 → 无写入
    const blocked = new WriteBlockedStorage();
    expect(() => writeBestScore(500, blocked)).not.toThrow();
    expect(readBestScore(blocked)).toBe(0); // 写入失败仍安全读 0
    expect(() => writeBestScore(500, new ThrowingStorage())).not.toThrow();
  });
});
