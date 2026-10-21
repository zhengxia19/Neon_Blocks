# N43 安全、成本与架构独立复审（2026-10-21）

方法：两个只读子代理并行——①仓库八项代码审计（HEAD=eb1c2db，全部 file:line 证据）；②Cloudflare 官方文档事实核查（经官方文档源仓库 cloudflare/cloudflare-docs production 分支取证，抓取日 2026-10-21，各页最后提交日期见引注）。N42 实测数据（soak 600s×6、abuse、server-samples.csv）作为计量估算输入。

## 一、八项审查结论（逐项 PASS/FAIL）

| # | 项目 | 判定 | 关键证据（file:line） |
|---|------|------|----------------------|
| 1 | 权限 | **PASS** | wrangler.jsonc:11–18 仅 DO 绑定 + vars，无 D1/KV/secret；env.* 使用面与声明一一对应；deploy.yml（未修改）为 Pages-only 最小权限（contents:read/pages:write/id-token:write），不含 Cloudflare secrets——Worker 不经此 CI 部署 |
| 2 | Origin | **PASS** | 全局白名单门 index.ts:183–187；create/join/ticket/WS 四端点显式拒绝 null Origin（:202/:245/:305/:358，BAD_ORIGIN 403）；ALLOW_DEV_ORIGINS 生产默认关（wrangler.jsonc 未设，cors.ts:38） |
| 3 | 令牌日志 | **PASS** | worker/shared/src-net 零 console.*（grep 核验）；seatToken 从不进 URL；错误响应仅目录码不回显令牌；备注：一次性 ticket 在 WS URL（/ws/<码>?ticket=）会进 Cloudflare 自动 invocation 日志——30s TTL + 单次消费（room.ts:1836/1875–1881），泄露窗口极小，接受 |
| 4 | 房间 generation | **PASS** | 复用必换代（createRoom:441 条件 UPDATE +1，changes() 原子认领）；ticket 代际比对（:1833/:1888 GENERATION_STALE）、seatToken 比对、WS 附件核验、驱逐重建逐 socket 复核（:2622–2648）——旧 generation 的 ticket/seatToken 必然失效 |
| 5 | DoS 防护 | **PASS**（修复后） | 4KiB 双重预检（:2066）、每连接 20/s 滑窗（:2191–2205）、容量 ≤6、棋盘/字段严格校验（validate.ts:195–318）、Hibernation 全程、IP 桶有界 4096。两处小修见下 |
| 6 | 空房 Alarm | **PASS**（附接受项） | 设置/取消/裁决/驱逐重建路径完整（:1187–1205/:1243–1258/:1334–1347）；宽限 30s 与空置 30min 语义分离正确。接受项：释放后 DO 实例不删除（无 stub.delete），DO 行随历史房间码增长——见预算与风险节 |
| 7 | SQLite 写放大 | **PASS**（修复后） | 快照纯内存零写（:2243–2250）；整局事件写 <100；榜单定时器不写库。握手冗余写已条件化（见修复 2） |
| 8 | Worker/DO 计量 | **PASS**（附优化项） | 榜单 ≤2Hz、出站 ≤5Hz + 16KB 背压、循环/Map 全有界、无大表扫描。优化项：每快照 5 次 SQL 读（:2211–2237）≈9 万读/局，可缓存降载——免费层预算内可接受（见下），留作上线后优化 |

**FAIL：无。**

## 二、小修（N43 允许范围内，仅 worker/src/room.ts + 测试）

1. **裸 'ping' 计入每连接 20/s 速率门**（room.ts:2054–2062）：原豁免致恶意连接可无限刷 ping 换 1:1 pong。修复后同刻 25 条裸 ping 仅 20 pong、超限解析前丢弃不断连、窗口滑过恢复（新单测，room-snapshot.test.ts N43 describe）。浏览器客户端从不发裸 ping（保活依赖 WS close/重连），零影响（E2E resilience 通过）。
2. **握手 room_code 条件写**（room.ts:2015–2027）：`WHERE id=1 AND (room_code IS NULL OR room_code != ?)`——同码重放 0 行变更（不计 Rows written），消除重连风暴下每握手一次的冗余写。新单测用 `total_changes()` 断言同码 0 写/异码 1 写。

修复后回归：worker tsc 0 / vitest **223/223**（新增 2 用例含正/负断言）；root tsc 0 / vitest 412/412 / build 通过；E2E mp 5 specs（worker 在线）14 passed；abuse 复跑见 `abuse-rerun.txt`。

## 三、免费账户预算核算（实测 × 官方计量口径）

官方口径（DO pricing，最后提交 2026-10-18）：Free DO = 请求 100k/天、Duration 13,000 GB-s/天、SQLite Rows read 5M/天、Rows written 100k/天、Stored 5GB 账户（单对象 1GB）；入站 WS 消息按 **20:1** 折算 DO 请求，出站消息与协议 ping 免费；Hibernation 空闲 DO 不计 duration。Workers Free：100k 请求/天、10ms CPU/invocation；WS 握手=1 请求，中转消息不计 Workers 请求；egress 不计费。DO 上 Free 为 **2025-04-07** 起且仅 SQLite-backed（与本项目 new_sqlite_classes 一致）。

按 N42 实测（6 客户端 600s 局：入站 WS ≈3,120 条、其中快照 ≈3,050、握手 6、REST ≈18、写 <100）与 publisher 5Hz 天花板口径（快照上限 18,000/局）折算**每局**成本与免费日配额可支撑局数（Rows read 行取天花板口径，保守）：

| 计量维度 | 每局（口径见行内） | Free 日配额 | 可支撑 | 判定 |
|---|---|---|---|---|
| DO 请求（消息 20:1 + 握手 + RPC + alarm，实测口径） | ≈180 | 100,000 | ≈550 局/天 | PASS |
| Workers 请求（握手+REST，实测口径） | ≈25 | 100,000 | ≈4,000 局/天 | PASS |
| SQLite Rows read（天花板口径：5Hz 上限×6×600=18,000 快照×5 读 + 事件 ≈1k；实测口径 ≈3,050 快照 ⇒ ≈16k 读 ⇒ ≈300 局/天） | ≈91,000 | 5,000,000 | **≈55 局/天**（实测口径 ≈300） | **最紧约束**（两口径下均最紧） |
| SQLite Rows written | ≈50–100（修复后握手 0 写） | 100,000 | >1,000 局/天 | PASS |
| DO Duration（活跃 600s×128MB=76.8 GB-s/局；休眠免费） | 76.8 | 13,000 GB-s | ≈169 局/天 | PASS |
| CPU/invocation | 实测 workerd 32.7s/660s（6 客户端）→ 每条 ≪10ms | 10 ms | 余量充足 | PASS |
| Stored | 测试残留 1,105 DO 共 45MB（≈41KB/DO） | 5GB 账户 | ≈12 万房间码 | PASS（见风险 3） |
| 单 DO 软限 | 6 客户端×20/s → 折算 ≈6 req/s | 1,000 req/s | 余量 160× | PASS |

结论：**免费账户可上线**，最紧约束为 Rows read（保守天花板口径 ≈55 局/天，实测口径 ≈300 局/天；6 人×10 分钟局）；若日活对局超此量，先做快照读缓存（按 generation 缓存 matchId/roster，可把每快照 5 读降到 0–1；每快照 SQL 面还含未 memoize 的 `#ensureSchema` DDL 与 `#ensureRow`，缓存应一并覆盖——既有行为，非 N43 引入）或升 Paid。不依赖“估计免费”，以上均为官方配额表口径。

## 四、免费账户可用性风险

1. **Rows read 5M/天**：超后 SQL 读直接报错（对局中断），00:00 UTC 重置——需在 N44 预发期观察 dashboard 计量，必要时先做读缓存。
2. Workers 100k 请求/天超限 Error 1027；10ms CPU/invocation 超限 Error 1102（实测余量大）。
3. **DO 行不删除**：每历史房间码保留一个近空 DO（≈12–41KB）；码空间 900k 理论上限 > 5GB 账户配额——现实规模（≈12 万码）内可接受；接受并监控，后续可对 occupied=0 的 id 调 `stub.delete()`（generation 语义需一并设计）。
4. Workers Logs Free 200k 事件/天、留存 3 天；tail 高流量可能采样；WS handler 内 console.log 到 close 才 flush（本项目零 console，无此患）。
5. IP 限流桶仅单 isolate 内存（index.ts:103–165），跨 isolate 不共享——分布式攻击依赖 zone 级 Rate Limiting Rules（N44 部署清单固化）；兜底开关 PUBLIC_CREATE_ENABLED 已在。
6. workers.dev 默认公开可扫描——N44 按 Worker 关闭（wrangler `workers_dev:false` 或 dashboard+wrangler 双写）。

## 五、回滚条件（N44 输入）

- **代码回滚**：dashboard/wrangler rollback 一键回最近 **100 个版本**；回滚不改绑定、不回滚数据。
- **回滚阻断条件**：版本间不得变更 DO class 生命周期（exports/migrations create/delete/rename/transfer）——N44 期间冻结 wrangler.jsonc 的 DO 声明与 schema；变更即失去回滚兜底。
- **不可逆点**：DO namespace tombstone 删除 = 数据永久删除（无 Trash）；storage backend（sqlite）provision 后不可变。
- **触发条件与路径**：①配额超限/WS 大面积失败/DO 异常 → 前端关闭联网入口（单人游戏保持在线，GitHub Pages 回退旧版 commit）；②Worker 侧异常 → 回滚上一 Worker 版本；③数据损坏 → 房间码为一次性资源，释放即弃，无迁移负担。
- N44 要求回滚演练：预发 Worker 上演练「回滚上一版本 + 关闭联网入口」两条路径并记录。

## 六、N44 部署清单（本复审产出）

1. 单独预发 Worker/DO（不同 name），验证后生产 Worker 另行授权。
2. 固化 zone 级 Rate Limiting Rules（对应 index.ts 桶语义）或明确接受单 isolate 桶风险。
3. `ALLOWED_ORIGINS` 生产值 = Pages 域名；不设 ALLOW_DEV_ORIGINS；`workers_dev:false`。
4. 部署后 24h 观察 DO 计量四项（requests/rows read/rows written/duration）对照本表。

## 七、证据文件

- `typecheck-worker.txt`（0）、`vitest-worker.txt`（223/223）、`typecheck-root.txt`（0）、`vitest-root.txt`（412/412）、`build.txt`（通过）、`e2e-mp-with-worker.txt`（14 passed）、`abuse-rerun.txt`（小修后 abuse 复跑）。
- 代码审计与文档核查全文要点已并入本报告；文档来源 URL：workers/platform/limits、workers/platform/pricing、durable-objects/platform/pricing、durable-objects/api/sqlite-storage-api、durable-objects/best-practices/websockets、workers/observability/logs/*、workers/versions-and-deployments/rollbacks、durable-objects/reference/durable-objects-migrations、changelog 2025-04-07-durable-objects-free-tier、2025-12-12-durable-objects-sqlite-storage-billing（developers.cloudflare.com，抓取 2026-10-21）。
