# N42 断线/恶意流量与上限压测 — 证据

## 范围与方法
- 测试程序：`tests/load/mp-abuse.mjs`（Node 原始 TCP WS 客户端，5 场景：100Hz 洪水、重复/迟到 seq、非法消息探测、慢客户端、断线重连）、`tests/load/mp-soak.mjs`（Playwright 6 客户端 × 600s，页面内包装 WebSocket 与 rAF 记录器）。
- 服务端采样：`server-samples.csv`（每 10s：workerd CPU 累计/WorkingSet、DO SQLite 文件数/总大小/mtime）。
- 环境：wrangler dev（8787，SQLite DO）+ Vite dev（4173，`VITE_MULTIPLAYER_API_URL=http://127.0.0.1:8787`），本机 Windows。

## 压测暴露的服务端缺口与修复（唯一逻辑改动：worker/src/room.ts，+54 行）
1. **出站帧率放大**：入站 20/s 限流放行的快照会向观察者按入站速率放大（实测洪水场景 watcher 收到 20Hz > 验收 5Hz）。修复：`OUTBOUND_FRAME_MIN_INTERVAL_MS = 200` 每连接出站门控（首帧放行、窗口内丢弃——最新态语义无信息损失；目标切换补发帧不受门控并刷新时戳；`#frameLastAt` 随连接/业务释放清理）。修复后洪水场景 watcher **2/s ≤ 5Hz**。注：门控按路由尝试计数，背压槽帧与当前帧同刻连发时单次尝试可发 2 帧（均为最新态），理论组合上界 ~6–7Hz，实测 0.8–2/s 远低于验收线。
2. **背压槽最新帧滞留**：单槽覆盖后若发布者停发，槽内最新帧要等下一帧才投递。修复：`SLOT_FLUSH_RETRY_MS = 500` 每连接一次性补发定时器（仍超限则重挂；随连接清理）。慢客户端场景恢复后 `latestDelivered=true`。

## 恶意流量/异常场景（abuse-metrics.json + abuse log）
| 场景 | 结果 | 判定 |
| --- | --- | --- |
| 100Hz 洪水 6s（389 条） | 入站限流 20/s；watcher 收 12 帧=2/s；洪水连接存活 | ≤5Hz ✓ |
| 重复 seq ×2 | 观察者收 1/2 | ✓ |
| 迟到（旧）seq | 收 0/1 | ✓ |
| unknown_type / forbidden_field / 3079B 快照 / 坏 JSON | 错误码 UNKNOWN_TYPE/FORBIDDEN_FIELD/BAD_SNAPSHOT/BAD_MESSAGE，连接保持 | ✓ |
| version=2 | PROTOCOL_VERSION → 关闭（1002），连接终结 | ✓ |
| 慢客户端（暂停读取 60s，992 帧发布） | 恢复后收 262 帧（<992，服务端未积压全部历史）、seq 跳变 250（单槽覆盖生效）、最新 seq 必达、连接存活 | 积压有界 ✓ |
| 断线重连（close 4001 → 2s 后 ticket 重连） | 2080ms 重连成功，房主无 player_left | ✓ |

## 600s × 6 客户端 soak（soak-metrics.json；60s 烟测 soak-smoke-metrics.json）
- 有效快照：**0.80Hz/连接**（60s 烟测 3.5–3.7Hz，JSON remoteSnapHz max 3.66；均 ≤5Hz）；每人恰 1 路目标流（remoteSnap 单目标）。
- 报文：**max 1168B ≤ 4KiB**；WS 消息数 ~520 in / ~510 out 每客户端/600s；字节 ~271KB in / ~227KB out（≈0.45/0.38 KB/s）。
- 榜单：**6 条/600s ≈ 0.01Hz ≤ 2Hz**。
- 断线注入（300s 时 debugDropSocket 第 6 页）：opened=3/closed=1，自动重连后指标与其余客户端一致。
- 本地帧时长：35974–35982 帧/600s ≈ 60fps；p95=16.7ms；长帧(>25ms) 34–35 个 = **0.09–0.10%**，无可观察恶化（不声称保证 60FPS）。
- 服务端（CSV 覆盖 11:23:47–11:34:40，66 行 × 10s）：CPU 增量 32.7s/660s；对局活跃段（前 ~3 分钟，至全员顶出）+32.0s，其后 7 分钟（含终局后 ~44s）仅 +0.53s——CPU 随消息速率而非时间增长；workerd 内存 277.9→311.1MB，活跃段后 6 分钟仅 +2.4MB（307.5→309.9）、终局后 ~44s +1.2MB，无随时间无界增长；SQLite 总大小 +69,632B ≈ 68KiB（对局事件写库，快照零写库）。

## 验收对照
| 验收项 | 实测 | 判定 |
| --- | --- | --- |
| 单连接 ≤5Hz 有效快照 | soak 0.8Hz；烟测 3.5–3.7Hz；洪水后 watcher 2/s | PASS |
| ≤4KiB/报文 | max 1168B（协议上限 4096 强制） | PASS |
| 每人至多 1 路目标流 | 每客户端仅收 watchTarget 单流 | PASS |
| 榜单 ≤2Hz | 6 条/600s | PASS |
| 内存不随时间无界增长 | 活跃段后 6min +2.4MB；槽/门控 Map 经 pipelineStats 断言随连接清理（N25 有界用例） | PASS |
| 本地帧时长/掉帧率有实测 | p95 16.7ms、长帧 0.1% | PASS |
| 不无数据声称 60FPS | 仅报告实测分布 | PASS |

## 回归
- worker：tsc 0；vitest **221/221**（新增 2 个 N42 门控/补发单测，含正/负断言；3 个既有用例补 250ms 真实节奏步进；N25 有界用例补 `frameGateSize`/`slotTimerSize` ≤6 与 close 后归零断言）。
- root：tsc 0；vitest 412/412；build 通过（mp 35.08kB / index 36.08kB / CSS 11.96kB）。
- E2E（mp-lobby/boards/results/resilience/matrix，worker 在线）：**14 passed**。

## 观察项（不阻塞）
- O-1：soak 中空闲玩家 ~2–3 分钟相继顶出（player_left=5），后段快照负载自然下降；如需持续 5Hz 满负载需脚本注入操作。
- O-2：Hibernation 下裸 setTimeout 补发定时器仅在 DO 被事件唤醒时执行（与既有 #sbTimer 同模式）；发布者停发且无任何后续事件时，槽内帧延迟到下一次事件——已被 soak/abuse 的持续发布节奏覆盖。
- O-3：容量设置经 host WS 生效与访客 REST 加入存在竞态窗口（N41 观察项复现）；soak 脚本以 1.5s 等待 + 加入重试兜底。

## 文件清单
- `abuse-metrics.json` / `abuse-metrics-abuse.log`：恶意流量场景指标与日志（log 为多轮追加：含修复前 watcher 20Hz 违例轮与修复后达标轮，构成前后对照）。
- `soak-metrics.json` / `soak-smoke-metrics.json`：600s 正式与 60s 烟测指标。
- `server-samples.csv`：服务端 CPU/内存/SQLite 采样（66 行 × 10s）。
- `typecheck-root.txt` / `vitest-root.txt` / `build.txt` / `typecheck-worker.txt` / `vitest-worker.txt` / `e2e-mp-with-worker.txt`：回归原始输出。
