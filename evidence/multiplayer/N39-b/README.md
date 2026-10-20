# N39-b 证据：淘汰、超时、结果与下一局 UI（客户端）

## 范围
- 新增 `src/ui/match-results.ts`：纯函数 `formatRemaining`（600s→`10:00`，负值钳 0）、`endReasonLabel`（survival/timeout/abandoned 中文标签）、`winnersText`（胜者/并列胜者/无胜者独立文案）+ 结果面板 DOM（`#mp-results`、房主专属 `#mp-next-round`）。
- `src/app/match.ts`：状态行逐秒展示 `比赛进行中 · 剩余 mm:ss`（`deadlineAt − (Date.now()+clockOffset)` 校准墙钟）；本人淘汰由服务端榜单 `status=eliminated` 驱动（`你已淘汰，等待比赛结束`）；`applyMatchEnd` 改收 `MatchEndMsg` 全量（原因 + 按服务端榜单顺序提取胜者昵称 → 全员同文案 + 房主入口）；`destroy` 释放结果面板。
- `src/app/multiplayer.ts`：`room_state` 块作用域——跟踪 `myIsHost`；对局期收到 `phase=LOBBY`（N39-a 房主 `start`→FINISHED→LOBBY 广播）→ 停快照发布 + `match.destroy()` + 按新 room_state 重建大厅；`lobbyHandlers` 提取复用；`match_end` 转全量 msg；下一局入口发送 `start`（§7.2 C→S 白名单零改动）。
- `src/styles/multiplayer.css`：`#mp-results{pointer-events:auto}`（overlay-root 全局 none，否则按钮不可点——E2E 首跑教训）+ `#mp-results[hidden]{display:none}`（display:flex 覆盖 UA hidden——E2E 二跑教训）。
- 测试：新增 `tests/unit/match-results.test.ts`（9 用例，正+反）、`tests/e2e/mp-results.spec.ts`（双人局真实 topout→只剩 1 人即时结束→两端结果文案逐字一致→榜单「已淘汰」→房主专属下一局→回大厅房间码不变→再准备再开局闭环）；`playwright.config.ts` testMatch 加 `mp-results`；mp-lobby/mp-layout/mp-boards 状态行断言 `toHaveText`→`toContainText`（状态行现含剩余时间）；lobby.test/match.test 钉死正则适配。

## 门禁结果（见本目录原始输出）
| 门禁 | 结果 |
| --- | --- |
| root vitest | 26 文件 / 388 通过（+1 文件 +10 用例） |
| root tsc | 0 错误 |
| build | mp chunk 32.77 kB（+2.01 kB 结果组件）；index 36.08 kB 不变（单人包不受影响）；CSS 11.72 kB |
| worker vitest | 27 文件 / 219 通过（worker 零改动） |
| worker tsc | 0 错误 |
| E2E mp 组（worker 8787 在跑） | 9 通过（mp-lobby 4 + mp-layout 3 + mp-boards 1 + mp-results 1） |
| E2E 全量（无 worker） | 15 通过 / 9 跳过（mp-results 加入跳过组） |

## 验收对照（任务清单 N39）
- 明确展示 600 秒剩余：E2E 断言 `/比赛进行中 · 剩余 \d{2}:\d{2}/` 且开局 3 秒内 `剩余 (09:5[7-9]|10:00)`；单测钉 `formatRemaining(MATCH_DURATION_MS)==='10:00'`。
- 已淘汰：E2E 断言淘汰方榜单状态列「已淘汰」；状态行「你已淘汰，等待比赛结束」由服务端榜单驱动（单测钉死）。
- 获胜/并列 + 得分榜与独立胜负信息：E2E 两端 `.mp-results-title`/`.mp-results-winners` 逐字一致（`比赛结束`/`胜者：host01`）+ `.lb-winners` 横幅与榜单行序分离（N37 语义保持）。
- 只允许房主启动下一局：guest 端 `#mp-next-round` count=0；guest 发 `start` 由服务端 N39-a 裁决 NOT_HOST（worker 测试已覆盖）。
- 只剩 1 人即时结束：E2E 真实 topout→match_end survival 两端 10s 内出现结果面板。
- 600 秒超时同结果：服务端 Alarm 单一裁决源 + 单一 `match_end` 广播（worker 测试覆盖）；客户端消费同一条消息渲染同一文案（E2E 以 survival 路径验证同文案机制 + 单测钉 `endReasonLabel('timeout')==='时间到'`）。

## 下一局闭环（E2E 实测）
房主点「下一局」→ 服务端 FINISHED→LOBBY 广播 → 两端回大厅（房间码不变、结果面板随 DOM 移除、`matchDebug()===null`）→ 全员重新准备 → 房主再开局 → 两端再次进入「比赛进行中 · 剩余」。

## 复审（独立只读子代理）
结论 **PASS**：P1×0、P2×2（均已修复后复跑全部门禁）、O×7。独立复跑 root 26/388、tsc 0，证据文件逐项核对一致；§0 口径（逻辑 3 文件 ≈250 行）达标。
- **P2-1 终局冻结**：`match_end` 后本人引擎仍在步进、键盘/触屏仍可操作死局棋盘、快照 5Hz 空转上行。修复：multiplayer `case 'match_end'` 先 `stopSnapshotPublishing()`；match.ts `frame()` 在 `ended` 后跳过 `engine.step` 与节奏 update、开局门加 `!ended`；`applyMatchEnd` 内 `releaseInputs()+keyboard.dispose()+touch.dispose()`（dispose 幂等）。单测钉死三处。
- **P2-2 isHost 实时化**：`bootMatch` 的 `ui.isHost` 由布尔快照改为 getter（`() => myIsHost`），`results.show` 在 match_end 时刻读实时值——房主局中离开触发转让后，新房主结果面板仍出现「下一局」按钮。
- O 项转 N40/记录：对局期 error 静默丢弃（O-1）；mp-mode 类回大厅残留（O-3）；极端短局「本局无胜者」理论边界（O-4）；断线错过 match_end 后 FINISHED 重连界面停滞（O-7，归 N40 断线恢复语义）。
