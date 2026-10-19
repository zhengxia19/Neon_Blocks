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

---

## N03 — 锁定协议与错误码 ✅ PASS

- **基线 HEAD**：`d68c0a8`
- **改动文件（2 个逻辑文件 + 2 个测试）**：`shared/protocol.ts`（扩展为完整契约）、`shared/errors.ts`（新增）、`tests/unit/protocol.test.ts`（新增 10 例）、`worker/test/protocol-boundary.test.ts`（+1 例）、`src/net/index.ts`（仅补充再导出）
- **协议要点**：`v/type/seq/revision/roomGeneration` 全部固定；C→S 白名单 `ready|start|settings_update|snapshot|gameover|leave|ping`，S→C 白名单 `room_state|player_joined|player_left|countdown|match_start|scoreboard|watch_target|remote_snapshot|match_end|error|pong`（与方案 §7.2 逐字一致，测试断言）；快照模型含 24×10 棋盘（24 行 × 10 字符）、活动块、得分、消行、等级、状态、`seq`；HTTP 模型 `CreateRoomRequest/JoinRoomRequest/SeatGrantedResponse/TicketResponse/HealthResponse`；机密 `seatToken` 只在创建/加入响应出现一次，`playerId` 为可公开的内部席位 ID，`nickname` 为公开显示名。
- **兼容/拒绝策略（前后端一致）**：版本必须精确等于 1，否则 `error(PROTOCOL_VERSION)` + WS 1002 关闭；未知 `type` → `error(UNKNOWN_TYPE)` 忽略不断连；客户端携带 `FORBIDDEN_CLIENT_FIELDS`（`seatToken/ticket/playerId/matchId/winners/eliminatedAt/serverTime/revision/generation/seed/…`）→ `error(FORBIDDEN_FIELD)` 整条拒绝；未声明扩展字段按白名单丢弃。
- **错误码**：30 个中文错误码目录 `ERROR_CATALOG`（协议/参数/房间席位/状态机/服务端五类），`describeError` 对未知码统一回退 `INTERNAL`，不外泄内部文本。
- **命令与退出码**：`npm run typecheck` → 0；`npm run test` → 0（**11 文件 / 243 例**，新增 10 例：全消息序列化往返、类型白名单、版本判定、非法 JSON 返回 null、未知类型、污染字段、shared 与 `src/game/constants` 棋盘尺寸一致、错误目录完整性与未知码回退）；`npm run build` → 0；`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0（**4 例**，证明 Worker 侧引用同一 `PROTOCOL_VERSION` 与同一错误目录）。
- **复审结论**：前后端引用同一协议版本与同一错误目录（两侧测试各自断言）；协议版本错误、未知类型、服务端禁止字段均有反向断言；`shared/` 保持纯类型/常量，无 DOM/Worker API。
- **未解决事项**：运行时严格校验（昵称/房间码/坐标/字节上限）留待 N04。
