# N38 证据：双棋盘与排行榜连接

## 改动（3 个逻辑文件）
- `src/app/snapshot-source.ts`（新）：引擎状态 → SnapshotPayload 纯函数（board 24×10 字符编码、status 封闭映射 running/gameover）。
- `src/app/match.ts`：RemoteBoard 挂 #opponent-canvas、leaderboard 视图填 #leaderboard-slot；`applyScoreboard/applyWatchTarget/applyRemoteSnapshot/applyMatchEnd/buildSnapshot` 句柄方法；切换目标即 `resetForTarget`（旧目标最后帧保留至补帧）；陈旧目标帧丢弃；resize 透传远程 Canvas；对手面板数据源=同一份服务端榜单。
- `src/app/multiplayer.ts`：match_start 后 250ms 定时发布本人快照（SnapshotPublisher 5Hz 上限、seq 发布计数单调、decodeSnapshot 回对象走 NetClient.send 统一 seq 信封）；gameover 单发（reason=topout，淘汰时刻由服务端接收时刻裁决）；scoreboard/watch_target/remote_snapshot/match_end 接线转发；onOpen/onClose 联动发布通道连接态；leave/teardown 停发布；MultiplayerHandle.matchDebug 诊断。
- 测试：`tests/unit/snapshot-source.test.ts`（新 6 例：编码/映射/真实引擎往返/反向禁项）；`tests/unit/match.test.ts`（+2 例结构正反：接线齐备、match.ts 仍无网络代码）；`tests/e2e/mp-boards.spec.ts`（新，3 人局）；`playwright.config.ts` chromium testMatch 纳入 mp-boards。

## 门禁数字（复审修复后复跑）
- 根 `npx vitest run`：25 文件 / 378 用例全绿（root-vitest.txt）。
- 根 `npx tsc --noEmit`：0 错误（root-tsc.txt，0 字节）。
- `npm run build`：成功；mp chunk 22.43→30.76 kB（组件入包），index JS 36.08 kB 不变（单人零影响）、index CSS 11.31 kB 不变（build.txt）。
- worker `npx vitest run`：26 文件 / 216 用例全绿；`npx tsc --noEmit`：0 错误（worker 零改动）。
- E2E（Worker 8787 运行时）mp-lobby+mp-layout+mp-boards：8 passed（e2e-mp-with-worker.txt）。
- E2E 全量（Worker 关闭）：15 passed / 8 skipped（e2e-full-no-worker.txt；跳过=mp 组 4+3+1）。
- 注：mp-entry 用例语义要求 Worker 关闭（无服务器中文降级路径），全量与 mp 组分开跑为既有口径。

## 复审（独立只读）
判定需修复（P1×1、P2×2、O×5）→ 修复后复跑全绿：
- P1：本任务写执行日志时误整写覆盖 N01–N37 历史（509 行仅剩 9 行）——`git checkout HEAD` 恢复后追加 N38 条目（diff 9 插入/0 删除）。
- P2-1：切到已淘汰目标时 scoreboard→watch_target→补帧顺序下先 `freeze()` 致补帧被 `shouldDraw` 丢弃、Canvas 残留上一目标帧——`syncOpponentPanel` 状态驱动冻结/遮罩延迟到当前目标首帧绘制后（`remoteBoard.state.lastSeq < 0` 即返回；`applyRemoteSnapshot` 绘制成功后补面板同步）。
- P2-2：gameover 断线时 `client.send` 失败仍置 `gameoverSent=true` 永不重发（服务端仅经 gameover 消息裁决淘汰）——send 成功才置位，下一 tick 重试。
- 钉死测试：match.test.ts 新增「复审 N38 P2 修复钉死」例（延迟冻结守卫 + drawn 再同步 + gameover 成功置位正则）。
- 复审复跑数字与证据逐项吻合（root 25/377→修复后 378、worker 26/216、tsc 0/0、build 哈希字节一致、E2E 三组互洽）。

## E2E 断言要点（mp-boards，3 人局 host01/guest02/guest03）
- 正向：每页恰 2 个 Canvas（无第三棋盘）；开局 b/c 初始目标均 host01（同分并列按加入顺序升序）；guest02 硬降得分后 c 目标切至 guest02（端到端 <3s，含服务端 ≤500ms 批次）；b 目标保持 host01（不同观看者不同目标，watchTargetId 互异）；c 切换后 remoteSeq>0（服务器补发目标最后帧）；b/c 榜单逐行一致 `['guest02','host01','guest03']`（得分降序、并列 join 升序，客户端不重排）；本人行高亮各自不同（lb-self）；对手面板分数与榜上 guest02 分数一致（同一数据源）。
- 反向（单测钉死）：陈旧观察目标的 remote_snapshot 丢弃（`targetPlayerId !== watchTargetId` 即 false）；match.ts 无 fetch/WebSocket/NetClient/SnapshotPublisher；snapshot-source 无网络/DOM/时钟。
