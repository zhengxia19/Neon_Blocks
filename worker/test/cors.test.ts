// N08：CORS / Origin 白名单纯函数测试（node 环境，无需 Worker 运行时）。
import { describe, expect, it } from 'vitest';
import { DEV_ORIGINS, corsHeaders, isOriginAllowed, parseAllowlist } from '../src/cors';

const PROD = 'https://zhengxia19.github.io';

describe('N08 Origin 白名单', () => {
  it('正向：正式 Pages 原点允许；allowDev 开启时本地开发原点允许；无 Origin 不适用 CORS', () => {
    expect(isOriginAllowed(PROD, PROD)).toBe(true);
    for (const dev of DEV_ORIGINS) {
      expect(isOriginAllowed(dev, PROD, true)).toBe(true);
    }
    expect(isOriginAllowed(null, PROD)).toBe(true);
  });

  it('反向：未登记原点、近似前缀拒绝；allowDev 缺省关闭时本地原点也拒绝（N09 观察①）', () => {
    expect(isOriginAllowed('https://evil.example', PROD)).toBe(false);
    expect(isOriginAllowed('https://zhengxia19.github.io.evil.example', PROD)).toBe(false);
    expect(isOriginAllowed('http://zhengxia19.github.io', PROD)).toBe(false); // 协议必须精确
    expect(isOriginAllowed(PROD, undefined)).toBe(false); // 未配置生产白名单
    expect(isOriginAllowed('https://zhengxia19.github.io/', PROD)).toBe(false); // 尾斜杠不等价
    for (const dev of DEV_ORIGINS) {
      expect(isOriginAllowed(dev, PROD)).toBe(false); // 生产缺省不放行本地原点
    }
  });

  it('正向：白名单解析容忍空白与空项', () => {
    expect(parseAllowlist(` ${PROD} , , http://a.example `)).toEqual([PROD, 'http://a.example']);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('正向：CORS 头仅回显允许原点，预检含方法与头部；未配置白名单时生产原点被拒后不回显', () => {
    const h = corsHeaders(PROD, 'OPTIONS');
    expect(h['access-control-allow-origin']).toBe(PROD);
    expect(h['access-control-allow-methods']).toContain('POST');
    expect(corsHeaders(PROD, 'GET')['access-control-allow-methods']).toBeUndefined();
    expect(corsHeaders(null, 'GET')['access-control-allow-origin']).toBe('*');
    expect(isOriginAllowed('https://evil.example', PROD)).toBe(false);
  });
});
