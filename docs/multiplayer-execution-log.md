# 联网对战改造执行日志（N01–N44）

依据：`docs/联网对战改造方案_v1.2.md`、`docs/联网对战原子任务清单_v1.1.md`、`docs/联网对战实施题词.md`。
每项记录：任务编号 / 基线 SHA / 改动文件 / 实际命令与退出码 / 测试证据 / 复审结论 / 未解决事项。
原始命令输出存 `evidence/multiplayer/Nxx/`。

---

## N01 — 基线取证（只读）✅ PASS

- **基线 HEAD**：`83c04a88f6ae32c9edc9d59b263061cb314fdb8b`（分支 `main`，与 `origin/main` 同步，工作树干净）
- **环境**：Windows / node v24.18.1 / npm 11.16.0 / git 2.49.0
- **GitHub Pages 工作流**：`.github/workflows/deploy.yml` 未改动，SHA-256 `5A08B00947692407CB4849FB94CD5337A3D02B93D375F73536CD3A42B686437A`
- **改动文件**：无（仅新增本日志与 `evidence/multiplayer/N01/`）
- **命令与退出码**：
  - `npm ci` → 0（`evidence/multiplayer/N01/npm-ci.log`）
  - `npm run typecheck` → 0（`typecheck.log`）
  - `npm run test` → 0：**9 个测试文件 / 229 个单元测试全部通过**（`test.log`）
  - `npm run build` → 0：`dist/index.html` 0.48 kB、CSS 7.76 kB、JS 33.39 kB（`build.log`）
  - `npm run test:e2e` → 0：**7 个 Playwright 用例通过**（chromium + mobile-chrome，`e2e.log`）
- **单机功能现状**：单人模式（键盘/触屏、暂停、重开、设置持久化、320/390px 无溢出）全部通过既有 E2E。
- **复审结论**：基线可复现，四项命令与 E2E 全绿，无失败项需归因；进入 P0 后续任务的前置条件满足。
- **未解决事项**：无。
