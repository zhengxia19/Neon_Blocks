# N44 分阶段发布（预发部署 + 跨网 E2E + 回滚演练）

日期：2026-10-21 ｜ 状态：预发完成，生产（前端 main）待授权

## 预发环境

- Worker：`https://neon-blocks-room-api.zhengxia19.workers.dev`（wrangler 4.151.2）
- 部署命令：`npx wrangler deploy --var ALLOW_DEV_ORIGINS:true`（放行 127.0.0.1:4173 跨网测试来源；**生产重部署必须去掉该 var**）
- 版本轨迹：`29e5b49f`（初版）→ `26599ae7`（attach 补发修复）→ 回滚演练 → **`75204b23`（当前，含修复）**
- 用户决策：预发与生产同名 Worker/DO（无独立 staging 命名空间）⇒ 生产授权门 = 前端 main（GitHub Pages）发布。

## 跨网缺陷诊断与修复（本任务核心发现）

- 现象：`mp-resilience.spec.ts:72` 对局期刷新后 `#opponent-name` 恒为「等待对手…」，跨网 3/3 确定性失败（本地 14/14 通过）。
- 复现取证（`repro-crossnet-reload.mjs` / `repro-guest-frames.txt`）：刷新后 guest 帧持续到达（remoteSeq 4/s 续增）、watchTargetId 正确，唯独榜单面板不填。
- 根因：服务端榜单「内容无变化不重发」（room.ts `#flushScoreboard` 去重）+ 刷新重连竞态（新 attach 先于旧连接 close 处理 ⇒ 全程无状态变化）⇒ 重连客户端整局收不到 scoreboard，`lastEntries` 空 → `syncOpponentPanel` 短路。本地通过纯属断线/重连状态翻转恰好触发广播的巧合。
- 修复（`worker/src/room.ts`，单文件 +21 行）：`attachWebSocket` 后向新连接**单发补发当前已发布榜**（复用 `#sbLastRevision`，同内容同 revision 语义不变；仅 RUNNING 且内存已有已发布榜；驱逐重建后为 null 不补发空榜）。客户端 `applyScoreboard` 无去重，直接覆盖安全。
- 单测（`worker/test/room-scoreboard.test.ts` +2 用例）：正向 attach 即收当前榜（逐字段含 revision 一致）、他人零新广播；负向大厅 attach 与驱逐重建 attach 均不补发。worker vitest **225/225**。

## 测试证据（全部在 evidence/multiplayer/N44/）

| 项 | 结果 | 文件 |
| --- | --- | --- |
| 预发部署（初版/修复版） | 成功 | `deploy-staging.txt`、`deploy-staging-fix.txt` |
| 跨网 E2E 修复前 | 13/14（resilience 确定性失败） | `e2e-crossnet.txt`；确定性由复现脚本 2 次运行佐证（`resilience-repeat.txt` 仅记录 `--repeat=3` 选项不被支持的安装版 Playwright CLI 报错） |
| 复现脚本 修复前/后 | 前：恒「等待对手…」；后：t+1s 恢复 | `repro-guest-frames.txt`、`repro-guest-frames-fixed.txt` |
| 跨网 E2E 修复后（5 spec） | **14/14**（2.4min） | `e2e-crossnet-fixed.txt` |
| 跨网 resilience 复跑 ×3（修复后） | 3/3、3/3、3/3 | `resilience-repeat-fixed.txt` |
| 本地 worker E2E（5 spec） | **14/14**（50s） | `e2e-mp-local-fixed.txt` |
| 回滚演练 | 回滚 `29e5b49f` → 旧版缺陷精确复现（负向）→ 重部署 `75204b23` → health ok | `rollback-drill.txt`、`rollback-verify-oldversion.txt`、`rollback-redeploy.txt` |
| 根级回归 | tsc 0 / vitest 412/412 / build 0 | `typecheck-root-fixed.txt`、`vitest-root-fixed.txt`、`build-fixed.txt` |
| worker 回归 | tsc 0 / vitest 225/225 | `typecheck-worker-fixed.txt`、`vitest-worker-fixed.txt` |

跨网命令：`$env:E2E_API_URL=$env:VITE_MULTIPLAYER_API_URL='https://neon-blocks-room-api.zhengxia19.workers.dev'; npx playwright test tests/e2e/mp-{lobby,boards,results,resilience,matrix}.spec.ts --workers=2`

## 测试侧适配（跨网公共端点延迟）

- `playwright.config.ts`：webServer 注入 `VITE_MULTIPLAYER_API_URL=$E2E_API_URL`（前端指向预发 Worker）。
- 6 个 mp spec：房码/榜单断言超时统一 `LOBBY_TIMEOUT`(15s)、workerUp 健康检查 2s→8s（公共端点冷启动/并发排队）。

## 生产发布清单（待授权后执行）

1. Pages 构建设置（控制台，非 deploy.yml）新增环境变量 `VITE_MULTIPLAYER_API_URL=https://neon-blocks-room-api.zhengxia19.workers.dev` → 合并前端 main → Pages 自动部署。
2. 发布后跨网复测（Pages 域名 + 生产 Worker）。
3. Worker 生产重部署去掉 `ALLOW_DEV_ORIGINS`（恢复仅 ALLOWED_ORIGINS=zhengxia19.github.io）。
4. Cloudflare zone Rate Limiting Rules（`/api/*` 每 IP 限流，N43 预算表建议值）。
5. `wrangler.jsonc` 设 `workers_dev:false`（关闭 workers.dev 公网入口，仅 Pages 来源）。
6. 24h 指标观察（N43 预算红线：DO 请求/行读/GB-s；`/api/health` + pipelineStats 抽查）。

## 遗留观察（不阻塞）

- 回滚窗口：最近 100 版本可用；DO 类生命周期变更会阻塞回滚（本次仅方法体改动，回滚已实测通过）。
- N43 RISK-4/5/6、N42 O-1/O-2/O-3 维持原判，见各自 README。
