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

---

## N02 — 建立网络模块目录与构建边界 ✅ PASS

- **基线 HEAD**：`ea0127e`（N01 之后）
- **改动文件（3 个逻辑文件 + 2 个测试 + 配置）**：
  - 新增 `shared/protocol.ts`（前后端共享纯常量：`PROTOCOL_VERSION=1`、`PROTOCOL_ID`、`MAX_MESSAGE_BYTES=4096`、房间码/容量/昵称边界）
  - 新增 `src/net/index.ts`（前端网络入口，仅复用 shared 契约；不含 Worker 代码）
  - 新增 `worker/package.json`、`worker/tsconfig.json`、`worker/vitest.config.ts`、`worker/src/index.ts`（独立 package：`@cloudflare/workers-types` / `typescript` / `vitest` / `wrangler` 均为 devDependency，无运行时框架依赖）
  - 新增测试 `tests/unit/net-boundary.test.ts`（4 例）、`worker/test/protocol-boundary.test.ts`（3 例）
  - 修改根 `tsconfig.json`：`include` 加入 `shared`，`exclude` 明确排除 `worker`
- **构建边界结论**：前端与 Worker 通过同一份 `shared/` 源码编译（前端 `tsc -b` + Vite；Worker 独立 `tsc -p` + Wrangler/esbuild）；Worker 依赖只存在于 `worker/` 子 package，根 `npm ci` 与 Pages 构建不受影响。
- **命令与退出码**：
  - `npm install`（worker 目录）→ 0；`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0（**3 例通过**）
  - `npm run typecheck` → 0；`npm run test` → 0：**10 文件 / 233 例通过**（新增 4 例边界断言）；`npm run build` → 0，产物 JS 仍为 33.39 kB（未引入网络代码）
  - 产物扫描：`dist/assets/*.js` 中无 `DurableObject` / `ExportedHandler` / `ROOM_DO` 标记
- **复审结论**：前端原构建正常、shared 可被前端单独 typecheck、`src/game/` 无 net/worker 依赖、shared 无 DOM/Worker API；Worker 独立编译已在本地验证，其 DO 绑定与 Wrangler 本地模拟留待 N08。`.github/workflows/deploy.yml` 未改动。
- **未解决事项**：Worker 的 `wrangler.jsonc` 与 DO 绑定尚未创建（属 N08 范围）。
