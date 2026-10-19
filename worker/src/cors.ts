/**
 * N08：CORS / Origin 白名单（纯函数，可单测）。
 * 规则（方案 §11）：正式仅允许 GitHub Pages 站点 `https://zhengxia19.github.io`
 * （Origin 不含路径）；本地开发白名单仅测试使用；无 Origin 头（同源导航、
 * curl、服务端调用）不受 CORS 限制，但仍受各接口自身校验约束。
 */

/** 本地开发白名单（仅测试；生产 vars 不含）。 */
export const DEV_ORIGINS: readonly string[] = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
];

/** 解析逗号分隔白名单为数组（去空白、忽略空项）。 */
export function parseAllowlist(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Origin 是否允许：
 * - `null`（无 Origin 请求）→ 允许（不适用 CORS）；
 * - 命中生产白名单（vars）或本地开发白名单 → 允许；
 * - 其他 → 拒绝。
 */
export function isOriginAllowed(origin: string | null, productionAllowlist: string | undefined): boolean {
  if (origin === null) return true;
  const allowed = new Set([...parseAllowlist(productionAllowlist), ...DEV_ORIGINS]);
  return allowed.has(origin);
}

/** 构造 CORS 响应头（仅允许的 Origin 回显；预检允许 GET/POST + content-type）。 */
export function corsHeaders(origin: string | null, method: 'GET' | 'POST' | 'OPTIONS'): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-origin': origin ?? '*',
    'vary': 'Origin',
  };
  if (method === 'OPTIONS') {
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-max-age'] = '600';
  }
  return headers;
}
