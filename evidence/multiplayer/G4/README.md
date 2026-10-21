# 关口 G4 验收（2026-10-21）

**判定：G4 PASS**（清单 §关口 G4：N41–N43 通过；单机全量回归、跨网稳定性、Cloudflare 预算复审均 PASS）。

## 1. N41–N43 通过状态
- N41（2–6 人功能矩阵 E2E）：`30e530b`，独立复审 PASS，evidence/multiplayer/N41/。
- N42（断线/恶意流量与上限压测）：`2aab79f`+`eb1c2db`，独立复审 PASS（2 P2 已修），evidence/multiplayer/N42/。
- N43（安全/成本/架构独立复审）：`f915bc9`，独立复审 PASS（3 P2 已修），八项全 PASS、FAIL=0，evidence/multiplayer/N43/。

## 2. 单机全量回归（必跑，本目录证据）
- `typecheck-root.txt`：tsc 0 错误。
- `vitest-root.txt`：27 文件 / **412/412**。
- `build.txt`：tsc -b + vite build 通过（multiplayer 35.08 kB / index 36.08 kB / CSS 11.96 kB）。
- `typecheck-worker.txt`：worker tsc 0 错误。
- `vitest-worker.txt`：27 文件 / **223/223**。
- `e2e-standalone.txt`：Playwright 全量（无 worker、干净 Vite）：**15 passed / 17 skipped**（mp specs 无 API 时按设计跳过），与基线一致。

## 3. 跨网/多客户端稳定性（N42 证据）
- soak 600s×6 真实浏览器客户端：快照 0.80Hz/连接 ≤5Hz、max 报文 1168B ≤4KiB、榜单 6 条/600s ≤2Hz、帧 p95=16.7ms、长帧 0.09–0.10%、中途断线客户端自动重连恢复。
- abuse 五场景（100Hz 洪水/重复 seq/迟到帧/非法消息/慢客户端/断线重连）全部达标；N43 小修后复跑 exit 0（`N43/abuse-rerun.txt`）。
- 真实跨网（公网）验证按清单属 N44 预发阶段（2 人跨网 → 6 人跨终端）。

## 4. Cloudflare 预算复审（N43 证据）
- 官方口径（2026-10-21 取证）× N42 实测：免费账户可上线；最紧约束 DO SQLite Rows read（天花板口径 ≈55 局/天、实测口径 ≈300 局/天）；DO 请求 ≈180/局、Duration 76.8 GB-s/局（休眠免费）、Rows written <100/局、CPU/条 ≪10ms、egress 不计费。
- 回滚条件与 N44 部署清单已固化（N43/README.md 五、六节）。

## 5. 遗留观察（带入 N44）
- 快照读缓存优化（Rows read 降载）为上线后可选项；zone 级 Rate Limiting Rules、`workers_dev:false`、生产 `ALLOWED_ORIGINS` 属 N44 部署清单。
- N40-a/N40-b/N41 既有观察项（KeyP 暂停 MP 引擎、fatal 文案、容量设置竞态等）在 N44 预发跨网测试中复核。

**G5（N44 生产发布）须单独授权**；预发 Worker/DO 先行。
