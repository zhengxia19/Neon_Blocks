import { defineConfig, devices } from '@playwright/test';

// T005：E2E 浏览器与服务器配置（规格 S02、S08；任务清单 T005）。
// - 两个 project：chromium（桌面）与 mobile-chrome（移动 Chrome 模拟）。
// - testMatch 精确限定各 project 执行的 spec，避免跨设备误跑：
//   chromium 仅 desktop.spec.ts 与 smoke.spec.ts；mobile-chrome 仅 mobile.spec.ts 与 smoke.spec.ts。
// - webServer 自动启停 Vite dev，固定端口 4173（strictPort）。
// - 截图/测试产物目录固定为 test-results/。
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      // N33：mp-lobby 需本机 Worker(8787)，未运行时用例内跳过；仅桌面 project 跑。
      testMatch: /(^|[/\\])(desktop|smoke|mp-entry|mp-lobby)\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      testMatch: /(^|[/\\])(mobile|smoke|mp-entry)\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // N32：E2E 构建期配置公开 API 地址 → 首页渲染单人/联网分流条。
    // （E2E 不启动 Worker：合法加入走「服务器暂时无法访问」中文降级路径。）
    env: { VITE_MULTIPLAYER_API_URL: 'http://127.0.0.1:8787' },
  },
});
