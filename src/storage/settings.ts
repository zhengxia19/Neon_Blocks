// Neon Blocks — 设置持久化（规格 S07/S03.5，任务 T046/T047）。
// 全部存储键在 settings.ts 统一管理（S02 模块边界）。所有 localStorage 访问
// 都在 try/catch 内：私密模式 / 禁用存储 / 损坏数据时安全回退，
// 游戏依然可玩（S07）。

/** 可注入的最小存储接口（与 window.localStorage 兼容，便于单测 stub）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 用户设置（S07 精确字段与默认值）。 */
export interface GameSettings {
  soundEnabled: boolean;
  ghostEnabled: boolean;
  reducedMotion: boolean;
}

/** 设置存储键（S07：`neon-blocks:v1:settings`，精确匹配）。 */
export const SETTINGS_KEY = 'neon-blocks:v1:settings';

/** 最高分存储键（T047 使用；S07 精确匹配）。 */
export const BEST_SCORE_KEY = 'neon-blocks:v1:best-score';

/** 默认设置：静音、Ghost 开、减少动画关（S07）。 */
export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  soundEnabled: false,
  ghostEnabled: true,
  reducedMotion: false,
});

/** 缺省存储：浏览器环境取 window.localStorage；无 window（测试/SSR）返回 null。 */
function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 逐字段布尔归一：仅接受真正的 boolean，其余（缺字段/类型不符）回退默认。 */
function coerceFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 读取设置：任何异常路径（存储不可用、读取抛错、JSON 损坏、顶层非对象、
 * 字段类型不符）都安全降级——未知输入逐字段回退默认值（S07/T046 步骤 2）。
 */
export function loadSettings(storage: StorageLike | null = defaultStorage()): GameSettings {
  let raw: string | null = null;
  try {
    raw = storage === null ? null : storage.getItem(SETTINGS_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS }; // 读取抛异常 → 默认（私密模式等）
  }
  if (raw === null || raw === '') {
    return { ...DEFAULT_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS }; // 损坏 JSON → 默认值
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    soundEnabled: coerceFlag(obj.soundEnabled, DEFAULT_SETTINGS.soundEnabled),
    ghostEnabled: coerceFlag(obj.ghostEnabled, DEFAULT_SETTINGS.ghostEnabled),
    reducedMotion: coerceFlag(obj.reducedMotion, DEFAULT_SETTINGS.reducedMotion),
  };
}

/**
 * 写入设置：字段规范化为 boolean 后序列化；存储抛异常（配额/禁用写入）
 * 静默吞掉不上抛——保存失败绝不阻塞游戏（S07）。
 */
export function saveSettings(settings: GameSettings, storage: StorageLike | null = defaultStorage()): void {
  const normalized: GameSettings = {
    soundEnabled: coerceFlag(settings?.soundEnabled, DEFAULT_SETTINGS.soundEnabled),
    ghostEnabled: coerceFlag(settings?.ghostEnabled, DEFAULT_SETTINGS.ghostEnabled),
    reducedMotion: coerceFlag(settings?.reducedMotion, DEFAULT_SETTINGS.reducedMotion),
  };
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // 写入失败静默处理：游戏继续使用内存中的设置。
  }
}

// ---------------------------------------------------------------------------
// T047：历史最高分（S03.5/S07）——非负安全整数文本，异常一律降级为 0
// ---------------------------------------------------------------------------

/** 只接受非负十进制整数文本（±号、小数、科学计数、空白都视为不合法）。 */
const BEST_SCORE_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * 读取历史最高分：键缺失 / 存储异常 / 文本不合法（非整数、负数、超出安全
 * 整数范围）→ 0（T047 步骤 2；S07「解析失败→0」）。
 */
export function readBestScore(storage: StorageLike | null = defaultStorage()): number {
  let raw: string | null = null;
  try {
    raw = storage === null ? null : storage.getItem(BEST_SCORE_KEY);
  } catch {
    return 0;
  }
  if (raw === null || !BEST_SCORE_PATTERN.test(raw)) {
    return 0;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : 0; // 超出 2^53-1 → 0
}

/**
 * 写入最高分（S03.5）：仅当本局分数高于已存最高分才更新；存储出错不抛。
 * 输入非有限 / 负数 / 超安全整数按 0 参与比较。返回写入后生效的最高分。
 */
export function writeBestScore(value: number, storage: StorageLike | null = defaultStorage()): number {
  const safe = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  const current = readBestScore(storage);
  const next = Math.max(current, safe);
  if (next === current) {
    return current; // 无新高：不产生多余写入
  }
  try {
    storage?.setItem(BEST_SCORE_KEY, String(next));
  } catch {
    // 写入失败不阻塞游戏：内存中的会话分数仍然有效。
  }
  return next;
}
