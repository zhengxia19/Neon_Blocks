# N33 证据：房主设置与等待大厅

## 验收命令与结果（原始输出见本目录）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 根单测 | `npx vitest run` | 20 文件 / 337 通过（含新增 `tests/unit/lobby.test.ts` 8 例、`net-client.test.ts` 回归 1 例）→ `root-vitest.txt` |
| 根类型 | `npx tsc --noEmit -p tsconfig.json` | 0 错误 → `root-tsc.txt` |
| 构建 | `npm run build` | 成功（multiplayer 动态分包）→ `build.txt` |
| Worker 单测 | `cd worker; npx vitest run` | 26 文件 / 216 通过（含新增 `worker/test/room-lobby.test.ts` 11 例）→ `worker-vitest.txt` |
| Worker 类型 | `cd worker; npx tsc --noEmit -p tsconfig.json` | 0 错误 → `worker-tsc.txt` |
| E2E 全量（无 Worker） | `npx playwright test` | 15 通过 / 3 跳过（mp-lobby 探测 8787 未运行自动跳过）→ `e2e-full-no-worker.txt` |
| E2E 大厅（本机 Worker） | `npx wrangler dev --port 8787 --var ALLOW_DEV_ORIGINS:true` + `npx playwright test tests/e2e/mp-lobby.spec.ts` | 3 通过 → `e2e-lobby-live-worker.txt` |

## 关键断言（正/负）
- 正向：首帧 `room_state` 全量席位视图；`ready`/`settings_update`/`start`/`leave` 后双端收到一致 `room_state`；房主改容量/随机模式/初始等级 → 访客只读同步；设置变更重置全员 ready；开局后 phase=COUNTDOWN（E2E 断言"即将开始/比赛进行中"）。
- 负向：非房主 `settings_update` → `NOT_HOST`；`startLevel=11` → `BAD_LEVEL`（信封校验先行）；容量低于已占席位 → `CAPACITY_BELOW_SEATS`；人数不足/未全员准备/非房主 `start` → `NOT_ENOUGH_PLAYERS`/`NOT_READY`/`NOT_HOST`；开局后 `settings_update` → `GAME_STARTED`；离房者再 `ready` → `UNAUTHORIZED`。

## 环境说明
- 本机 `wrangler dev` 需 `--var ALLOW_DEV_ORIGINS:true` 才放行 127.0.0.1:4173 来源（wrangler.jsonc vars 不含该变量，仅 `cors.ts` 读取 env 合并 DEV_ORIGINS）。
- 修复回归：`NetClient.#post` 以 `this.#fetch(...)` 方法形式调用浏览器 fetch 触发 `Illegal invocation`（node undici 无此限制故单测未暴露），改为 `this.#fetch.call(null, …)`，并在 `net-client.test.ts` 增加源码级回归断言。
- E2E 大厅用例等待首帧 `room_state` 填充房间码后再读取（`toHaveText(/^[1-9]\d{5}$/)`），避免竞态读到空码。
- 复审 P2 修复：`attachWebSocket` 首帧改走 `#sendRoomState()` 全量广播——重连接管时其他席位即时摆脱「连接中断」陈旧标记；新增用例「重连接管 → 其他席位即时收到 room_state 刷新」（room-lobby 10→11 例，worker 215→216）。
