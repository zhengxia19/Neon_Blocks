/**
 * N07：模式装配分流（纯函数，可单测）。
 * 联网模式采用「配置模式」：URL `?mode=multiplayer` 且已配置公开 API 地址
 * （`VITE_MULTIPLAYER_API_URL`，见方案 §5/§11）才进入联网装配；
 * 任一条件不满足（含非法值、API 未配置）一律回退单人模式，保证单机永远可玩。
 * 本文件不导入 net/、game/，不触碰 DOM。
 */

export type AppMode = 'single' | 'multiplayer';

export interface ModeConfig {
  /** `window.location.search`（含前导 `?` 或不含均可）。 */
  search: string;
  /** 公开联网 API 地址（未配置/空串视为联网不可用）。 */
  apiUrl?: string;
}

/** 解析当前应装配的模式；任何异常输入安全回退 `single`。 */
export function resolveAppMode(config: ModeConfig): AppMode {
  const search = typeof config.search === 'string' ? config.search.replace(/^\?/, '') : '';
  let requested: string | null = null;
  try {
    requested = new URLSearchParams(search).get('mode');
  } catch {
    requested = null;
  }
  if (requested === null) return 'single';
  if (requested.toLowerCase() === 'multiplayer') {
    const url = typeof config.apiUrl === 'string' ? config.apiUrl.trim() : '';
    return url !== '' ? 'multiplayer' : 'single';
  }
  return 'single';
}
