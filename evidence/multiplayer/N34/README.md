# N34 证据 — 联网本地比赛初始化与时钟

提交：见 `docs/multiplayer-execution-log.md` N34 条目（feat(N34)）。

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| root-vitest.txt | 根 Vitest 全量 | 21 文件 / 346 例全过（新增 match.test.ts 9 例） |
| root-tsc.txt | 根 tsc --noEmit | ROOT_TSC_EXIT=0 |
| build.txt | vite build | BUILD_EXIT=0，multiplayer chunk 20.24 kB |
| worker-vitest.txt | Worker Vitest 全量（服务端未改动） | 26 文件 / 216 例全过 |
| worker-tsc.txt | Worker tsc --noEmit | WORKER_TSC_EXIT=0 |
| e2e-lobby-live-worker.txt | mp-lobby（chromium，wrangler 8787 实时） | 4 passed（含 N34 开局装配用例） |
| e2e-full-no-worker.txt | 全量 E2E（8787 空闲，mp-lobby 组自动跳过） | 15 passed / 4 skipped |

## 关键断言
- 服务器墙钟：`computeClockOffset(serverTime, clientNow)`；开局判定 `wallNow()+offset >= startAt`（不依赖 rAF 可见帧计数）。
- 预倒计时：`countdown.startAt` → `#mp-pre-countdown`（校准墙钟 200ms tick）；`match_start` 到点装配对局。
- 后台冻结防护：`clampFrameDelta` 单帧封顶 250ms；visibilitychange/blur 只释放输入不暂停。
- 个人暂停禁用：`#btn-pause` hidden+disabled；Esc/Enter 空操作；源码级断言无 `togglePause(`/`.restart(`。
- 种子/等级：`new GameEngine(createSeededRng(match.seatSeed), undefined, match.startLevel)`。
- 单人不受影响：main.ts 单人分支仍 `boot(appRoot)`；engine.ts 构造签名未变。

## 环境备注
- wrangler dev 需 `--var ALLOW_DEV_ORIGINS:true`；`TEMP/TMP` 指向 `worker\.tmp`；`WRANGLER_SEND_METRICS=false`。
- 服务端 `match_start` 在 `startAt` 到点才广播（N17 设计）：装配时倒计时已走完，match.ts 首帧即切「比赛进行中」；3-2-1 展示由大厅阶段预倒计时承担。
- 全量 E2E 前须确认 4173/8787 空闲（mp-entry 降级用例要求 8787 不可达）。
