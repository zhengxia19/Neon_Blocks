# N40-a 证据：失焦/刷新语义（对局冻结、刷新重建、自动重连）

> N40 因触及 4 个逻辑文件（+NetClient 断网容错）按 §0 拆分为 N40-a/N40-b（用户已确认）。
> N40-a：失焦/刷新语义（conn-overlay + match 冻结 + multiplayer 装配）；N40-b：NetClient 断网容错 + 断网遮罩 E2E。

## 范围
- 新增 `src/ui/conn-overlay.ts`：对局期连接中断遮罩（`#mp-conn-overlay`，role=status，纯 DOM：无网络/计时器/墙钟；`show()` 时若节点已脱离文档则重新挂载——`mountMultiplayerLayout` 会重建 root 子树，E2E 首跑教训；复审 P2-1：`destroy()` 后 `show()` 空操作，防 teardown 异步 onClose 复活僵尸遮罩）。
- `src/app/match.ts`：`MatchHandle` 增 `setFrozen(frozen)`/`applyRoomFinished()`；`frozen` 时输入五路（move/softDrop/rotate/hardDrop/hold）经 `inputLive()` 门全部失效、`frame()` 跳过节奏 update/开局门/`engine.step`、状态行保留「连接中断，比赛仍在服务器进行……」（状态块门 `!frozen && !ended`）；解冻时 `releaseInputs()+keyboard.attach(window)+lastFrameMs=performance.now()` 防按键连发/时间跳变；`applyRoomFinished()` 终局兜底（断线错过 `match_end` 后重连见 `phase=FINISHED`）。联网对局本就无个人暂停（`togglePause` 零引用钉死）。
  - 复审 P1 修复：`adoptWatchTarget` + `applyRemoteSnapshot` 无目标时首帧采纳——刷新重建后服务端不补发 `watch_target`（订阅映射跨断线存活、仅「目标改变」补发，room.ts:2362/2422），但 `remote_snapshot` 已按服务端映射路由到正确观看者 ⇒ 以首帧采纳目标并复位水位（自愈、无需缓存、无 3-4 人局断线期间目标切换的错位问题）。
- `src/app/multiplayer.ts`：`MATCH_CACHE_KEY`（match_start 载荷）与 `SNAP_CACHE_KEY`（快照 seq 高水位）sessionStorage 缓存（服务端 attach 只推 room_state 不重发 match_start、seq 按 playerId 高水位拒收 ⇒ 刷新重建两要素）；`room_state` 四分支（对局期收到 LOBBY→拆局回大厅；`match===null` 且非 LOBBY 且缓存 matchId 相符→重建对局（FINISHED 则 `applyRoomFinished`）；对局期 FINISHED→终局兜底；否则 `lobby.update`；复审 P2-2：RUNNING 但无本人对局缓存（断线错过 match_start 又开了新局）⇒ 大厅视图 + 中文提示「比赛进行中，未能恢复本局棋盘；本局结束后自动返回大厅。」）；`onOpen` 解冻+隐藏遮罩；`onClose` 冻结+遮罩（willReconnect 文案区分）；`onFatal` 冻结+遮罩；boot 时 `loadCredential` 自动重连（大厅/对局同一路径）；`enterLobby` connect 异常兜底 + 失败清缓存；leave 清缓存+隐藏遮罩；teardown destroy 遮罩。
- `src/styles/multiplayer.css`：`#mp-conn-overlay`（fixed 全屏）+ `#mp-conn-overlay[hidden]{display:none}`（display:flex 覆盖 UA 规则教训）。
- 测试：新增 `tests/unit/mp-resilience.test.ts`（17 用例：遮罩三态+纯 DOM 反向、destroy 空操作门、CSS hidden 规则、冻结门/解冻/终局兜底/首帧采纳目标钉死、onClose/onOpen/FINISHED 分支/缓存读写/seq 续起/RUNNING 无缓存提示/leave 清缓存、单人 blur/visibilitychange 自动暂停不受影响反向钉死）；新增 `tests/e2e/mp-resilience.spec.ts`（2 场景，见下）；`playwright.config.ts` testMatch 加 `mp-resilience`；match.test/match-results.test 钉死正则适配。

## 门禁结果（见本目录原始输出）
| 门禁 | 结果 |
| --- | --- |
| root vitest | 27 文件 / 406 通过（+1 文件 +17 用例） |
| root tsc | 0 错误 |
| build | mp chunk 34.76 kB（+2.0 kB 遮罩/缓存/冻结/首帧采纳）；index 36.08 kB 不变（单人包零影响）；CSS 11.96 kB |
| worker vitest | 27 文件 / 219 通过（worker 零改动） |
| worker tsc | 0 错误 |
| E2E mp 组（worker 8787 在跑） | 11 通过（mp-lobby 4 + mp-layout 3 + mp-boards 1 + mp-results 1 + mp-resilience 2） |
| E2E 全量（无 worker） | 15 通过 / 11 跳过（mp-resilience 加入跳过组） |

## 验收对照（任务清单 N40，失焦/刷新部分）
- 联网禁个人暂停：match.ts 无 `togglePause` 调用（单测 `not.toMatch(/\.togglePause\(/)`）；E2E（N34 既有）断言无暂停按钮。
- 失焦不能停止比赛时钟：E2E `window.dispatchEvent(new Event('blur'))` 后 3 秒内状态行「剩余」照常递减 ≥2 秒。
- 刷新语义（对局期）：guest 刷新 ⇒ 席位凭据自动重连（`.mp-entry-panel` count=0）⇒ 按缓存 match_start 重建（状态行续跑、`matchDebug()` 非 null）⇒ 快照 seq 从 sessionStorage 高水位续起（对手端 `remoteSeq` 3 秒内续增；若归零会被服务端水位拒收，约 6 秒后才恢复——3s 窗口可证伪）⇒ 重建方以首帧采纳观察目标（guest 端对手面板恢复 host01/「比赛中」、guest 的 `remoteSeq`>0；未修复则恒「等待对手…」——复审 P1 回归断言）。
- 刷新语义（大厅期）：刷新后直接回同房间码大厅，无入口面板；再准备再开局闭环正常。
- 单人仍按原自动暂停：main.ts blur/visibilitychange→`suspendGame` 原样（单测钉死 + 单人包 index 体积不变）。
- 掉线冻结/遮罩/30 秒恢复或淘汰：装配与遮罩已接入（onClose/onOpen/onFatal 单测钉死）；断网 E2E 场景随 N40-b（NetClient fetch-reject 断网容错修复后）验证。

## 关键发现（E2E 排障记录，供 N40-b）
- Chromium `setOffline` 不拆既有 WS 连接（loopback 场景完全无效）⇒ 断网注入需应用侧 `debugDropSocket`。
- workerd Hibernation 不回显 close 帧：客户端 `ws.close()` 后浏览器 close 事件永不到达（服务端已标记断线、对手榜单已显示「连接中断」）⇒ N40-b 中 `debugDropSocket` 需手动触发 `handleClose(1006)`。
- NetClient 重连链在票据 fetch **reject**（非 HTTP 失败）时中断：`#openWithTicket` 未捕获 fetch 异常 ⇒ 首个退避尝试失败后不再重试（N40-b 修复 + 单测钉死）。

## 复审（独立只读子代理）
首轮结论 **FAIL（P1×1，P2×3，O×6）**，§0 口径通过（3 逻辑文件、247 逻辑行 ≤300、CSS 另计、§7.2 白名单/`src/game/`/`src/main.ts`/worker 零改动）。全部 P1/P2 已修复并复跑门禁全绿：
- **P1** 刷新重建对局收不到 `watch_target` ⇒ 对手棋盘/面板整局失效：`applyRemoteSnapshot` 无目标时首帧采纳（`adoptWatchTarget`，含水位复位）；E2E 补 guest 端对手视图断言（P2-3 一并修）。
- **P2-1** teardown 后遮罩僵尸复活：`conn-overlay` destroy 后 `show()` 空操作。
- **P2-2** 断线期间开了新局（RUNNING 无缓存）整局无提示：大厅补中文提示。
- **P2-3** E2E 重言断言删除、补刷新方对手视图断言。
O 项记录（不阻塞，转后续）：刷新后本人分数/消行归零属设计语义（引擎按种子重开，局面不持久化）；onFatal 文案会被随后 onClose 覆盖；KeyP 仍可暂停联网对局本地引擎（既有，`src/input/keyboard.ts`，建议后续任务处理）；开局前冻结时倒计时元素仍刷新（外观）。
