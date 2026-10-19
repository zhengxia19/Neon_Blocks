import { defineConfig } from 'vitest/config';

// Worker 侧单测：只检索 worker/test/，与前端 tests/unit 互不干扰。
export default defineConfig({
  // node 环境无 `cloudflare:workers` 运行时模块，用最小 stub 供导入解析；
  // DO/SQLite 真实行为由 wrangler 本地模拟验证（N08 证据）。
  resolve: {
    alias: {
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
