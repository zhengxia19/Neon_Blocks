# N40-b 证据：NetClient 断网容错 + 断线注入 + 断网 E2E

> N40 拆分之二（N40-a 见 `evidence/multiplayer/N40-a/`，提交 `7277cca`）。
> N40-b：修复 NetClient 重连链在票据 fetch reject 时中断的缺陷；接入 E2E 断线注入 `debugDropSocket`；兑现 N40 验收「掉线后停止不可信本地操作/进入恢复流程，30 秒恢复或淘汰」的断网/网络恢复场景。

## 范围（逻辑文件 2 个）
- `src/net/client.ts`：
  - **断网容错修复**：`#openWithTicket` 票据 POST 包 try/catch——断网时 fetch 是 **reject（TypeError）**而非非 2xx；修复前 reject 穿出 `#connectNow`，重连定时器 `void this.#connectNow()` 成未处理拒绝，**重连链在首个退避尝试失败后即死亡**（既不重试也见不到 onFatal，遮罩永不消失——E2E 首跑实证）。修复后与既有 P2-3 非 2xx 票据失败路径同构：`#reconnectPending()` ⇒ `#scheduleReconnect()` + `#onClose({code:1006, willReconnect})`，返回目录内 `INTERNAL` fail（零新错误码）。
  - **双保险**：重连定时器回调 `void this.#connectNow()` 改为 `.catch(...)` 兜底任何残余异常（如票据响应体损坏），catch 内按 `#reconnectPending()` 继续退避（`#scheduleReconnect` 的 `#reconnectTimer!==null` 守卫防双重排期）。
  - **debugDropSocket()**：E2E 断线注入（生产路径零调用）——`ws.close(4001,'e2e drop')` 后手动 `#handleClose(ws, 1006)`。
- `src/app/multiplayer.ts`：`MultiplayerHandle` 接口 + 句柄实现 `debugDropSocket()` ⇒ `client.debugDropSocket()`。
- 测试：`tests/unit/mp-resilience.test.ts` +3 用例（fetch-reject 同路径钉死、定时器 catch+debugDropSocket 钉死、装配层暴露+出现点计数反向）；`tests/unit/net-client.test.ts` +3 行为用例（复审 P2-1：FakeWS+fetch reject 替身，见下文复审节）；`tests/e2e/mp-resilience.spec.ts` +断网场景。

## 关键外部事实（排障实证，影响真实世界语义）
- **Chromium `setOffline(true)` 不拆既有 WebSocket 连接**（loopback 场景完全无效）⇒ 断网注入必须应用侧断线。
- **workerd Hibernation 不回显 close 帧**：客户端 `ws.close()` 后服务端真实收到 close（对手榜单显示「连接中断」），但浏览器 `close` 事件永不到达（验证 >10s）⇒ `debugDropSocket` 手动驱动 `#handleClose` 模拟浏览器视角。**真实世界含义**：干净关闭（服务端主动 close）时浏览器能收到 close 帧（回显方向是浏览器栈处理），受影响的是「客户端自发 close 后本地事件」——NetClient 从不依赖自发 close 事件（close()/leave() 主动置 `#ws=null`），无生产缺陷；此事实仅约束测试注入方式。
- **Playwright `route.abort()` 使 fetch REJECT**（TypeError），非返回非 OK——正是暴露 NetClient 缺陷的注入手段。

## 门禁结果（见本目录原始输出）
| 门禁 | 结果 |
| --- | --- |
| root vitest | 27 文件 / 412 通过（+6 用例：mp-resilience 3 + net-client 行为级 3） |
| root tsc | 0 错误 |
| build | mp chunk 35.08 kB（+0.32 kB 容错/debugDropSocket）；index 36.08 kB 不变（单人包零影响）；CSS 11.96 kB 不变 |
| worker vitest | 27 文件 / 219 通过（worker 零改动） |
| worker tsc | 0 错误 |
| E2E mp 组（worker 8787 在跑） | 12 通过（mp-lobby 4 + mp-layout 3 + mp-boards 1 + mp-results 1 + mp-resilience 3） |
| E2E 全量（无 worker） | 15 通过 / 12 跳过 |

## 验收对照（任务清单 N40，断网/网络恢复部分）
- 掉线后停止不可信本地操作：断网 ⇒ `#mp-conn-overlay` 可见（「连接中断，正在自动重连……」）+ 对局冻结（状态行「连接中断，比赛仍在服务器进行……」，棋盘不步进、输入卸载——N40-a 门控，本场景端到端兑现）。
- 进入恢复流程：route 阻断下重连尝试持续退避（500/1000/2000/4000/8000…），8 秒后遮罩仍可见（修复前重连链已死、遮罩永不消失——本断言直接钉死修复）；服务端宽限期标记断线 ⇒ guest 榜单 host01 行状态「连接中断」。
- 30 秒恢复或淘汰：unroute（网络恢复）⇒ 退避 ≤8s 内下一次尝试成功、遮罩消失、状态行续跑、剩余 <590（比赛时钟从未停止）、guest 榜单状态恢复；30 秒宽限淘汰由服务端 Alarm 裁决（worker 测试覆盖，E2E 不等待 30s）。
- 单人仍按原自动暂停：main.ts 零改动（N40-a 钉死，index chunk 36.08 kB 不变）。

## 复审（独立只读子代理）
结论 **PASS（P1×0，P2×1，O×5）**；复审复跑：root vitest 409、tsc 0、mp-resilience E2E 3/3（断网场景 21.2s）。§0 口径核对通过（逻辑文件恰 2、逻辑行 51 ≤300；game/main/worker/shared 对 7277cca 零 diff；白名单零改动；无新错误码）。

- **P2-1（已修）**：核心修复缺行为级单测（仅正则钉形状，CI 无 worker 时该修复零行为验证）。已在 `tests/unit/net-client.test.ts` 补 3 条 FakeWS+fetch 替身行为用例（与既往 P2-3 用例同构）：① 重连期票据 reject ⇒ `state==='reconnecting'`、`closes[1]={1006,willReconnect:true}`、下次退避到点 ctor+1（修复前链死必炸）；② 首连票据 reject ⇒ connect 返回目录内 INTERNAL fail、不建连、不通知 onClose；③ debugDropSocket ⇒ close 帧发出（readyState=3）、onClose 恰一次（事件回显与手动 `#handleClose` 经 `#ws!==ws` 守卫去重）、无连接幂等。`makeFetchImpl` 增加 `reject?: boolean` 忠实模拟断网 fetch reject。修后 root vitest **27 文件/412 通过**、tsc 0（本目录 root-vitest.txt 已重捕）。
- **O 项（不阻塞，记录）**：① catch 路径不查 `#closedIntentionally`——`close()`（非 leave）在票据在途时会在 close 后重排重连至预算耗尽，与既有 P2-3 同构语义、装配层守卫下无实害；② 预算耗尽时 onFatal 文案被随后 onClose 覆盖（N40-a 既有次序，N40-a 复审已记）；③ E2E fatal 边界 t≈23.5s、unroute 实际 t≈9-12s，余量 ~11s，极慢机器可炸——本地门禁级可接受；④ 出现点计数=3 仅钉 multiplayer.ts，全仓零调用靠 grep 证实（本仓正则钉死风格的有意脆弱）；⑤ N36 三张 evidence PNG 因 E2E 重截二进制再生，提交时 `git checkout --` 还原。
