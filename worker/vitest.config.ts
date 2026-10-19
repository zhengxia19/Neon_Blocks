import { defineConfig } from 'vitest/config';

// Worker 侧单测：只检索 worker/test/，与前端 tests/unit 互不干扰。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
