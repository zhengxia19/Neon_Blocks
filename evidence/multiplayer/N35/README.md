# N35 — 独立远程棋盘渲染 证据

| 文件 | 命令 | 结果 |
|---|---|---|
| root-vitest.txt | `npx vitest run`（根） | 22 文件 / 355 例全绿（新增 remote-board.test.ts 9 例） |
| root-tsc.txt | `npx tsc --noEmit -p tsconfig.json` | ROOT_TSC_EXIT=0 |
| build.txt | `npx vite build` | BUILD_EXIT=0 |
| worker-vitest.txt | `worker/` 内 `npx vitest run` | 26 文件 / 216 例全绿（服务端零改动） |
| worker-tsc.txt | `worker/` 内 `npx tsc --noEmit -p tsconfig.json` | WORKER_TSC_EXIT=0 |
| e2e-full-no-worker.txt | `npx playwright test`（8787 空闲） | 15 passed / 4 skipped（mp-lobby 4 例按设计跳过；无回归） |

## 关键断言（tests/unit/remote-board.test.ts，9 例）
- 正向：快照 24×10 解码（字母→类型、`.`→null）、活动块 t/r/x/y→type/rotation/x/y、score/lines/level/status 直通；`active:null` 与 `gameover` 直通；`shouldDraw` 严格递增（-1→0、9→10 绘制）。
- 反向：未知字符按空不炸帧；同 seq/乱序旧帧/冻结后一律不重绘（无新帧不频繁重复绘制）；remote-board.ts 无 `GameEngine`/`SoundManager`/`fetch(`/`WebSocket`/`requestAnimationFrame`/`setInterval`（无远程引擎、无音效、无每帧网络、无自驱循环）。
- 结构：复用 `BoardRenderer`（视觉延续同一格绘制路径与色板）、`ghostEnabled:false`、不接特效层；renderer.ts 新增 `overlayNotice`（小幅抽取，不清底帧）；断线叠加「同步中断」一次、新快照到达即清除。
- 复审 P2 修复断言：`resetForTarget()` 复位水位/解冻/清断线且不重绘（切换目标不闪白）；`resize()` 透传后按缓存 `#lastView` 重绘最后画面、断线态重贴遮罩。

## 语义要点
- `freeze()`：淘汰者冻结最后画面，此后任何快照不重绘。
- `setDisconnected()`：幂等叠加「同步中断」遮罩（不残影假画面）。
- `resetForTarget()`：切换观察目标/新一局复位（seq 水位、冻结、断线态），不清 Canvas——旧目标最后画面保留至新目标首帧（服务器切换即补发），避免闪白。
- `resize()`：响应式尺寸变化透传后重绘最后画面（`#lastView` 缓存），断线态重贴遮罩。
- 初始空帧：底色+网格，等待首帧快照。
- E2E 连接与双棋盘装配属 N38（本任务仅组件+单测，符合清单范围）。
