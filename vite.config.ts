import { defineConfig } from 'vitest/config';

// Vitest 配置（T004 契约：npm run test 只检索 tests/unit/**/*.test.ts）。
// T005 新增 tests/e2e/*.spec.ts 后，Vitest 默认 include（**/*.{test,spec}.*）会误抓 Playwright spec，
// 故显式限定 unit 目录；E2E 由 playwright.config.ts 的 testMatch 负责。
export default defineConfig({
  // 发布到 GitHub Pages 项目站点（/Neon_Blocks/ 子路径）：
  // base 设为相对路径，产物在任意子路径下均可直接打开 index.html。
  base: './',
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
