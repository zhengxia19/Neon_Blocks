# N39-a 下一局触发（服务端 WS 分派）证据

## 范围与设计决策
- 任务清单 N39「只允许房主启动下一局」的服务端触发通道（客户端 UI 属 N39-b）。
- **设计决策：复用 `start` 消息承载下一局语义，不新增 `next_round` 类型。**
  已批准方案 §7.2 的 C→S 白名单为封闭枚举（`ready/start/settings_update/snapshot/gameover/leave/ping`），
  且 `tests/unit/protocol.test.ts` 钉死「消息类型白名单与已批准方案 §7.2 完全一致」。
  新增消息类型将偏离唯一实施依据；复用 `start` 由服务端按房间阶段裁决语义（FINISHED→下一局，
  LOBBY→常规开局），与既有「服务端裁决」原则一致，协议契约测试保持全绿。
- 分派点：`worker/src/room.ts` WS `case 'start'` 前置分支——`#readConfig().state === 'FINISHED'`
  时调用 `nextRound(att.playerId)`：成功 → `#sendRoomState()`（LOBBY、matchId 清空、准备清零）；
  失败 → 定向 error（非房主 `NOT_HOST`；竞态 `BAD_STATE` 映射目录内 `NOT_IN_GAME`，目录不新增码）。
- 逻辑文件仅 1 个（room.ts），符合 §0 拆分规则。

## 变更
- `worker/src/room.ts`：`case 'start'` 增加 FINISHED 阶段下一局分支（含中文注释）。
- `worker/test/room-next-round.test.ts`（新增，3 用例）：
  - 正向：终局后房主 `start` → 全员收到 room_state（LOBBY、matchId/startAt/deadlineAt 清空、
    ready=false、status=lobby；同 revision 同内容）；下一局可再准备；回到 LOBBY 后 `start`
    恢复常规开局门槛（NOT_READY）。
  - 反向：终局阶段非房主 `start` → error `NOT_HOST`（中文目录文案），状态保持 FINISHED。
  - 反向：下一局成功回到 LOBBY 后再次 `start` 不会重复清场（准备状态保留、仅 1 条 error）。

## 门禁（原始输出见本目录）
| 门禁 | 结果 |
| --- | --- |
| root vitest | 25 文件 / 378 通过（root-vitest.txt） |
| root tsc | 0 错误（root-tsc.txt） |
| vite build | 成功；mp chunk 30.76 kB、index 36.08 kB、CSS 11.31 kB 不变（build.txt） |
| worker vitest | 27 文件 / 219 通过（+1 文件 +3 用例）（worker-vitest.txt） |
| worker tsc | 0 错误（worker-tsc.txt） |
| E2E mp 组（worker 8787 在跑） | 8 通过（e2e-mp-with-worker.txt） |
| E2E 全量（无 worker） | 15 通过 / 8 跳过（e2e-full-no-worker.txt） |

## 复审
独立只读复审 **PASS**（P1×0、P2×0、O×4）。复跑数字与证据逐项吻合（root 25/378、worker 27/219、tsc 0/0、build 哈希一致→客户端零改动得证）。
设计决策结论：(a) 复用 `start` 合理——§7.2 白名单封闭枚举且协议契约测试钉死，新增类型将偏离唯一实施依据；(b) 无语义漏洞——COUNTDOWN/RUNNING 行为不变、双发 `start` 幂等安全（第二次落 LOBBY 路径 NOT_READY）、stale attachment→UNAUTHORIZED / 释放→ROOM_NOT_FOUND 目录内直传、FINISHED 阶段 guest 发 `start` 错误码由 GAME_STARTED 变为更准确的 NOT_HOST（预期新语义）。
观察处理：O-1 N36 截图被 E2E 复跑覆写→`git checkout` 还原不入本次提交；O-2 临时日志草稿追加后删除；O-3 `BAD_STATE→NOT_IN_GAME` 无单测（复审证实同步段内 WS 路径不可达，纯防御，可接受）；O-4 N39-b 结果面板「下一局」按钮仅房主可见。
