# N41 证据：单机回归 + 2～6 人功能矩阵

> 任务清单 N41：单机全量四项命令 + E2E；联网分别完成 2、3、4、5、6 人建房、准备、观战、排行榜、开赛/结算、离房。
> 基线提交 `ecf118f`（G3）。改动范围：仅测试与配置（`tests/e2e/mp-matrix.spec.ts` 新增、`playwright.config.ts` testMatch +mp-matrix），逻辑文件 0 个。

## 单机全量四项命令（清单 §0-7）
| 命令 | 结果 | 用时 |
| --- | --- | --- |
| `npm ci` | 退出码 0 | 2.9s |
| `npm run typecheck` | 0 错误 | 1.9s |
| `npm run test` | 27 文件 / 412 通过 | 2.2s |
| `npm run build` | 退出码 0 | 2.3s |

## E2E
- **mp 功能矩阵（worker 8787 在跑，`--workers=2`）**：`npx playwright test mp-lobby mp-layout mp-boards mp-results mp-resilience mp-matrix --project=chromium --workers=2` ⇒ **17 通过**（Playwright 自报 57.4s；包装计时 59.1s 含 webServer 启动）。其中 mp-matrix 5 条（2/3/4/5/6 人）各 6～10s。
  - 负载说明：默认 workers（5 矩阵并发 + resilience）下，mp-resilience 刷新重建用例的首帧 10s 窗口偶发超时（6 房间挤占单 workerd 进程）；单独复跑通过，`--workers=2` 稳定 17/17。已在 spec 头部注释记录。
  - 证据重生成：spec 头部注释（3 行）补加后已重跑两份 E2E，txt 内行号与提交文件一致（mp-matrix.spec.ts:85:5）。
- **全量（无 worker，8787 无监听）**：`npx playwright test` ⇒ **15 通过 / 17 跳过**（mp 组含新增 mp-matrix 5 条按 workerUp 守卫跳过，6.6s）。

## 功能矩阵覆盖（每人数一条用例，p∈{2,3,4,5,6}）
| 清单环节 | 断言 |
| --- | --- |
| 建房 | 房主 `#mp-capacity` 调至 p + `#mp-apply-settings`；访客端只读同步 `toHaveValue(p)` |
| 加入 | p−1 访客加入；房主 `#mp-seat-list .mp-seat` 计数 = p |
| 准备 | readyAll（补点守卫）→ 房主 `#mp-start` 启用 |
| 开赛 | 全员 `#mp-match-status` 「比赛进行中」 |
| 双棋盘 | 每端严格 2 个 Canvas（对局中、结算面板在场时各查一次） |
| 排行榜 | p 行、全员逐端名单完全一致（并列按加入顺序 host01,guest02…，客户端绝不重排） |
| 观战 | 每端 `#opponent-name` ∈ 其他昵称（≠本人）；`matchDebug().remoteSeq` 5s 内 >0（收到目标快照帧） |
| 结算 | 全部访客 40 次硬降 topout→gameover→只剩房主即时结束；全员 `#mp-results` 可见、标题全等「比赛结束」、胜者全等「胜者：host01」；访客行状态「已淘汰」、房主行非淘汰 |
| 下一局 | `#mp-next-round` 房主专属（访客端不存在）；全员回大厅、房间码不变、对局句柄 null |
| 离房 | guest02 确认离开 ⇒ 回入口面板；房主席位 p−1、房间码不变 |

## 截图（房主端结果面板）
`shot-matrix-2.png` ～ `shot-matrix-6.png`（矩阵用例内 `page.screenshot` 直存本目录）。

## 验收对照
- 没有单机退化：四项命令全绿 + 全量 E2E 15 通过（单机 desktop/smoke/mobile 全绿）。
- 名单相同且始终双棋盘：全员逐端榜单逐行一致 + 每端严格 2 Canvas（对局与结算两时点）。
- 测试结果附命令、时间和截屏：本目录原始输出含退出码与用时，截图 5 张。

## 复审（独立只读子代理）
结论 **PASS（P1×1 提交前必做、P2×1、O×6）**；复审复跑：root vitest 27/412、tsc 0、worker 27/219、无 worker 全量 15/17 跳过（mp-matrix 全跳过、mobile 不受影响）。
- **P1（已处理）**：N41 证据跑重跑 mp-layout 覆盖 N36 三张截图 ⇒ 提交前 `git checkout -- evidence/multiplayer/N36/` 还原。
- **P2（已处理）**：证据 txt 行号（:82:5）与补注释后 spec（:85:5）不一致 ⇒ 已重跑重生成两份 E2E txt（行号一致）。
- **O 项（记录）**：① 容量 apply（WS）与访客 join（HTTP）无到达顺序保证，p=5/6 理论窄竞态可致 ROOM_FULL（实测 5/5 过，窗口极窄）；② 容量同步仅断言最后一名访客（只读语义 N33 已覆盖）；③ 观战断言取广度、切换/补帧深度由 N38 钉住；④ 双棋盘为两时点抽查；⑤ 计时口径（包装 vs Playwright 自报）已注明；⑥ shot-matrix-6.png 榜单分数分布经放大核验与 leaderboard.ts 排序及「淘汰分数冻结」语义完全一致，非缺陷。
- 断言可证伪性、时序（40 次硬降撞顶下界 24 次、p=6 200 键 ≈5s ≪ 150s）、`td nth(4)` 五列核对、范围合规（逻辑文件 0）均通过。
