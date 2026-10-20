# 联网对战改造执行日志（N01–N44）

依据：`docs/联网对战改造方案_v1.2.md`、`docs/联网对战原子任务清单_v1.1.md`、`docs/联网对战实施题词.md`。
每项记录：任务编号 / 基线 SHA / 改动文件 / 实际命令与退出码 / 测试证据 / 复审结论 / 未解决事项。
原始命令输出存 `evidence/multiplayer/Nxx/`。

---

## N01 — 基线取证（只读）✅ PASS

- **基线 HEAD**：`83c04a88f6ae32c9edc9d59b263061cb314fdb8b`（分支 `main`，与 `origin/main` 同步，工作树干净）
- **环境**：Windows / node v24.18.1 / npm 11.16.0 / git 2.49.0
- **GitHub Pages 工作流**：`.github/workflows/deploy.yml` 未改动，SHA-256 `5A08B00947692407CB4849FB94CD5337A3D02B93D375F73536CD3A42B686437A`
- **改动文件**：无（仅新增本日志与 `evidence/multiplayer/N01/`）
- **命令与退出码**：
  - `npm ci` → 0（`evidence/multiplayer/N01/npm-ci.log`）
  - `npm run typecheck` → 0（`typecheck.log`）
  - `npm run test` → 0：**9 个测试文件 / 229 个单元测试全部通过**（`test.log`）
  - `npm run build` → 0：`dist/index.html` 0.48 kB、CSS 7.76 kB、JS 33.39 kB（`build.log`）
  - `npm run test:e2e` → 0：**7 个 Playwright 用例通过**（chromium + mobile-chrome，`e2e.log`）
- **单机功能现状**：单人模式（键盘/触屏、暂停、重开、设置持久化、320/390px 无溢出）全部通过既有 E2E。
- **复审结论**：基线可复现，四项命令与 E2E 全绿，无失败项需归因；进入 P0 后续任务的前置条件满足。
- **未解决事项**：无。

---

## N02 — 建立网络模块目录与构建边界 ✅ PASS

- **基线 HEAD**：`ea0127e`（N01 之后）
- **改动文件（3 个逻辑文件 + 2 个测试 + 配置）**：
  - 新增 `shared/protocol.ts`（前后端共享纯常量：`PROTOCOL_VERSION=1`、`PROTOCOL_ID`、`MAX_MESSAGE_BYTES=4096`、房间码/容量/昵称边界）
  - 新增 `src/net/index.ts`（前端网络入口，仅复用 shared 契约；不含 Worker 代码）
  - 新增 `worker/package.json`、`worker/tsconfig.json`、`worker/vitest.config.ts`、`worker/src/index.ts`（独立 package：`@cloudflare/workers-types` / `typescript` / `vitest` / `wrangler` 均为 devDependency，无运行时框架依赖）
  - 新增测试 `tests/unit/net-boundary.test.ts`（4 例）、`worker/test/protocol-boundary.test.ts`（3 例）
  - 修改根 `tsconfig.json`：`include` 加入 `shared`，`exclude` 明确排除 `worker`
- **构建边界结论**：前端与 Worker 通过同一份 `shared/` 源码编译（前端 `tsc -b` + Vite；Worker 独立 `tsc -p` + Wrangler/esbuild）；Worker 依赖只存在于 `worker/` 子 package，根 `npm ci` 与 Pages 构建不受影响。
- **命令与退出码**：
  - `npm install`（worker 目录）→ 0；`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0（**3 例通过**）
  - `npm run typecheck` → 0；`npm run test` → 0：**10 文件 / 233 例通过**（新增 4 例边界断言）；`npm run build` → 0，产物 JS 仍为 33.39 kB（未引入网络代码）
  - 产物扫描：`dist/assets/*.js` 中无 `DurableObject` / `ExportedHandler` / `ROOM_DO` 标记
- **复审结论**：前端原构建正常、shared 可被前端单独 typecheck、`src/game/` 无 net/worker 依赖、shared 无 DOM/Worker API；Worker 独立编译已在本地验证，其 DO 绑定与 Wrangler 本地模拟留待 N08。`.github/workflows/deploy.yml` 未改动。
- **未解决事项**：Worker 的 `wrangler.jsonc` 与 DO 绑定尚未创建（属 N08 范围）。

---

## N03 — 锁定协议与错误码 ✅ PASS

- **基线 HEAD**：`d68c0a8`
- **改动文件（2 个逻辑文件 + 2 个测试）**：`shared/protocol.ts`（扩展为完整契约）、`shared/errors.ts`（新增）、`tests/unit/protocol.test.ts`（新增 10 例）、`worker/test/protocol-boundary.test.ts`（+1 例）、`src/net/index.ts`（仅补充再导出）
- **协议要点**：`v/type/seq/revision/roomGeneration` 全部固定；C→S 白名单 `ready|start|settings_update|snapshot|gameover|leave|ping`，S→C 白名单 `room_state|player_joined|player_left|countdown|match_start|scoreboard|watch_target|remote_snapshot|match_end|error|pong`（与方案 §7.2 逐字一致，测试断言）；快照模型含 24×10 棋盘（24 行 × 10 字符）、活动块、得分、消行、等级、状态、`seq`；HTTP 模型 `CreateRoomRequest/JoinRoomRequest/SeatGrantedResponse/TicketResponse/HealthResponse`；机密 `seatToken` 只在创建/加入响应出现一次，`playerId` 为可公开的内部席位 ID，`nickname` 为公开显示名。
- **兼容/拒绝策略（前后端一致）**：版本必须精确等于 1，否则 `error(PROTOCOL_VERSION)` + WS 1002 关闭；未知 `type` → `error(UNKNOWN_TYPE)` 忽略不断连；客户端携带 `FORBIDDEN_CLIENT_FIELDS`（`seatToken/ticket/playerId/matchId/winners/eliminatedAt/serverTime/revision/generation/seed/…`）→ `error(FORBIDDEN_FIELD)` 整条拒绝；未声明扩展字段按白名单丢弃。
- **错误码**：30 个中文错误码目录 `ERROR_CATALOG`（协议/参数/房间席位/状态机/服务端五类），`describeError` 对未知码统一回退 `INTERNAL`，不外泄内部文本。
- **命令与退出码**：`npm run typecheck` → 0；`npm run test` → 0（**11 文件 / 243 例**，新增 10 例：全消息序列化往返、类型白名单、版本判定、非法 JSON 返回 null、未知类型、污染字段、shared 与 `src/game/constants` 棋盘尺寸一致、错误目录完整性与未知码回退）；`npm run build` → 0；`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0（**4 例**，证明 Worker 侧引用同一 `PROTOCOL_VERSION` 与同一错误目录）。
- **复审结论**：前后端引用同一协议版本与同一错误目录（两侧测试各自断言）；协议版本错误、未知类型、服务端禁止字段均有反向断言；`shared/` 保持纯类型/常量，无 DOM/Worker API。
- **未解决事项**：运行时严格校验（昵称/房间码/坐标/字节上限）留待 N04。

---

## N04 — 协议校验与报文体上限 ✅ PASS

- **基线 HEAD**：`6b70ac8`
- **改动文件（1 个逻辑文件 + 2 个测试）**：新增 `shared/validate.ts`；新增 `tests/unit/validate.test.ts`（12 例）；`worker/test/protocol-boundary.test.ts`（+1 例）
- **实现要点**：不使用 `as Type` 代替校验，所有出站对象由校验器重新构造（白名单字段，未知字段丢弃，`__proto__` 污染不生效）；失败返回错误码而非抛异常（`Result<T> = {ok:true,value} | {ok:false,code}`）。
  - 字段校验：昵称 `^[A-Za-z0-9]{1,16}$`；房间码 6 位数字且 100000–999999（字符串或整数输入统一规范化为 6 位字符串）；容量 2–6；等级 1–10；模式 S1/S2/S3；S3 必须带 1–32 位字母数字种子、S1/S2 必须不带；棋盘严格 24 行 × 每行 10 字符且字符仅 `.`/`IOTSZJL`；活动块 `t/r/x/y` 类型与宽松坐标边界（-4..宽+3 / -4..高+3）；`score/lines/level/seq` 整数范围；快照状态仅 `running|gameover`。
  - 报文上限：`utf8ByteLength` + `withinMessageLimit`（4 KiB 硬上限，按 UTF-8 原始字节）。
  - 凭据区分：`seatToken`（机密，`^[A-Za-z0-9_-]{32,128}$`，失败 `UNAUTHORIZED`）与一次性 `ticket`（`{16,128}`，失败 `TOKEN_EXPIRED`）与公开消息分离。
  - 客户端消息校验顺序：版本 → 类型白名单 → 禁止字段（`FORBIDDEN_FIELD`）→ `seq` → 各类型专属字段。
- **命令与退出码**：`npm run typecheck` → 0；`npm run test` → 0（**12 文件 / 255 例**，新增 12 例含合法/非法/超限/污染四类）；`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0（**5 例**，Worker 侧复用同一校验器）。
- **复审结论**：正向断言（全部合法组合、白名单重建、4 KiB 内快照）与反向断言（17 字符昵称、`099999`、容量 1/7/2.5、等级 0/11、`S4`、23 行棋盘、行长 9、非法字符 `X`、坐标 99、`status:'paused'`、负分、`seq:1.5`、版本 0、`type:'chat'`、`winners`/`playerId` 污染、缺 `seq`、`NaN` clientTime、`undefined/null/[]/42/'string'` 均不抛异常）全部通过；无未处理异常路径。
- **未解决事项**：服务端消息（S→C）的客户端侧轻量校验在 N31 接入时补充。

---

## N05 — 种子随机算法金样本 ✅ PASS

- **基线 HEAD**：`1e6cb12`
- **改动文件（1 个逻辑文件 + 1 个测试）**：新增 `src/game/seeded-rng.ts`、`tests/unit/seeded-rng.test.ts`（8 例）
- **算法（版本 `xorshift32-bag7-v1`，与协议 `RngAlgo` 同步）**：
  - PRNG：xorshift32（`state ^= state<<13 / >>>17 / <<5`，`>>>0` 保持无符号），输出 `[0,1)`。
  - 种子归一化：`Math.trunc` → `% 2^32` → `>>>0`；0 替换为 `0x9E3779B9`（xorshift32 禁止零状态）。
  - UTF-8 稳定哈希：FNV-1a 32 位 + finalizer（`0x7feb352d`/`0x846ca68b`），用于 S3 房主自定义种子。
  - 席位派生（S2）：`base ^ imul(seatIndex,0x9E3779B9)` 后经 murmur 风格 finalizer；`seatSeedFor` 使 S1/S3 全员同序列、S2 按席位派生。
  - 出块仍复用既有 `newBag/drawFromBag` 的 7-bag 规则，未更换随机出块规则。
- **金样本（写入测试断言）**：`seed=12345` 前 100 枚方块序列；`seed=0` 前 14 枚；`hashUtf8ToSeed('abc123')=793982812`、`('中文种子')=3880579551`、`('')=1947474976`；`deriveSeatSeed(987654321, 1..6)=[4186254358,2455252008,2706828453,3026961813,2021123199,3029152338]`；`createSeededRng(1)` 前 5 个浮点值。
- **命令与退出码**：`npm run typecheck` → 0；`npm run test` → 0（**13 文件 / 263 例**，新增 8 例）；`npm run build` → 0（产物 33.39 kB 未变，说明未影响单机包）。
- **复审结论**：正向（金样本、重复执行一致、每 7 枚恰为 7 种各一次、S1/S3 同种子同序列、S2 六席位互异）与反向（不同种子序列不同、`seatIndex=0/1.5` 抛 `RangeError`、`count=-1` 抛错、种子 0 不退化为常数）均通过；`src/game/` 仍无网络/DOM 依赖（`import type` 编译期擦除），既有 `random.test.ts` 10 例不变。
- **未解决事项**：引擎尚未接入种子（属 N06/N34 范围）。

---

## N06 — 可配置起始等级 ✅ PASS

- **基线 HEAD**：`8316163`（N05 之后）
- **改动文件（2 个逻辑文件 + 1 个测试）**：`src/game/engine.ts`（构造第三参 `startLevel=1`、私有 `#startLevel`、只读 getter、初值/restart 沿用、`#settleClear` 传起始等级）、`src/game/scoring.ts`（`levelForLines(totalLines, startLevel=1)` = `startLevel + floor(lines/10)`，非法起始等级抛 `RangeError`）、新增 `tests/unit/start-level.test.ts`（8 例）
- **兼容性**：原两参构造调用完全不变（单机默认 1 级）；旧 `engine.test.ts` 70 例全过；测试逐字复现旧断言 `[836,4,1]`。联网范围 1–10 由协议层 `validateStartLevel`（N04）保证，引擎层仅校验 ≥1 整数（升级后等级可 >10，不设硬上限）。
- **测试要点**：1/5/10 级重力表（900/420/170，含 11 级=145、30 级=60 底线）；引擎下落按 `MAX_STEP_MS=100` 截断语义以 ≤100ms 步进累计（4×100ms 不动、+20ms 恰 420ms 下移；10 级 100+70=170ms 恰触发）；消行升级至 12 行→`startLevel+1` 且该次得分按清行前等级结算（`delta=36+800*5` 决定性断言）；restart 保留起始等级；非法值 0/-3/2.5/NaN 反向断言。
- **过程说明**：首跑 2 失败均为新写用例自身笔误（`floor(25/10)=2` 期望误写 8；`step(419)` 被 100ms 截断致累计不足），修正测试期望与步进设计，实现未改动。
- **命令与退出码**：`npm run test` → 0（**14 文件 / 271 例**，新增 8 例）；`npm run typecheck` → 0；`npm run build` → 0（产物 JS 33.66 kB，未引入网络代码）。证据 `evidence/multiplayer/N06/{test,typecheck,build}.txt`。
- **复审结论**：独立复审 PASS——改动范围无越界（deploy.yml/ui/net/shared 未动，`src/game/` 无网络/DOM 依赖）；构造兼容、公式、清行前等级结算顺序、restart 保留、非法值拒绝、协议层 1–10 校验齐备；断言无弱化。
- **未解决事项**：无。

---

## N07 — 网络与单机装配隔离 ✅ PASS

- **基线 HEAD**：`097eab7`（N06 之后）
- **改动文件（3 个逻辑文件 + 2 个测试）**：新增 `src/app/mode.ts`（`resolveAppMode` 纯函数）、`src/app/multiplayer.ts`（联网装配最小占位）、`tests/unit/mode.test.ts`（4 例）；修改 `src/main.ts`（启动分流 + teardown 追加，boot() 函数体逐字未变）、`tests/unit/net-boundary.test.ts`（+3 边界用例）
- **分流规则（配置模式）**：仅当 `?mode=multiplayer`（大小写不敏感）**且** 构建期 `VITE_MULTIPLAYER_API_URL` 非空才进入联网装配；任一条件不满足或非法输入一律安全回退单机（不抛异常）。GitHub Pages 现网未配置该变量 → 行为与 N06 前完全一致。
- **隔离机制**：main.ts 对 `./app/multiplayer` 仅 `import type` + 动态 `import()`；build 产物出现独立 chunk `multiplayer-*.js`（3.37 kB），主包扫描无协议/错误目录字符串（`协议版本不匹配`/`服务器内部错误` 仅在 mp chunk）；`src/game/` 无 net/worker/WebSocket/fetch；mode.ts 零 import 零 DOM。
- **命令与退出码**：`npm run typecheck` → 0；`npm run test` → 0（**15 文件 / 278 例**，新增 7 例）；`npm run build` → 0；`npm run test:e2e` → 0（**7 例**，单机离线完整可玩）；浏览器分流验证（vite preview 双实例 + Playwright 脚本）→ 0：A 未配置 API+参数→回退单机、B 配置+参数→联网占位（中文面板、协议 v1、无单机句柄）、B2 配置无参数→单机，`pageErrors=[]`。证据 `evidence/multiplayer/N07/{test,typecheck,build,e2e,browser-check}.txt`。
- **复审结论**：独立复审 PASS——boot() 零改动、双条件闭环（Vite 构建期静态替换排除 undefined 崩溃）、占位不触碰 GameEngine、边界测试正则不误放行运行时导入。非阻塞观察留后续：mp 动态 import 补 `.catch`（N31 接入时）、tsbuildinfo 建议 gitignore。
- **未解决事项**：占位面板将被 N32 大厅替换。

---

## G0 关口 — P0 阶段关闭（N01–N07）✅ PASS

- **HEAD**：N07 提交（见下方提交记录）
- **单机全量回归（§0 规则 7）**：`npm ci` → 0；`npm run typecheck` → 0；`npm run test` → 0（**15 文件 / 278 例**）；`npm run build` → 0；`npm run test:e2e` → 0（**7 例**）。证据 `evidence/multiplayer/G0/`。
- **结论**：单机零退化（E2E 与 N01 基线同为 7 例全绿；主包无网络代码）；协议/校验/错误码/种子随机/起始等级均有正反测试；装配分流有浏览器实证。P0 关闭，进入 P1（N08 Worker/DO 骨架）。

---

## N08 — Wrangler/DO 骨架与本地模拟 ✅ PASS

- **基线 HEAD**：`0ecc4d5`（N07/G0 之后）
- **改动文件（3 个逻辑文件 + 配置 + 2 测试）**：新增 `worker/wrangler.jsonc`（显式兼容日期 2026-10-01、单 ROOM_DO 绑定、`new_sqlite_classes` 迁移、`ALLOWED_ORIGINS` vars、workers_dev 公开 API 原点）、`worker/src/room.ts`（SQLite DO 骨架：room_meta 单行 + generation 探针）、`worker/src/cors.ts`（Origin 白名单纯函数：正式仅 `https://zhengxia19.github.io`，本地开发白名单仅测试）、`worker/test/cors.test.ts`（4 例）；修改 `worker/src/index.ts`（CORS 接线 + `/api/__probe/<码>` DO 探针 + DO 类入口导出）、`worker/test/protocol-boundary.test.ts`（Env 参数与 404 JSON 断言随行为更新）、`worker/vitest.config.ts`（`cloudflare:workers` node stub 别名）、`.gitignore`（`.wrangler`、`worker/.tmp`）
- **本地模拟（wrangler dev 4.151.2）**：绑定表显示 ROOM_DO(local)+vars；探针 9 项全过——health 200；`__probe/123456` 200（DO 实例化+SQLite generation=1）；重复调用幂等（同 id、gen 不变）；`234567` 独立 DO（不同 id）；`099999`→400 BAD_ROOM_CODE；evil Origin→403 BAD_ORIGIN；正式 Pages Origin→200 且 ACAO 回显；OPTIONS 预检 204（methods/max-age）；OPTIONS evil→403。证据 `evidence/multiplayer/N08/{wrangler-dev-startup,wrangler-local,worker-test,worker-typecheck}.txt`。
- **实测陷阱（写入 room.ts 注释）**：①「SELECT `.next()` 判空再 INSERT」守卫在 workerd 下失效——未耗尽游标使后续写入对之后查询不可见，改 `INSERT OR IGNORE` 幂等插入；②构造器缓存 `ctx.storage.sql` 句柄写入不可见，改每次经 `this.ctx.storage.sql`。
- **环境注记**：本机默认 `%TEMP%` 下 workerd `CreateDirectory miniflare-email-store` 拒绝访问（同路径 pwsh/cmd/node 正常、D 盘正常）→ 本地模拟以 `TEMP=worker\.tmp` 重定向（已 gitignore），非代码问题。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0（**2 文件 / 9 例**）；deploy.yml SHA256 前缀 `5A08B009` 与 N01 基线一致（未动）。
- **复审结论**：独立复审 PASS——范围无越界（deploy.yml 全哈希与 N01 基线一致、前端未动）；契约要素齐备（显式兼容日期、new_sqlite_classes、workers_dev、CORS 精确匹配无前缀混淆、探针二次校验）；证据与复跑完全一致、正反断言齐备。非阻塞观察留后续：DEV_ORIGINS 无条件并入允许集（N10 用 vars 开关 gate）、探针路由 N10 必须移除、预检含 POST 属前瞻。
- **未解决事项**：探针路由 `/api/__probe` 为验收临时件，N10 正式创建/加入 API 后移除。

---

## N09 — 房间码冲突与代际隔离 ✅ PASS

- **基线 HEAD**：`9fd8b68`（N08 之后）
- **改动文件（3 个逻辑文件 + 1 测试）**：新增 `worker/src/room-store.ts`（`randomRoomCode` 拒绝采样均匀取码 100000–999999；`allocateRoomCode` 至多 `MAX_CLAIM_ATTEMPTS=8` 次重试，耗尽返回可控错误 `ROOM_CODE_EXHAUSTED`；服务端裁决、禁止客户端先检查再提交）、`worker/test/room-allocate.test.ts`（5 例）；重写 `worker/src/room.ts`（`room_meta` 增 `occupied` 列（N08 旧库幂等补列）；`tryClaim` DO 内原子占用（方法内无 await，DO 单线程串行）+ `changes()` 判定本次占用；`release` 释放保留代际；`verifyGeneration` 仅当代际相等且占用态有效）；`worker/src/index.ts` 临时验收路由 `POST /api/__create|__claim|__release|__verify`（替换并移除 N08 `__probe`，N10 正式 API 时全部移除）。
- **单测**：`npm --prefix worker test` → 0（**3 文件 / 14 例**：随机码 2000 次全落区间且碰撞极少；分配首试/第 4 试命中；全冲突→尝试=8 且 `ROOM_CODE_EXHAUSTED`；fake DO 下 1000 次分配无重复有效码）。
- **本地模拟（wrangler dev，全新存储）**：P1 创建 gen=1；P2 并发 50 → 50 唯一码 0 失败；P3 并发 100 → 100 唯一，**合并 150 全唯一**（无重复同时有效码）；P4 释放 430911（gen 保持 1）→ 重占 gen=2 → 旧凭据 `verify gen=1 → valid:false`、新凭据 `gen=2 → valid:true`；N1 `099999`→400；N2 evil Origin→403；N3 已占用重复 claim→`claimed:false` 代际不变；N4 GET `__create`→404。证据 `evidence/multiplayer/N09/{concurrency-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt` + 脚本 `n09-e2e.ps1`。
- **实测缺陷与修复**：首版 `tryClaim` 以 `occupied===1` 判 `claimed`，已占用码误报占用成功（N3 暴露）；改 `SELECT changes()` 判定 UPDATE 生效与否后 N3 正确。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（index.ts 属验收临时接线，N10 移除）；拒绝采样均匀性（limit=4772×900000 整周期）、`changes()` 原子判定、DO 内无 await 串行原子、复用代际语义均经代码与证据双重核验；150 并发唯一码、旧凭据失效、N3 claimed=false 与复跑完全一致。非阻塞观察留 N10+：`__*` 路由必须如期移除、重试不去重（概率≈3.5e-5 可忽略）、`release` 返回语义收敛、临时路由限流属 N22。
- **未解决事项**：`__*` 临时路由与 `verifyGeneration` 语义将在 N10 正式创建/加入 API 中收敛；码空间耗尽仅单测覆盖（E2E 需 90 万 DO，不现实）。

---

## N10 — 创建房间 API 与最低防滥用门槛 ✅ PASS

- **基线 HEAD**：`eec84e9`（N09 之后）
- **改动文件（4 个逻辑文件 + 3 测试 + 配置）**：`worker/src/room.ts`（`createRoom`：条件 UPDATE+`changes()` 同步占用提交在任何 await 之前，DO 单线程串行保证并发创建同码至多一成功；`room_config`/`seats` 建表（昵称 `UNIQUE COLLATE NOCASE` 为 N11 铺垫；复用码 `DELETE FROM seats` 不继承旧席位）；房主席位签发 `randomHex(32)` 令牌、只存 SHA-256 摘要；移除 `tryClaim/verifyGeneration`，保留 `release`）；`worker/src/room-store.ts`（`allocateRoomCode` 改以 `createRoom` 为原子单元，claim 结果并入 `Allocation`）；`worker/src/index.ts`（`POST /api/rooms`：门槛顺序=Origin 必须存在且允许→每 IP 60s 滑动窗口（vars `CREATE_RATE_LIMIT_PER_MIN=30`）→content-length 与实际 UTF-8 字节双限（`MAX_MESSAGE_BYTES=4096`）→JSON/参数校验→才触达 DO；201 出站白名单 `{code,generation,playerId,seatToken,room}`，不回显摘要/DO id；**N09 `__*` 临时路由全部移除**）；`worker/src/cors.ts`（`isOriginAllowed` 增 `allowDev` 参数，生产缺省不放行本地原点——落实 N08 观察①）；测试 `room-create.test.ts`（6 例 fetch 级）、`room-allocate.test.ts`（5 例改签名）、`cors.test.ts`（dev 原点正反）；`worker/wrangler.jsonc` 增 vars。
- **单测**：`npm --prefix worker test` → 0（**4 文件 / 20 例**：201 白名单字段+令牌匹配 `SEAT_TOKEN_PATTERN`+无 `hash`/`do-`；S3+seed 与未知字段丢弃；5 类非法参数 400 精确码且 **0 次 DO 调用**；5KB body 与伪造 content-length 两路 413 且 0 DO；缺/非法 Origin 403 且 0 DO；门槛=2 时第 3 请求 429 且 DO 仅 2 次）。
- **本地模拟（wrangler dev，全新存储）**：P1 201（gen=1、64hex 令牌）；P2 容量 2–6×模式 S1/S2/S3+seed×等级 1/5/10 组合 5 例全 201、令牌全 TOKEN-OK、6 码全唯一；P3 污染字段响应无 `evilField`；N1 5 例 400 精确码；N2 413 TOO_LARGE；N3 缺 Origin 403；N4 并发 40 → **17×201+23×429**，与「30/min − 此前计入 13」精确吻合（服务端日志逐条对应）。证据 `evidence/multiplayer/N10/{api-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt` + 脚本 `n10-e2e.ps1`。
- **实测排障（记入启动证据）**：`job_kill` 只杀 pwsh 包装，`npx wrangler` node 父进程会重拉 workerd（4 实例并存、旧实例持 8787 无响应）；须先杀 CommandLine 含 wrangler 的 node 再杀 workerd。PS `[string]::new(整数)` 是码点转换（产生控制字符致 JSON 400），并发脚本昵称改字符串插值。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（deploy.yml 哈希与 N01 基线一致、前端/shared 零 diff）；门槛顺序、出站白名单、令牌摘要存储、`__*` 路由移除、allowDev gate 均核验；复跑 20 例全绿与证据一致、429 预算 30−13=17 精确吻合。观察①（await 窗口存在「已占用无席位」瞬态）**当轮采纳**：令牌/摘要生成挪至占用 UPDATE 之前，占用+配置+席位写入构成无 await 同步段，重跑单测与全新 E2E（17×201+23×429）均绿后关闭。
- **未解决事项**：跨实例全局限流、Retry-After、流式字节截断属 N22；seats 写入事务化与 workerd 级 DO 并发探针留 N11+；`release` 尚无 HTTP 路由（房间关闭属 N12）。

---

## N11 — 大厅加入 API（容量/昵称冲突/并发最后席位） ✅ PASS

- **基线 HEAD**：`f8bc003`（N10 之后）
- **改动文件（3 个逻辑文件 + 3 测试 + 配置）**：`worker/src/room.ts`（`joinRoom`：令牌/摘要先行生成后，占用态→`state`（新增列，默认 LOBBY，旧库幂等补列）→容量→昵称 NOCASE 冲突→席位 INSERT 构成无 await 同步段，DO 单线程串行保证并发抢最后席位仅一人成功；`#readConfig` 校验配置代际与 meta 一致否则 ROOM_NOT_FOUND）；`worker/src/index.ts`（`POST /api/rooms/<码>/join`：Origin 必检→`validateRoomCode`→每 IP 独立 `join|` 桶复用 30/min 门槛→字节双限→`{nickname}` 白名单校验→DO；错误映射 ROOM_NOT_FOUND→404、ROOM_FULL/NAME_TAKEN/GAME_STARTED→409、BAD_*→400；200 白名单 `{code,generation,playerId,seatToken,joinOrder,room}`；`readJsonBody` 提取复用）；`worker/src/room-store.ts`（`RoomNamespaceLike` 增 `joinRoom` 面）；新增 `worker/test/stubs/sqlite-storage.ts`（node:sqlite 适配 workerd SqlStorage 游标语义：`one()` 恰 1 行否则抛错、可迭代）；新增 `room-join.test.ts`（7 例 DO 直测）、`room-join-route.test.ts`（5 例 fetch 级）；`worker/tsconfig.json` types 增 `node`、devDep `@types/node`。
- **单测**：`npm --prefix worker test` → 0（**6 文件 / 32 例**：容量 2–6 逐一加入至满员全成功、超员 ROOM_FULL；两 `joinRoom` 交错 `Promise.all` 恰 1 成功；`ABc` vs `abc` NAME_TAKEN；未占用/已释放 ROOM_NOT_FOUND；`state=RUNNING`→GAME_STARTED；复用码旧昵称可再用且代际 +1；路由级非法码/昵称/JSON 400 且 0 DO、413/403 且 0 DO、四类错误映射精确、200 无 `hash`/`do-`）。
- **本地模拟（wrangler dev，A/B 两段、中间重启清限流窗保留 DO 态）**：A 段（20/30 桶）P1 cap2 加入 200（joinOrder=2、64hex 令牌）+ 第 3 人 409 ROOM_FULL；P2 cap3–6 各 `capacity-1` 人全 200、超员全 409。B 段（14/30 桶）P3 `ABc`/`abc`→409 NAME_TAKEN；P4 未占用码 100001→404 ROOM_NOT_FOUND（跨重启 DO 态保留佐证）；N1 099999→400 BAD_ROOM_CODE、中文昵称→400 BAD_NICKNAME、坏 JSON→400 BAD_MESSAGE；N2 5KB→413；N3 缺 Origin→403；N4 cap2 余 1 席 8 并发→**恰 1×200、7×409、OTHER=0**。GAME_STARTED 无 HTTP 触发路径（开赛属 N15），由 DO 直测覆盖。证据 `evidence/multiplayer/N11/{api-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt` + 脚本 `n11-e2e-a.ps1`/`n11-e2e-b.ps1`。
- **实测排障**：首版 E2E 昵称用 `g3_1` 含下划线违反 `^[A-Za-z0-9]{1,16}$` 致 P2 全 400；join 桶 34>30 使并发段混入 429 → 拆 A/B 两段并中间重启；N4 首版 pre-join 使 cap2 满员 8 并发全 409（设计误，房主占 1 席）→ 去 pre-join 后 1×200/7×409。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（deploy.yml 哈希前缀 `5A08B009` 与 N01 基线一致、src/ 与 shared/ 零 diff）；joinRoom 同步段零 await、NOCASE 冲突走列 collation+UNIQUE 双防线、代际一致性核验；门槛顺序与错误映射、200 白名单无泄漏核验；复跑 32 例全绿、E2E 与服务器日志一一对应、race 恰 1×200/7×409。非阻塞观察：O1 seats 未显式事务（依赖单线程+无 await 不变量）、O2 join 复用 `CREATE_RATE_LIMIT_PER_MIN` 变量名（桶键已分离，建议 N22 拆名）、O3 GAME_STARTED 无 E2E 触发路径（DO+路由双层覆盖，N15 后补）、O4 昵称冲突未按 generation 过滤（靠复用码清席保证）、O5 join 回传 customSeed 给加入者（保密性 N15+ 收敛）、O6 node:sqlite 桩非真实 workerd 并发（E2E N4 段佐证）。
- **未解决事项**：join 全局限流与 Retry-After 属 N22；GAME_STARTED 的 HTTP 路径待 N15 开赛路由打通后补 E2E。

---

## N12 — 席位、房主转移与主动退出 ✅ PASS

- **基线 HEAD**：`ee1d8b3`（N11 之后）
- **改动文件（1 个逻辑文件 + 1 测试）**：`worker/src/room.ts`（`getSeats` 席位快照：权限/房主标识/加入序号，供 N15 大厅态复用；`leaveRoom`：席位读取→DELETE→转让判定构成无 await 同步段——仅当退出者为房主时按最小加入序号存活者置 `is_host=1`（新房主唯一），最后一人离开即 `occupied=0` 关闭业务态（代际保留）；退出者席位行删除后其令牌摘要不再匹配=旧凭据失效）；新增 `worker/test/room-leave.test.ts`（7 例 DO 直测）。清单 N12 范围仅 `room.ts`+测试，无 HTTP 面。
- **单测**：`npm --prefix worker test` → 0（**7 文件 / 39 例**：房主退出→新房主唯一且为最小序号存活者（joinOrder=2 断言）；非房主退出不回报转让、房主不变、退出者再退出 UNAUTHORIZED；房主连续转让至下一序号；最后一人离开 roomClosed=true→再加入 ROOM_NOT_FOUND→重占代际 +1 席位清空；未知席位 UNAUTHORIZED 且席位不变；未占用 ROOM_NOT_FOUND；不变量：逐一退出全程房主恒唯一至空）。
- **实测缺陷与修复**：首版对非房主退出也执行 `CASE WHEN` 全表重置并回报最小序号为 `newHostPlayerId`（测试暴露语义误）→ 改为仅房主席位空出才转让。
- **本地模拟（wrangler dev 冒烟回归）**：既有 API 正常（create 201、join 200 joinOrder=2）；退出/转让无 HTTP 触发路径（WS 属 N14+），由 DO 直测覆盖。证据 `evidence/multiplayer/N12/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt`。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（deploy.yml 前缀 `5A08B009` 一致、src/ 与 shared/ 零 diff、仅 room.ts+测试）；leaveRoom 全程无 await 原子段、仅房主退出才转让、按最小 join_order 存活者、最后离开 occupied=0 代际保留、房主唯一性核验；复跑 39 例全绿与证据逐字一致；验收两条（新房主唯一、最后离开立即关闭）均有直接断言。非阻塞观察：O1 leaveRoom 以 playerId 定位，N14/N16 接线须先 token→playerId 认证再调用；O2 join_order 用 COUNT+1 中途退出后会撞号（建议 N15+ 改 MAX+1 或加 UNIQUE）；O3 getSeats 无代际过滤（release 后清席延迟到下次 createRoom）；O4 断线转让待 N14 连接注册表；O5 关闭仅置 occupied=0（state 由重占覆盖）；O6 未显式事务（同 N11 O1）。
- **未解决事项**：断线（非主动退出）触发的转让与「存活连接」维度待 N14 WS 接线后复用 `leaveRoom` 同机制；HTTP 层退出路由待 N16 协议消息承载。

---

## N13 — 单次短期握手票据与 WS 入口 ✅ PASS

- **基线 HEAD**：`1bbaba3`（N12 之后）
- **改动文件（3 个逻辑文件 + 2 测试）**：`worker/src/room.ts`（新增 `ws_tickets`（票据摘要主键+席位+代际+过期）与 `seat_conns`（席位连接声明）表；`issueTicket`：席位令牌摘要匹配+当代代际校验，await（令牌/票据哈希）全部前置，签发 32hex/30s TTL 单次票据（同席位旧未用票据替换）；`consumeTicket`：哈希 await 后查找→DELETE changes()=1 单次判定→过期 TOKEN_EXPIRED→占用/代际 GENERATION_STALE→席位存在 UNAUTHORIZED→`INSERT OR IGNORE seat_conns`+changes() 连接唯一 SEAT_TAKEN，其后无 await 原子段；`createRoom` 复用清席时同步清 `seat_conns`，不清 `ws_tickets`（旧代际票据由代际校验拒绝而非删除））；`worker/src/index.ts`（`POST /api/rooms/<码>/ticket`：Origin 必检→码校验→`ticket|ip` 桶→字节双限→`{playerId,seatToken}` 白名单（`^p_[A-Za-z0-9]{6,32}$`+`^[A-Za-z0-9_-]{32,128}$`）→DO；ROOM_NOT_FOUND→404、UNAUTHORIZED→401、200 `{code,ticket,expiresAt}`；`GET /ws/<码>?ticket=`：Origin+upgrade 头+票据长度校验→DO 消费→REPLAY/EXPIRED/STALE/UNAUTHORIZED→401、SEAT_TAKEN→409、成功 `WebSocketPair`+`server.accept()`+101（N14 将改 Hibernation，不混用））；`worker/src/room-store.ts`（`RoomNamespaceLike` 增 `issueTicket/consumeTicket` 面）。
- **单测**：`npm --prefix worker test` → 0（**9 文件 / 53 例**：DO 直测 9 例——正确令牌换发 32hex/30s 票据；错误令牌/未知席位→UNAUTHORIZED、未占用→ROOM_NOT_FOUND；消费成功回报席位+代际、重放 TOKEN_REPLAY；`Promise.all` 并发消费恰 1 成功；DB 直改过期→TOKEN_EXPIRED；关闭重占后旧票据→GENERATION_STALE；同席位再消费→SEAT_TAKEN；多席位场景退出者票据→UNAUTHORIZED；路由级 5 例——200 白名单+DO 参数、5 类非法 0 DO、404/401 映射、WS 4 类非法 0 DO+缺 Origin 403、5 类票据拒绝映射 401/409）。
- **本地模拟（wrangler dev + .NET ClientWebSocket）**：create 201/join 200；host 票据→WS **Open**（正向）；同票据重放→**401**；同席位再签再连→**409 SEAT_TAKEN**；guest 席位连接 **Open**；未知票据→401；缺 Origin→403；HTTP 反向：错误 seatToken→401 UNAUTHORIZED、不存在房间→404 ROOM_NOT_FOUND。GENERATION_STALE 无 HTTP 触发路径（无 HTTP 退出/关闭路由），由 DO 直测覆盖。证据 `evidence/multiplayer/N13/{api-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt` + 脚本 `n13-e2e.ps1`。
- **实测排障**：`SEAT_TOKEN_PATTERN` 并非 shared/protocol 导出（N10 仅内联断言）→ index.ts 内联 `SEAT_TOKEN_RE`；`consumeTicket` 首版先删过期再查找致过期票据误报 TOKEN_REPLAY → 改为查找→DELETE→过期判定 TOKEN_EXPIRED；`createRoom` 首版清 `ws_tickets` 致旧代际票据变 TOKEN_REPLAY → 保留行靠代际校验拒绝。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（deploy.yml 前缀 `5A08B009` 一致、src/ 与 shared/ 零 diff、仅 3 逻辑文件+测试+证据）；await/同步段边界核验（consumeTicket 唯一 await 前置，DELETE changes()=1 单次判定与 INSERT OR IGNORE changes() 声明均无 await 穿插，失败路径不泄漏 seat_conns）；安全（ws_tickets 仅存摘要、令牌不落 URL/日志、200 白名单逐键断言、null Origin 亦 403）；复跑 53 例全绿与证据逐文件一致、E2E 八项与服务器日志状态码序列吻合；日志 9 行 ≤25。非阻塞观察：O1 seat_conns 无 close 释放（含 101 前后升级失败泄漏），N14 接线处理；O2 leaveRoom 不清票据/声明行（playerId 随机不误判，仅行数残留）；O3 过期票据仅签发时顺带清扫（限流下增长有界）；O4 消费失败即烧票（单次语义，N31 重连按 REPLAY retryable 重换发）；O5 issueTicket await 窗口代际漂移以旧代际入库、消费时 STALE 拒绝（fail-closed）；O6 未校验 connection/sec-websocket-* 头（N14/N22 加固）；O7 dev 日志「code had hung」为 plain accept 伪影（N14 Hibernation 消除）；O8 路由级 101 成功路径无单测（node 无 WebSocketPair，E2E 覆盖，N14 补）；O9 GENERATION_STALE 无 HTTP E2E 路径（DO 直测覆盖，N15/N16 后补）。
- **未解决事项**：`seat_conns` 声明的释放（WS close 时 DELETE）与断线宽限属 N14 接线；Hibernation（`acceptWebSocket`+attachment）N14 替换 plain accept；GENERATION_STALE 的 E2E 触发路径待 N15/N16 提供 HTTP/WS 关闭面后补。

---

## N14 — WebSocket Hibernation 接管与断线释放 ✅ PASS

- **基线 HEAD**：`e10f3ca`（N13 之后）
- **改动文件（3 个逻辑文件 + 2 测试）**：`worker/src/room.ts`（`fetch` 升级交接入口：`/ws/*` 校验 upgrade 头→`consumeTicket`→生产路径接管 `request.webSocket`、本地 dev 路径 DO 自建 `WebSocketPair`（server 端 `ctx.acceptWebSocket` 接管、client 端随 101 Response 回传）→`serializeAttachment({playerId,generation})`；`webSocketMessage` 附件缺失→4001、`ping`→`{"type":"pong"}`、未知忽略；`webSocketClose/webSocketError`→`#releaseSeatConn` DELETE seat_conns；构造器 `#restoreHibernated`：`getWebSockets` 遍历，附件缺失/席位或代际失效/房间未占用→4001+清声明；plain `accept()` 全部移除）；`worker/src/index.ts`（`GET /ws/` 改原样 `stub.fetch(request)` 转发，101 直返（WS 握手不受 CORS 约束），DO JSON 错误映射 SEAT_TAKEN→409/BAD_MESSAGE→400/其余→401；移除 N13 临时 WebSocketPair）；`worker/src/room-store.ts`（接口面 `attachWebSocket`→`fetch`）；新增 `room-hibernation.test.ts`（11 例）；`room-ticket-route.test.ts` 适配（路由不再造 pair，断言转发 URL 含 ticket 与错误映射）。
- **单测**：`npm --prefix worker test` → 0（**10 文件 / 64 例**：接管成功附件携带席位+代际、seat_conns 入库；无效票据不接管；DO fetch 交接（webSocket+upgrade→101 语义、重放→401 TOKEN_REPLAY）；本地 dev 回退（无 webSocket→server 接管+附件、client 不接管、声明入库）；ping→pong、未知消息不放大；附件缺失→4001；close/error 释放声明→同席位新票据可再接管；热重启重建——有效连接保留+身份/配置可恢复+回调可用、房间重占后旧连接 4001+清声明、无附件存量连接 4001）。
- **本地模拟（wrangler dev + .NET ClientWebSocket）**：create 201/join 200；host 票据→WS **101 Open**+`ping`→`{"type":"pong"}`；close 后重换票→**TICKET2=200、重连 101 Open**+pong（close 释放声明生效）；旧票重放→**401**；guest 席位连接 101 Open+pong。服务器日志 101/401 序列与断言一一对应。证据 `evidence/multiplayer/N14/{api-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt` + 脚本 `n14-e2e.ps1`。
- **实测排障（关键）**：本地 wrangler dev 4.151.2 下升级请求转发 DO 后 `request.webSocket` 恒 undefined——miniflare loopback 源码证实入站升级经 `#handleLoopbackUpgrade` 重建 Request 时**不附加 webSocket**，且 `RequestInit` 无 `webSocket` 字段（仅 `ResponseInit` 有，workers-types 证实）；`new Request(url,{webSocket})`/`UPGRADE` 方法/复制构造四种变体均被丢弃。修复：DO 内自建 `WebSocketPair`，server 端 Hibernation 接管、client 端随 101 回传由 miniflare 与真实 socket 对接（生产路径仍优先 `request.webSocket`）。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（deploy.yml 前缀 `5A08B009` 一致、src/ 与 shared/ 零 diff、仅 3 逻辑文件+测试+证据）；Hibernation 不与 accept 混用、附件仅存席位身份（令牌/票据不进附件）、close/error 双通道释放、重建核验 fail-closed；复跑 64 例全绿、E2E 六项与日志吻合；日志 ≤25 行。非阻塞观察：O1 dev 回退路径与生产路径分支以 `request.webSocket` 存在性判定，生产恒走前者；O2 `webSocketMessage` 对 >4KB 消息未设限（N25 防滥用）；O3 附件缺失连接不查 seat_conns 即关闭（无声明可泄）；O4 断线宽限（30s）属 N20，当前 close 即释放。
- **未解决事项**：断线 30s 宽限与淘汰联动属 N20；协议消息（join/state/input）属 N16；`GENERATION_STALE` 的 E2E 触发路径待 N15/N16 关闭面。

---

## N15 — 服务器会话状态机与准备 ✅ PASS

- **基线 HEAD**：`3a679ef`（N14 之后）
- **改动文件（1 个逻辑文件 + 1 测试）**：`worker/src/room.ts`（schema：`seats.is_ready`（幂等补列）+ `match_roster`（开局冻结名单，独立于 seats）；`getLobbyState` 权威快照（state+配置+席位含准备标志，供 N16 广播复用）；`updateConfig` 房主改配置——仅 LOBBY、字段边界与创建入口同源（shared/protocol 常量白名单）、容量不得低于在场席位、**任一更新后全部准备标志清零（含房主）**；`setReady` 仅 LOBBY；`startGame` 房主开局——在场 ≥`MIN_PLAYERS`、全部席位（含房主）已准备、成功即 LOBBY→COUNTDOWN 且无 await 原子段内冻结名单与参数；`finishGame` 仅 RUNNING→FINISHED（N17/N18 触发面，重复调用 BAD_STATE 幂等）；`nextRound` 房主 FINISHED→LOBBY：席位保留、准备清零、名单清空、配置重新可改；`joinRoom` 序号 COUNT+1→**MAX+1**（修 N12 O2 撞号）；`createRoom` 复用清 `match_roster`）。清单 N15 范围仅 `room.ts`+测试，无 HTTP 面（协议消息属 N16）。
- **单测**：`npm --prefix worker test` → 0（**11 文件 / 74 例**：新增 `room-state.test.ts` 10 例——改配置回显+持久化+customSeed 清除；改配置后准备全失效且重备前开局 PLAYERS_NOT_READY、重备后成功；非房主/未知席位改配置 NOT_HOST/UNAUTHORIZED 且配置与准备不变；9 类非法字段 BAD_CONFIG、容量低于在场席位 CAPACITY_BELOW_SEATS；准备/取消正向+未知席位/未占用拒绝；全员准备开局成功（roster 冻结快照断言）+开赛后加入/改参/准备/再开局全拒绝 GAME_STARTED；人数不足 NOT_ENOUGH_PLAYERS、非房主 NOT_HOST、未知 UNAUTHORIZED 且状态保持 LOBBY；finishGame 仅 RUNNING、重复 BAD_STATE；nextRound 房主成功→LOBBY+准备清零+roster 清空+配置可再改+席位可再入，非房主 NOT_HOST、LOBBY/COUNTDOWN BAD_STATE；开赛后中途退出不改写已冻结名单；序号 MAX+1：房主退出后新加入者=4 不复用 3）。
- **本地模拟（wrangler dev 冒烟回归）**：新 schema 下既有面不受影响——health 200、create 201、join 200、ticket 200、WS **101 Open**+`ping`→`{"type":"pong"}`（N14 语义回归）；反向：错误 seatToken 换票→401 UNAUTHORIZED、`POST /api/rooms/<码>/start`→404（状态机无 HTTP 面，符合清单边界）、首段错误 Origin→403。证据 `evidence/multiplayer/N15/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck}.txt` + 脚本 `n15-smoke.ps1`。
- **实测排障**：冒烟脚本首版 Origin 用本地地址被白名单拒绝（403）→ 改用正式白名单 `https://zhengxia19.github.io`；`SendAsync` 需 `ArraySegment[byte]`+`GetAwaiter().GetResult()`（N14 脚本既有写法）。
- **命令与退出码**：`npm --prefix worker run typecheck` → 0；`npm --prefix worker test` → 0；deploy.yml 未动（前端零改动）。
- **复审结论**：独立复审 PASS——范围合规（deploy.yml 前缀 `5A08B009` 一致、src/ 与 shared/ 零 diff、仅 room.ts+测试+证据）；全部新方法无 await 原子段、开局「置状态→冻结名单」同段无半开赛窗口；验收三条（人数不足/未准备/非房主开局失败、改配置准备重置、开赛后加入与改参失败）均有直接断言；序号修复佐证。非阻塞观察：O1 房主也须 ready 方可开局（方案「所有玩家重新准备」从严解释，N16 广播文案对齐）；O2 leaveRoom 未联动 match_roster（名单冻结语义，淘汰接线属 N18）；O3 COUNTDOWN→RUNNING 转换属 N16（startAt 确认），finishGame 暂由测试经 SQL 置态触发；O4 updateConfig 无 HTTP/WS 面（N16 settings_update 消息承载）。
- **未解决事项**：`startAt/deadlineAt/种子派生`属 N16；RUNNING 态权威进入待 N16 倒计时确认；淘汰对名单的影响属 N18。

---

## N16 — 统一倒计时与开局种子派生 ✅ PASS

- **基线 HEAD**：`57ec770`（N15 之后）
- **改动文件（2 个逻辑文件 + 2 测试）**：`shared/protocol.ts`（`RNG_ALGO` 常量锁定 `xorshift32-bag7-v1`；`COUNTDOWN_MS=3000`；纯函数 `fnv1a32`（FNV-1a，Math.imul，跨环境确定）、`normalizeSeed32`（S3 固定哈希归一化，大小写敏感，零值映射非零）、`deriveSeatSeed`（S2 按主种子+稳定席位 ID 派生）、`xorshift32`（32 位，状态非零）、`bag7Sequence`（每袋 7 枚 Fisher–Yates 全排列，相同种子+相同取牌次数=同一序列））；`worker/src/room.ts`（新表 `match_state`（match_id/generation/master_seed/rng_algo/start_at/deadline_at/running_at，单行整体替换）；`startGame` 扩展——S3 归一化房主种子、S1/S2 用 `crypto.getRandomValues` 主种子，`startAt=now+3000`、`deadlineAt=startAt+600000`，无 await 原子段入库并返回 `match` 载荷（matchId/时间/rngAlgo/逐席位 seatSeeds），向每存量连接广播**一条** `countdown`（不逐秒）；`getMatchInfo` 与 match_start 载荷同源（席位+代际核验）；`advanceToRunning(now)` COUNTDOWN→RUNNING 权威确认——`now<startAt`→TOO_EARLY 且状态不变、`now===startAt` 临界允许、重复 BAD_STATE 幂等，成功逐席位广播 `match_start`（seatSeed/seatIndex/startLevel）；`#broadcast` 载荷类型 `CountdownMsg|MatchStartMsg`（复审 O2）；`nextRound` 清 `match_state`（复审 O1）；`createRoom` 复用清理含 `match_state`）。
- **单测**：`npm --prefix worker test` → 0（**13 文件 / 88 例**：新增 `seed-derivation.test.ts` 7 例——金样本 xs(1)=[270369,67634689,2647435461]、bag(1,14)=[4,0,2,3,5,6,1,2,1,3,5,4,6,0]、seed42→1672157454 与 Seed42→2868627374 大小写敏感、席位派生金样本、每袋 7 枚全排列、零种子非零映射、不同种子不同序列；新增 `room-countdown.test.ts` 7 例——S1 全员同种子=库内主种子且跨客户端 bag7 序列一致、getMatchInfo 同源（seatIndex/startLevel）、S2 逐席位派生与共享函数一致且序列互异、S3 金样本归一化+跨房间可复盘、开局前无信息/未知席位 null、TOO_EARLY（startAt-1 状态不变）+临界 startAt 允许+幂等 BAD_STATE、一次性广播每连接恰 1 条 countdown 与 match_start 逐字段、nextRound 清陈旧信息+新局新 matchId）。
- **本地模拟（wrangler dev 冒烟回归）**：新表与广播代码下既有面不受影响——health 200、create 201、join 200、ticket 200、WS 101 Open+ping→pong；反向：错误 seatToken→401、`POST /api/rooms/<码>/start`→404（无 HTTP 面）。证据 `evidence/multiplayer/N16/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck,root-test}.txt` + 脚本 `n16-smoke.ps1`。
- **实测排障**：无新阻塞（沿用 N15 脚本 Origin/WS URI 约定）；冒烟日志 WS 关闭握手异常为 miniflare 耦合已知表象。
- **命令与退出码**：`npm --prefix worker run typecheck`→0；`npm --prefix worker test`→0；根 `npm run test`→0（15 文件/278 例，协议改动无前端回归）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立复审 PASS——范围合规（仅 2 逻辑文件、src/ 零 diff、deploy.yml 前缀一致）；金样本经 node 独立复算吻合；三模式语义与 §3.1 一致；无 await 原子段+代际核验；验收三条（三模式约定牌序、临界与提前拒绝、服务器权威一致时间不逐秒）直接断言。非阻塞观察 O1（陈旧 match 信息）与 O2（广播载荷未用协议类型）**已在本任务内修复**并补测试；O3 revision 硬编码 1（revision 语义属 N26）；O4 fnv1a32 仅取低字节（输入受 pattern/hex 约束，注释已声明）；O5 取模 bias（确定性由金样本锁定）；O9 离席连接 seatIndex 兜底 0（N18/N20 边界）。
- **未解决事项**：startAt 到期自动调用 `advanceToRunning` 的 DO Alarm 属 N17；`ready/start/settings_update` 入站 HTTP/WS 面属 N22/N25；revision 计数器属 N26。

---

## N17 — 600 秒到期闹钟 ✅ PASS

- **基线 HEAD**：`22a0bc3`（N16 之后）
- **改动文件（1 个逻辑文件 + 1 测试 + 测试桩）**：`worker/src/room.ts`（`startGame` 与 match_state 同原子段后 `setAlarm(startAt)`；`advanceToRunning` 开赛重排 `setAlarm(deadlineAt)`；`alarm()` 回调→`#handleDeadline(now)`——COUNTDOWN：`now≥startAt`→`advanceToRunning`（内部重排 deadline 闹钟）否则重排 startAt；RUNNING：`now≥deadlineAt`→`#endAtDeadline` 否则重排 deadlineAt；LOBBY/FINISHED/未占用/代际陈旧无操作；`#endAtDeadline` 经 `finishGame` 幂等门（非 RUNNING 不重复广播）后向存量连接广播 `match_end`（reason=timeout、winners=冻结名单全体、standings=[] 留 N19）；`#readMatchState` 代际核验辅助；构造器 `#restoreAlarms` 与 `#handleDeadline` 决策同源（复审 O3 合并）+try/catch fail-safe——**闹钟由持久化 deadline 重建**；`#broadcast` 联合类型加 `MatchEndMsg`）；`worker/test/stubs/sqlite-storage.ts`（Fake ctx 增 `storage.setAlarm/getAlarm`+`alarmCalls` 记录）；新增 `room-alarm.test.ts`（8 例，`vi.useFakeTimers` 假时钟 T0=1.7e12）。超时触发源唯一：无 HTTP/WS 客户端路径可达 `#endAtDeadline`（grep 证实），心跳 ping 不触碰闹钟。
- **单测**：`npm --prefix worker test` → 0（**14 文件 / 96 例**：新增 8 例——调度链 startAt→deadlineAt 且差=600000；COUNTDOWN 下 startAt-1 不提前推进并重排；startAt 临界推进 RUNNING；**startAt+599999ms 保持 RUNNING（不结束）**、**+600000ms 临界结束**且 match_end 逐字段（winners 钉死=冻结名单全体）；幂等——3 次 alarm 仅 1 次 match_end、状态保持 FINISHED；RUNNING 中驱逐→新实例构造器凭持久化 deadline 即刻 FINISHED（**浏览器全离线不延长**）；ping→pong 零 setAlarm（不轮询）；反向：LOBBY 无 match_state 时 alarm 无操作不排闹钟）。
- **本地模拟（wrangler dev 冒烟回归）**：Alarm 面与构造器重建下既有面不受影响——health 200、create 201、join 200、ticket 200、WS 101+pong；反向：错误 seatToken→401、状态路由 404。证据 `evidence/multiplayer/N17/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck,root-test}.txt` + 脚本 `n17-smoke.ps1`。
- **实测排障**：新测试文件 `COUNTDOWN_MS` 未用导入致 tsc TS6133→移除；600 秒真实等待不可行于冒烟，边界语义由假时钟测试锁定（清单指定假时钟验收）。
- **命令与退出码**：`npm --prefix worker run typecheck`→0；`npm --prefix worker test`→0；根 `npm run test`→0（15 文件/278 例）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立复审 PASS——触发源唯一、边界/幂等/重建/载荷协议合规、闹钟链完整、假时钟真实控制 Date.now；复跑 96 例全绿。非阻塞观察 O1（测试注释不精确）、O2（winners 未钉死）、O3（决策逻辑重复）**已在本任务内修复**（注释修正、winners 全体断言、`#restoreAlarms` 合并到 `#handleDeadline`）；O4 `finishGame` 保持仅服务端内部调用（N18 接线注意）；O5 真实唤醒时构造器与 alarm 交叠已由幂等门覆盖。
- **未解决事项**：淘汰触发的提前终局与 standings 填充属 N18/N19；空房闹钟与多闹钟协调属 N21；`ready/start` 入站面属 N22/N25。

---

## N18 — 淘汰及提前终局裁决 ✅ PASS

- **基线 HEAD**：`44331af`（N17 之后）
- **改动文件（1 个逻辑文件 + 1 测试）**：`worker/src/room.ts`（新表 `eliminations(player_id PK, eliminated_at, match_id, generation)`——淘汰时间**只由服务端写入**（签名无客户端时间字段，N25 以服务端接收时刻调用）；`createRoom/startGame/nextRound` 清空防跨局陈旧；公开 `reportElimination`（单事件）/`reportEliminations`（**同一结算批次**，方案 §1.7 极端同时淘汰）：占用→RUNNING→当代 match_state→**只认当前局 matchId**（陈旧/错误 `MATCH_MISMATCH` 不入账）→冻结名单身份（非参赛 `rejected`/`NOT_PARTICIPANT`）；`#applyEliminations` 入账+`player_left(eliminated)` 广播+**批次后一次性裁决**：存活 1 立即胜出、存活 0 → `MAX(eliminated_at)` 同刻组并列；`#endMatchWithWinners` 经 `finishGame` 幂等门广播 `match_end(reason=survival)`；`#endAtDeadline` 胜者改存活者（**已淘汰者不能赢超时局**，§1.6）；`leaveRoom` RUNNING 退出视为淘汰入账（N15 复审 O2，置于席位删除前，房主转让/roomClosed 不动）；`#broadcast` 联合加 `PlayerLeftMsg`）。新增 `room-elimination.test.ts`（12 例）。
- **单测**：`npm --prefix worker test` → 0（**15 文件 / 108 例**：新增 12——4 人序列逐人出局+最后 1 人胜+广播逐字段；2 人首淘汰即终局/6 人第 5 次才终局边界；陈旧与错误 matchId 拒绝且零入账；非参赛与 LOBBY 反向；重复淘汰幂等（原时刻不改写、单次广播）；已结束事件 BAD_STATE 不追加 match_end；2 人同批次同刻并列；4 人最晚时刻组并列；`eliminated_at` 恒=服务端时刻入库断言；leaveRoom 淘汰入账参与裁决；超时终局 winners=存活 2 人不含被淘汰者；nextRound 清空后可再淘汰）。
- **本地模拟（wrangler dev 冒烟回归）**：淘汰面下既有 HTTP+WS 面不受影响——health 200/create 201/join 200/ticket 200/WS 101+pong；反向 401/404。证据 `evidence/multiplayer/N18/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck,root-test}.txt` + `n18-smoke.ps1`。
- **实测排障**：并列语义澄清——设计 §1.7「同一个结算批次零存活」→ 单事件顺序处理下 2 人局首淘汰即终局，故新增批次 API `reportEliminations`（单事件=1 元素批次）；假 `sql.exec` 无泛型陷阱（TS2558）与 `EliminationResult` 联合收窄（TS2339）→ `mustElim` 辅助修复。
- **命令与退出码**：`npm --prefix worker run typecheck`→0；`npm --prefix worker test`→0；根 `npm run test`→0（15/278）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立复审 PASS——eliminations 全库唯一 INSERT 且时刻仅服务端提供、matchId 严格、幂等三重（重复/已结束/闹钟交叠）、超时胜者=存活者、leaveRoom 入账不破坏转让、裁决段全同步；复跑 108 例全绿。非阻塞观察：O1 提前终局未取消 deadline 闹钟（FINISHED 门空转无害，**归 N21 闹钟协调**）；O2 `now` 为测试缝参数（N25 必须传服务端接收时刻）；O3 `#eliminatedAtOf` 未带 generation（matchId 随机碰撞可忽略）；O4 并列组内顺序未定义（N19 加次级排序键）；O5 RUNNING 最后席位退出可致「退出者并列胜」（§1.7 合规反直觉，N19 复盘明示）；O6 超时存活者现全体并列（排序属 N19）。
- **未解决事项**：终局名次 standings 与分数/消行排序属 N19；提前终局的闹钟取消属 N21；gameover 入站接线属 N25。

---

## N19 — 超时获胜和最终名次 ✅ PASS

- **基线 HEAD**：`bf942cd`（N18 之后）
- **改动文件（1 个逻辑文件 + 1 测试，均新增）**：`worker/src/ranking.ts`（纯函数 `computeFinalRanking(RankInput[]) → {standings: StandingEntry[], winners}`，方案 §1.6～§1.8：存活者恒先于已淘汰者（**已死高分不夺冠**）；存活者段分数降序→消行降序；已淘汰段淘汰时刻降序（存活久者先）→分数→消行；并列由 `sameRankKey` 显式判定（不含 playerId/joinOrder，joinOrder 仅稳定显示序）；placement 竞赛排名跳号（1,1,3）、已淘汰 `placement=null`（协议 StandingEntry 规定）；胜者独立：有存活→并列第一存活者，零存活→最晚时刻组内分数/消行判定、完全同条件并列；拷贝入参、全序比较器保证确定性。与 N27 排行榜**零复用**：ranking.ts 仅 import 协议类型，无任何生产代码 import 它）。新增 `worker/test/ranking.test.ts`（11 例）。room.ts/index.ts 未改（成绩存储与 standings 接线属 N25/N27）。
- **单测**：`npm --prefix worker test` → 0（**16 文件 / 119 例**：新增 11——已死高分不夺冠+已淘汰无 placement；超时存活分数→消行排序；完全并列双胜者+跳号 1,1,3 且显示序不暗判 ID；淘汰时刻降序无视分数差；同时刻按分数/消行；零存活最晚组独胜/并列；六人混合全段名次；乱序输入输出一致；纯函数不改入参+空输入+单人局；反向「胜者永不含已淘汰者」）。
- **本地模拟（wrangler dev 冒烟回归）**：纯模块零接线，既有 HTTP+WS 面回归——health 200/create 201/join 200/ticket 200/WS 101+pong；反向 401/404。证据 `evidence/multiplayer/N19/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck,root-test}.txt` + `n19-smoke.ps1`。
- **实测排障**：首版实现为密集排名（1,1,2）与测试预期竞赛排名（1,1,3）不符——按「并列第一后续跳号」标准语义改为 `placement = index + 1`。
- **命令与退出码**：`npm --prefix worker run typecheck`→0；`npm --prefix worker test`→0；根 `npm run test`→0（15/278）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立复审 PASS——§1.6/§1.7/§1.8 逐条对照正确、并列等价类相邻性成立、与排行榜零复用、复跑 119 例全绿。非阻塞观察：O1 joinOrder 重复时显示序退化输入序（实际唯一，N25 接线可加 playerId 末位显示键，禁入 sameRankKey）；O2 winners 数组为显示序（接线方勿依赖其顺序）；O3 standings 字段透传靠类型兜底（N25 接线测试补逐字段）；O4 smoke WS_ERR 为已知收尾现象。
- **未解决事项**：成绩（score/lines）服务端存储与 match_end standings 接线属 N25/N27；N18-O5「最后席位退出者并列胜」语义在 N25 接线时于 UI 明示。

---

## N20 — 断线宽限与单席位重连 ✅ PASS

- **基线 HEAD**：`4644f7a`（N19 之后）
- **改动文件（1 个逻辑文件 + 3 测试改 + 1 测试新增）**：`worker/src/room.ts`（seats 增列 `disconnected_at`、seat_conns 增列 `conn_id`（幂等 ALTER）；`WsAttachment` 增 `connId`，attachWebSocket 生成 `randomHex(8)` 写入声明与附件；`consumeTicket` 声明冲突由 SEAT_TAKEN 改**替换语义**：关闭该席位存量 socket(4003 replaced)→删旧声明→重新声明（刷新重连不新增玩家）；`#releaseSeatConn` 按 `conn_id` 核验释放——替换后旧 socket 迟到 close `changes()=0` 不误伤新声明，成功释放记服务端断线时刻并重排闹钟；`alarm()` 三段：`#handleDeadline`→`#handleGraceExpiry`（RUNNING 局 `disconnected_at+30000<=now` 的未淘汰参赛者经 `#applyEliminations(reason=grace_expired)` 淘汰——判定式即 29.999s 可恢复/30s 整淘汰）→`#ensureGraceAlarm`（**弃用 getAlarm**（workers-types 返回 Promise），由 SQL 直算 deadline/倒计时与宽限候选取最近者排单槽闹钟）；`#restoreAlarms` 构造期同三段（驱逐期超宽限即刻淘汰，闹钟丢失也权威）；`getLobbyState` 席位带 `disconnectedAt`（N25 UI「连接中断」态）。**LOBBY/非参赛者断线不排闹钟不淘汰**，席位存续至到期/离开——与 30 分钟清理（N21）互不混同；断线不改 deadline（不停表）。测试：新增 `room-grace.test.ts` 10 例；`room-ticket.test.ts` SEAT_TAKEN→替换断言；`room-hibernation.test.ts` 附件含 connId 格式与列核对；`room-alarm.test.ts` 重排次数 +1（协调面同值重排）。）
- **单测**：`npm --prefix worker test` → 0（**17 文件 / 129 例**：新增 10——RUNNING 断线记时刻+闹钟提前到宽限；29.999s 无淘汰、重连清标记后 30s 整不淘汰；30s 整淘汰入账=闹钟服务端时刻+逐席位 `grace_expired` 广播+席位/占用存续；双闹钟幂等；旧 socket 4003 替换+迟到 close 不互伤；刷新席位数与身份不变；LOBBY 零闹钟零淘汰席位存续；不停表（deadline 不被覆盖、超时存活含未超宽限断线者）；COUNTDOWN 断线链 startAt 先开赛再宽限裁决；驱逐重建构造期即刻淘汰）。
- **本地模拟（wrangler dev 冒烟）**：host 首连 101+pong→主动断线→**原令牌换票重连 101+pong**→guest 席位不受影响仍 101+pong；反向错误 seatToken/陌生 playerId 401。证据 `evidence/multiplayer/N20/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck,root-test}.txt` + `n20-smoke.ps1`。
- **实测排障**：`#pendingGraceAt` 误对展开数组调 `.one()`（16 例连锁失败）→改 cursor `.one()`；`ctx.storage.getAlarm()` 为 Promise→弃用改 SQL 直算候选；冒烟误走 PS5.1（无 `-SkipHttpErrorCheck`）→pwsh 执行；miniflare 关闭握手不回包为已知表象→try/catch 记录。
- **命令与退出码**：`npx vitest run`→0；`npx tsc --noEmit`→0；根 `npm run test`→0（15/278）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立复审 PASS（无 P0/P1）——边界判定式、conn_id 互伤防护、范围隔离（LOBBY 零闹钟、淘汰不删席位）、原子段（consumeTicket 唯一 await 在 sha256）、闹钟三段同序与幂等、协议零改动、旧测试改动净增强、复跑 129/278 全绿。非阻塞观察：O1 淘汰时刻=闹钟触发时刻（服务端权威自洽）；O2 LOBBY 断线者若冻结进 roster 宽限从断线起算（开赛即裁，N21/文档补语义）；O3 跨部署存量附件无 connId 按 4001 关闭（未上生产可接受）；O4 alarm 测试绑定 setAlarm 次数（注释已明意图）；O5 假 ctx 淘汰者 socket 仍收广播（真实 Hibernation 会移除）；O6 替换路径 conn_id 短暂 NULL 可自愈。
- **未解决事项**：全员离开/全员断线空房释放与 `deleteAlarm`（含 N18-O1 提前终局残留闹钟）属 N21；「连接中断/已淘汰」UI 态与 gameover 服务端接收时刻接线属 N25；SEAT_TAKEN 成类型兼容死支（N22 入站面清理）。

---

## N21 — 房间空置与到期清理 ✅ PASS

- **基线 HEAD**：`d0353f3`（N20 之后）
- **改动文件（1 个逻辑文件 + 4 测试改 + 1 测试新增）**：`worker/src/room.ts`（room_meta 增列 `idle_since`（幂等 ALTER）；`#markIdleIfEmpty` 占用+有席位+`getWebSockets()=0` 才记空置起点（`UPDATE ... AND idle_since IS NULL` 只记一次；触发点：`#releaseSeatConn` 成功释放、`#restoreAlarms` 重建补记、`nextRound`）；`attachWebSocket` 成功连接即清空空置标记（残留空置闹钟下次触发经自愈分支失效）；`#handleIdleExpiry` 判定式 `idle_since+EMPTY_ROOM_TTL_MS<=now`——29 分 59 秒业务记录仍在、30 分钟整释放，有活动连接则清标记不释放；`#releaseRoomData` 同步清空 7 张业务表（seats/seat_conns/ws_tickets/match_roster/match_state/eliminations/room_config）+occupied=0+代际保留+`deleteAlarm`——`leaveRoom` 最后一人主动离开走此路（立即销毁）；`#ensureGraceAlarm`→`#rescheduleAlarms`：候选=宽限/倒计时/deadline/空置取 min（空房闹钟不覆盖更近候选），候选空则 `deleteAlarm`（修复 N18-O1：`#applyEliminations` 提前终局后重排）；`alarm()` 四段：deadline→grace→idle→reschedule。）
- **单测**：`npx vitest run`→0（**18 文件 / 138 例**：新增 `room-idle.test.ts` 9 例——全员主动离开立即释放+取消闹钟+旧 token 失效（ROOM_NOT_FOUND）；LOBBY 全员意外断开记空置起点+30 分钟闹钟；29:59 记录仍在/30:00 整清理+旧 token 无效；30 分钟内重连取消空置、到期不释放；RUNNING 全员断开宽限闹钟优先不被空房覆盖、终局后空房闹钟接管、29:59 业务记录在但超 30 秒者不可复活（BAD_STATE）；COUNTDOWN 全员断开 startAt 优先且 alarmCalls 不含 TTL；驱逐重建空置已到期构造器即刻释放；反向多席位单人断开不记空置；提前终局 `deleteAlarm` 取消残留 deadline 闹钟。票据测试 GENERATION_STALE→TOKEN_REPLAY（释放清空票据行=即刻无效，代际核验保留为纵深防御）；grace/hibernation 重建 ctx 补 `deleteAlarm`；stub 补 `deleteAlarm` 面与 `acceptWebSocket` close 移出 Hibernation 登记（对齐平台语义）。）
- **本地模拟（wrangler dev 冒烟）**：health 200/create 201/join 200；host+guest 首连 101+pong→**全员断开**→空置期内**双方原令牌换票重连 101+pong**（席位数据存续）；反向错误 seatToken 401。证据 `evidence/multiplayer/N21/{smoke-local,wrangler-dev-startup,worker-test,worker-typecheck,root-test}.txt` + `n21-smoke.ps1`。
- **实测排障**：释放清空 `ws_tickets` 使旧票据消费由 GENERATION_STALE 变 TOKEN_REPLAY（未知票据，同样无效）→按新语义更新断言并注明纵深防御；tsc 判别联合（LeaveResult/BatchEliminationResult）访问 `roomClosed`/`matchEnded` 需先 `if (!x.left)` 收窄。
- **命令与退出码**：`npx vitest run`→0；`npx tsc --noEmit`→0；根 `npm run test`→0（15/278）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立复审 PASS（无 P0/P1）——空置只记一次、29:59/30:00 边界判定式、7 表清空+代际保留的旧凭据失效链、leaveRoom 全程同步无 await 窗口、min 候选协调、替换窗口 conn_id 防护、测试含反向断言、N17/N18/N20 语义不变。非阻塞观察：O1 从未挂过 WS 的占用房间实例存活期不释放（清单字面外，重建/nextRound 补记）；O2 attach 不重排闹钟，空置闹钟空触发一次由自愈消化；O3 joinRoom 不重锚 idle_since（与「无连接=空置」定义一致）；O4 `void deleteAlarm` 浮动 Promise（风险极低）；O5 空置判定依赖平台 close 前移出登记语义（stub 已对齐，偏差方向保守）。
- **未解决事项**：O1/O2/O3 空置边缘语义在 N25/N26 文档化；「连接中断/已淘汰」UI 与 gameover 接线属 N25；SEAT_TAKEN 死支清理属 N22。

---

## G1 — 关口验收（N08–N21）✅ PASS

- **基线 HEAD**：`3ae1caa`（N21 之后）
- **验收范围**：清单 §6 关口 G1——N08–N21 全部 14 项通过；DO 房间生命周期、身份、600 秒闹钟、空置删除完整可测。
- **完整性核对**：日志 N08–N21 十四项均 ✅ PASS；提交链 `9fd8b68..3ae1caa` 恰 14 个 feat 逐项对应；`evidence/multiplayer/N08..N21/` 原始输出齐备；deploy.yml 仅 2 条历史提交（N08 后未动，前缀 5A08B009）；协议三常量（600000/30000/1800000）单一来源直用。
- **四要素可测性**：生命周期=room-allocate/room-leave/room-join（原子占用、代际隔离、转让唯一）；身份=room-ticket/room-ticket-route/room-hibernation/room-grace（摘要存储、单次消费、conn_id 替换）；600 秒闹钟=room-alarm/room-countdown（599999/600000 假时钟边界、deadline 重建幂等）；空置删除=room-idle/room-leave（29:59/30:00 边界、候选协调、deleteAlarm）。
- **复跑与退出码**：worker `npx vitest run`→0（18/138）；worker `npx tsc --noEmit`→0；根 `npm run test`→0（15/278）；根 `npm run typecheck`→0；`npm run build`→0；`npm run test:e2e`→0（7 passed）。证据 `evidence/multiplayer/G1/{gate-report,root-typecheck,root-build,e2e}.txt`。
- **复审结论**：独立只读关口复审 PASS——日志/证据/提交链三方一致，复跑数字与 N21 证据吻合，四要素逐项有测试锚点，无阻塞缺口；既有非阻塞观察项均已留痕并标注归属（N22/N25/N26/N31）。
- **未解决事项**：无关口级缺口；进入 N22（HTTP 防滥用加固）。

---

## N22 — HTTP 防滥用策略加固 ✅ PASS

- **基线 HEAD**：`8a0b470`（G1 之后）
- **改动文件（3 个逻辑文件 + 2 测试改 + 1 测试新增）**：`worker/src/index.ts`（有界滑动窗口限流器：`rateWindow` Map 60s 窗口、桶数封顶 4096 按插入序淘汰（禁止无限增长进程级 Map）、每桶 hits≤限额（命中不 push，惩罚不延长窗口）、`retryAfterSec=ceil((hits[0]+60s−now)/1000)`∈[1,60]；分端点桶 `create|ip`(30)/`join|ip`(30)/`ticket|ip`(60) + 共享试码预算 `probe|ip`(20)（peek 不消费/失败才消费：坏码、ROOM_NOT_FOUND、ws 握手失败）；429+`Retry-After` 头；门槛顺序 create=Origin→开关→桶→字节→参数→DO，join/ticket/ws 的 probeExceeded 前置冻结 DO 调用；生产开关 `PUBLIC_CREATE_ENABLED="false"`→503 CREATE_DISABLED；ws 缺 `Sec-WebSocket-Key`→400（N13-O2）；SEAT_TAKEN→409 死支清理）；`shared/errors.ts`（目录增 `CREATE_DISABLED`，retryable）；`worker/src/room.ts`（`ConsumeFailure` 去 SEAT_TAKEN、DO fetch 映射统一 401）；`worker/wrangler.jsonc`（JOIN/TICKET/CODE_PROBE 限额 + PUBLIC_CREATE_ENABLED vars，注明每 isolate 计数与边缘规则依赖）。
- **单测**：worker `npx vitest run`→0（**19 文件 / 147 例**：新增 `http-ratelimit.test.ts` 9 例——create 429+Retry-After∈[1,60]+DO 冻结；桶独立（create 桶耗尽 join/ticket 照常）；非法 env 回退缺省；试码预算耗尽 429 且 DO 冻结；成功 join 不消耗/坏码消耗预算；ws 失败跨端点共享冷却；4100 个不同 IP 桶封顶 ≤4096 且最旧淘汰后可再创建；开关 off→503+0 DO / 缺省→201；OPTIONS 正反。`room-ticket-route.test.ts` 增缺 Sec-WebSocket-Key→400/0 DO，映射去 SEAT_TAKEN 死支。）
- **本地模拟（wrangler dev 冒烟）**：正常路径不误拒（create 201/join 200/ticket 200/WS Open+pong）；高频创建 29×201+5×429（`Retry-After: 49`）；桶独立（创建桶耗尽后既有房间 join 200）；试码冷却 20×404+4×429（`Retry-After: 60`）。SMOKE_EXIT=0。边缘限流规则配置/依赖见 `evidence/multiplayer/N22/rate-limit-rules.md`（Free 计划每 zone 1 条、10s 周期、IP 特征、workers.dev 预览子域须待自定义域方可挂 zone 规则；不足以支撑时按 §4 置开关禁用公开创建）。
- **实测排障**：冒烟脚本 `SendAsync(...).GetAwaiter().GetResult()` 顶层泄漏 `VoidTaskResult`→`[void]`；`Headers['Retry-After']` 索引返回 String[]→`Select-Object -First 1`；workerd 被杀后 wrangler 自愈重启但 health 探测过早失败→整链重启（node→workerd→清 .tmp）。
- **命令与退出码**：worker `npx vitest run`→0（19/147）；worker `npx tsc --noEmit`→0；根 `npx vitest run`→0（15/278）；根 tsc→0；`npm run build`→0；`npx playwright test`→0（7 passed）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立只读复审 PASS（无 P0/P1）——prune/限额/retryAfter 正确、有界性证明（4096×限额封顶）、门槛顺序与首请求放行、SEAT_TAKEN 清理彻底（目录保留为超集可接受）、测试正反覆盖与证据链逐项吻合。非阻塞观察：O1 坏码恒 400 不 429（无 DO 放大，边缘兜底）；O2 probe 冷却 Retry-After 固定 60s（保守上界）；O3 冷却期重试同耗端点桶（无害）；O4 淘汰 FIFO 非 LRU；O5 **N44 部署时若停留 workers.dev 预览域须置 `PUBLIC_CREATE_ENABLED="false"`**；O6 join/ticket 桶打满缺直测（后续补例）；O7 positiveInt 无上限封顶。
- **未解决事项**：O5 属 N44 部署阶段执行项；O6 补例随后续任务顺带；WS 消息级限频（5Hz/2Hz）属 N23。

---

## N23 — 棋盘快照紧凑编码 ✅ PASS

- **基线 HEAD**：`377d166`（N22 之后）
- **改动文件**：`src/net/snapshot.ts`（新增：`validateSnapshot` 严格白名单校验——精确键集（缺/多字段 BAD_SHAPE）、24 行×10 字符、格值 ∈`.IOTSZJL`、active 类型/旋转 0–3/坐标宽松超集域、seq/score/lines/level 非负安全整数、status ∈running|gameover；`encodeSnapshot` 固定键序紧凑 JSON（手工拼接、无空白，禁 PNG）+ 编码后字节硬门槛；`decodeSnapshot` 先按 UTF-8 字节 >4096 拒绝（先于 JSON.parse）再解析校验，永不抛异常；`SnapshotError`/错误码枚举）；`shared/protocol.ts`（+`SNAPSHOT_MAX_BYTES=4096`、`BOARD_CELL_CHARS`；P1 修正注释语义：合法本体最坏 ~0.5 KiB，信封开销由余量覆盖，N24 整帧仍须按 `MAX_MESSAGE_BYTES` 复核）；`src/net/index.ts`（re-export 编解码与新常量）。
- **单测**：根 `npx vitest run`→0（**16 文件 / 289 例**：新增 `tests/unit/snapshot.test.ts` 11 例——空/满棋盘/active=null 往返一致且为 JSON 文本；最坏合法编码 <600B ≤4KiB；出界坐标不静默改值；23/25 行→BAD_BOARD_ROWS；9/11 列宽、X/小写/空格/CJK/代理对→BAD_BOARD_ROW；active 7 种非法→BAD_ACTIVE；标量负数/小数/NaN/status 未知各归其码；缺/多字段/数组/null→BAD_SHAPE；BAD_JSON、恰 4096B 过闸、>4KiB TOO_LARGE、x=13 收/x=14 拒边界探针；encode 非法输入抛 SnapshotError。）
- **本地模拟**：无服务端改动（纯前端编解码）；复审独立探针确认 `__proto__` 键→BAD_SHAPE 不污染原型、重复键 last-wins（标准 JSON 语义）、最坏合法编码 479B。
- **实测排障**：`erasableSyntaxOnly` 禁构造参数属性（TS1294）→显式字段赋值；`Record<string,unknown>` 直转具名接口 TS2352→校验通过后经白名单局部分流收窄构造。
- **命令与退出码**：根 vitest→0（16/289）；根 tsc→0；`npm run build`→0；worker vitest→0（19/147）；worker tsc→0；`npx playwright test`→0（7 passed）；deploy.yml 未动（前缀 5A08B009）。
- **复审结论**：独立只读复审 PASS（无 P0；P1×1=SNAPSHOT_MAX_BYTES 注释语义→已修；O4 注释措辞→已修；O5 测试缺口→已补 1 例三断言）。非阻塞观察：O2 `-0` 编码退化为 `0`（JSON 语义固有）；O3 重复键 last-wins；O6 encode 重复校验开销可忽略（N24 热路径留观）。
- **未解决事项**：无阻塞；N24 将消费本编解码器并做 250ms/5Hz 节流与整帧 `MAX_MESSAGE_BYTES` 复核。

---

## N24 — 客户端快照限频与去重 ✅ PASS

- **基线 HEAD**：`cdc5c9c`（N23 之后）
- **改动文件**：`src/net/publisher.ts`（新增 `SnapshotPublisher`：默认 250ms、下限 200ms=5Hz 钳制且 `Number.isFinite` 封闭（NaN/Infinity 回落默认，P1 修复）；去重按 N23 固定键序编码串比较、基线仅在 send 成功后更新、invalid 输入不污染基线；`setActive`（单机不发）/`setConnected`（断线丢弃 pending+定时器，重连把 pending 挂回节流窗口 delay=max(0,due-now)）；trailing 定时器单挂不变式（timer===null 守卫+回调先清+dropPending 配对），慢网 pending 覆盖只留最新帧；`send=false` 回滚 pending 并返回独立 reason `transport_down`（O1）；直发成功清除陈旧 pending 防定时器晚发旧帧（O5）；`stop()` 清理）；`src/net/index.ts`（re-export）。
- **单测**：根 `npx vitest run`→0（**17 文件 / 300 例**：新增 `publisher.test.ts` 11 例——首帧即发+去重 unchanged；窗口内 throttled、到期只发最新帧（seq=3 吞 2）；60FPS×10 分钟 36000 帧→≤2400 且 ≥2350（双向界，结构性限频）；intervalMs=50 钳 200→10s ≤51 且 >40；NaN/Infinity 回落 250→10s ≤41；断线零上报+重连恢复；单机不发；invalid 不污染基线；transport_down 回滚+重连自动重发同帧；stop 清定时器；trailing 等值跳过。）
- **本地模拟**：无服务端改动；复审独立复跑 publisher 10/10（修复前）并确认 10 分钟恰为 2400（发送时刻 0,250,…,599750，末帧定时器 600000 未触发）。
- **实测排障**：`SnapshotPayload` 从 `./snapshot` 导入报 TS2459（snapshot 未 re-export 类型）→改从 `shared/protocol` 导入；60FPS 测试窗口取满 600000ms 会含首帧 2401→窗口改 36000×16.666ms=599976ms 严格 <600s。
- **命令与退出码**：根 vitest→0（17/300）；根 tsc→0；build→0；worker vitest→0（19/147）；worker tsc→0；playwright→0（7 passed）；deploy.yml 未动（5A08B009）。
- **复审结论**：独立只读复审 PASS（无 P0；P1×1=NaN/Infinity 钳制不封闭致 5Hz 静默击穿→已修+补 2 用例；O1 transport_down 独立标签→已修；O5 直发清 pending→已修；O6 60FPS 下界断言→已补）。非阻塞观察：O2 deliver 失败回滚帧在真实 false→true 断线流程会被 dropPending 丢弃（快照语义下靠下一帧覆盖，可接受）；O4 `now` 注入须与 setTimeout 同源（N31 装配注意）；O7 stop() 非终态。
- **未解决事项**：无阻塞；N25 起 WS 接线时消费 publisher（装配时 setConnected 生命周期）；接收端 seq 单调丢弃兜底属 N25/N26。

---

## N25 — 服务器侧快照校验、限流与背压 ✅ PASS

- **基线 HEAD**：`9b885ac`（N24 之后）
- **改动文件**：`worker/src/room.ts`（`webSocketMessage` 重写为协议管线：附件缺失→4001；二进制帧→4003 不解析；裸 `ping` liveness 豁免限流（N14 契约，注释论证有界）；`#allowInbound` 每连接 1s 滑窗 20/s 硬上限（解析前丢弃）；4KiB 原始字节双门槛（UTF-16 长度廉价预检 + `withinMessageLimit` TextEncoder 严格字节数——P1 修复：4096 多字节单元=12,288B 亦拒）；JSON.parse 失败→error(BAD_MESSAGE)；`validateClientMessage`（版本不符先回 error(PROTOCOL_VERSION) 再以 `VERSION_CLOSE_CODE` 关闭，对齐冻结契约）；信封 seq 连接内严格单调（陈旧/重复/回退整条丢弃）；分派：ping→pong{seq,serverTime}、snapshot→`#ingestSnapshot`（**零 SQLite 写**：occupied/generation/RUNNING/match_roster/eliminations/冻结 matchId/快照 seq 每局每人单调，入内存槽 `#snapLatest`）、gameover→matchId 与时刻均由服务器供给→`reportElimination`（客户端伪造 matchId→FORBIDDEN_FIELD）、ready/start/leave 接线、settings_update 暂忽略（N33）；`#sendProtocolError` 消费 `describeError`（message/retryable 取自 shared 目录）；`deliverFrame` 出站背压：bufferedAmount>16384→单槽覆盖（丢旧保新），回落后先补发槽内最新帧；清理钩子：startGame/nextRound 清 `#snapLatest`、`#releaseRoomData` 清全部 4 Map、`#releaseSeatConn` 清 connSeq/connRate/outSlots；`peekSnapshot`/`pipelineStats` 为 N26 路由/测试面）；`worker/test/room-snapshot.test.ts`（新增 12 例）；`worker/test/stubs/sqlite-storage.ts`（+可选 bufferedAmount）；`worker/test/room-hibernation.test.ts`（unknown-payload 语义→error 回复）。
- **单测**：worker `npx vitest run`→0（**20 文件 / 159 例**：room-snapshot 12 例——入账+六表行数零变化；快照 seq 陈旧/重复丢弃；信封 seq 回退整条丢弃；被淘汰者/跨局残留丢弃；gameover 接线（eliminated_at=服务端时刻、match_id=服务器局；伪造 matchId→FORBIDDEN_FIELD 且不写行）；1MiB 与 4096 多字节单元（12,288B）静默丢弃连接保持；二进制→4003；100Hz→仅 20/s 入账、窗口滑过恢复；协议违规不放大（BAD_MESSAGE retryable:true、FORBIDDEN_FIELD retryable:false、连接保持；v:99→error 后 1002）；6 人×100Hz×60s 有界（snapshots/conns/outSlots ≤6）+close 归零；背压单槽覆盖（bufferedAmount 20000→0 直发，回落后先发 frame-B 再 frame-C）；正常缓冲直发不排队。）
- **本地模拟**：wrangler dev 真实 workerd + Hibernation 烟测 `n25-smoke.ps1`（exit 0）：ping/pong；ready/start→双端 countdown（真实 Alarm 到点）；合法快照无回复+非法载荷→error（目录中文 message+retryable:true）；RUNNING 后 guest gameover→host 收 player_left；1MiB 实测 STATE=Open 无回复；二进制→close 帧。
- **实测排障**：wrangler dev WS 代理不透传自定义关闭码（4003 实测本地 code=0）→烟测断言"收到 close 帧"、精确 4003 由 DO 层单测断言；ClientWebSocket pending ReceiveAsync 会吞后续 close→Recv 异常安全+排空循环。
- **命令与退出码**：worker vitest→0（20/159）；worker tsc→0；根 vitest→0（17/300）；根 tsc→0；build→0；playwright→0（7 passed）；deploy.yml 未动（5A08B009）。
- **复审结论**：独立只读复审 PASS（P1×1=4KiB 门槛系 UTF-16 长度下界口径，多字节最坏 12,288B→已加 `withinMessageLimit` 严格字节拒绝+补 1 例；P2 已修：版本不符先 error 再 1002、`#ensureRow` 一致性、error 元数据消费 shared 目录、ping 豁免注释）。非阻塞观察：裸 ping 豁免无单测（有界）；零写断言为固定表行数求和（漏 UPDATE 不覆盖）；`pipelineStats` 未暴露窗长；`#connSeq`/`#snapLatest` 纯内存 DO 驱逐归零（matchId+限流兜底有界，N26/N28 按 seq 去重）；`deliverFrame` 补发槽帧后无条件直发当前帧（N26 复查缓冲）；error revision:1 硬编码（N26）；ready/start/leave 分派仅烟测覆盖；快照槽存续至下局，N26 路由按存活名单过滤。
- **未解决事项**：无阻塞；N26 消费 `peekSnapshot`+`deliverFrame` 做单目标路由（O(N) 扇出、revision 统一）。

---

## N26 — 服务端单目标快照路由 ✅ PASS

- **基线 HEAD**：`0bc7860`（N25 之后）
- **改动文件**：`worker/src/room.ts`（新增内存订阅映射 `#watchTarget`(playerId→target)/`#watchersOf`(target→Set)；`#buildDefaultWatchRing(generation)`：默认环按 match_roster 冻结 join_order `ORDER BY join_order ASC` 取 roster∩现存 seats（P2-2 修复：COUNTDOWN 离席者不占环位，否则其观察者整局零远端帧），target[i]=下一席位、永不为自身，advanceToRunning 每局建一次；`#ingestSnapshot` 存槽后仅向 `#watchersOf.get(发送者)` 的连接经 `deliverFrame`（N25 背压单槽）投递 `remote_snapshot`——每帧扇出=观察者数≤N-1，绝不全员转发；P2-1 修复：RUNNING 中 `#watchTarget.size===0`（DO 驱逐重建）惰性重建默认环；公共 `setWatchTarget(playerId,target)`：校验 RUNNING+目标≠自身+双方均在本局 match_roster（淘汰者允许），成功即直发 `watch_target`（关键小消息不过背压）、清该 connId 背压槽（O2：切换弃旧目标待补帧）、目标有本局最新帧（slot.matchId===当前局）紧随补发 `remote_snapshot`；O1 加固：拼接文本 id 经 `JSON.stringify`；清理钩子：startGame/nextRound/`#releaseRoomData` 清两映射、leaveRoom→`#unwatch`；`pipelineStats` +watchTargets）；`worker/test/room-routing.test.ts`（新增 10 例）；`evidence/multiplayer/N26/`。
- **单测**：worker `npx vitest run`→0（**21 文件 / 169 例**：room-routing 10 例——默认环：快照只进唯一观察者其余零收流；6 人×15 帧总量=90=O(N)（O(N²) 全发应 540）且每席位 15 帧全部来自唯一目标；切换即时补发最后帧（seq=3,score=300）+旧目标流即停+双观察者同收；切到无帧目标只发 watch_target；负向：自观察/非名单→INVALID_TARGET、非 RUNNING→BAD_STATE 且订阅不变；跨局：nextRound 清零→重开环重建、陈旧帧不残留补发；背压整合：慢观察者两帧入单槽丢旧保新、回落后按 seq[2,3] 顺序补发；leaveRoom 摘除订阅 watchTargets 6→5 全员零收流；P2-1：驱逐后新实例惰性重建环路由恢复 watchTargets 0→6；P2-2：COUNTDOWN 离席后存活者路由不指向幽灵）。
- **本地模拟**：wrangler dev 真实 workerd 烟测 `n26-smoke.ps1` 两轮 exit 0：RUNNING 后 guest 快照→host 收 `remote_snapshot`(targetPlayerId=guest)；host 快照→guest 收；负向 SELF_LOOP=False（自身快照不回流）。
- **实测排障**：跨局测试需先 `finishGame()`（nextRound 要求 FINISHED 态）；`erasableSyntaxOnly` 下无新类型障碍。
- **命令与退出码**：worker vitest→0（21/169）；worker tsc→0；根 vitest→0（17/300）；根 tsc→0；build→0；playwright→0（7 passed）；deploy.yml 未动（5A08B009）。
- **复审结论**：独立只读复审 PASS（无 P1；P2×2 已修：①驱逐后映射不重建致整局停摆→惰性重建+测试；②默认环含 COUNTDOWN 离席幽灵→roster∩seats+测试；O1 JSON 拼接 id 加固、O2 切换清背压槽、O5 改用 match_roster 冻结 join_order 已采纳）。非阻塞观察：O3 淘汰者作为目标/观察者路由语义未测（切换只得最后帧，符合设计，N30 补）；O4 双连接各收一份 watch_target（合理）；O6 `BAD_STATE/INVALID_TARGET` 未入 shared 错误目录（N30 接线时处理）；watch_target/remote_snapshot revision 仍硬编码 1（N28 统一）。
- **未解决事项**：无阻塞；N27 排行榜纯函数→N28 dirty 批处理（revision 统一）→N29 目标选择纯函数替换默认环→N30 周期切换接线（≤1s、丢弃旧目标快照）。

---

## N27 — 统一积分排行榜纯函数 ✅ PASS

- **基线 HEAD**：`7960282`（N26 之后）
- **改动文件**：`worker/src/leaderboard.ts`（新增纯函数模块：`LeaderboardRow{playerId,nickname,score,lines,joinOrder,status}`；`buildLeaderboard(rows)→LeaderboardEntry[]`（协议冻结形状 protocol.ts:208-216，joinOrder 不进广播）——显示全序=分数降序→消行降序→joinOrder 升序（joinOrder 冻结唯一⇒真全序、不依赖 sort 稳定性、与输入顺序无关）；rank=竞赛排名（并列共享、跳号 1,1,3），并列判定只看分数（方案 §5:127 逐字一致，消行/加入序仅稳定显示不影响名次）；无观看者参数⇒不可能因名字/观察目标重排；死人留榜状态原样携带分数固定；`topScorePlayerIds(entries)`=得分领先者集合（可并列、顺序无关 Math.max——复审 O1 加固），与 N19 winners/match_end standings 语义分离「得分第一≠胜者」）；`worker/test/leaderboard.test.ts`（新增 7 例）。未接 room.ts（N28 发布）、未动 ranking.ts/协议。
- **单测**：worker `npx vitest run`→0（**22 文件 / 176 例**：leaderboard 7 例——方案 §6 六分数例排序+跳号 rank 1,2,3,3,5,6；同分不同消行共享名次 1,1,1 且消行降序→加入序升序显示；eliminated 留榜首（得分第一≠胜者）；disconnected 状态携带不扰序；乱序两组输入 deep-equal 同一份+arity=1 排除观看者参数；负向：消行 99 不翻转分数序、单条 rank=1、空输入空输出；topScorePlayerIds 并列多人+乱序集合不变+空）。
- **本地模拟**：纯函数无服务端接线；复审独立复跑 tsc 0/vitest 22/176 与证据逐字吻合；手验竞赛排名 [5,5,5,3]→1,1,1,4、[5,3,3]→1,2,2。
- **实测排障**：无（纯新增模块）。
- **命令与退出码**：worker vitest→0（22/176）；worker tsc→0；根 vitest→0（17/300）；根 tsc→0；build→0；playwright→0（7 passed）；deploy.yml 未动（5A08B009）。
- **复审结论**：独立只读复审 PASS（无 P1、无 P2；O1 topScorePlayerIds 隐含输入已降序前提→已改 Math.max 顺序无关+补乱序断言；O2 NaN 分数破坏全序由 N25 快照校验入约兜底（服务端每 revision 仅算一份广播，验收无威胁）；O3 arity 断言系弱代理，合看 TS 签名足够）。
- **未解决事项**：无阻塞；N28 在 room.ts 消费 buildLeaderboard 做 dirty 批处理 ≤2Hz 发布（ScoreboardMsg.revision 统一管理，全员同 revision）。

## N28 服务端排行榜 dirty 批处理与发布 ✅ PASS
- 范围：`worker/src/room.ts` + 假时钟测试（新增 `room-scoreboard.test.ts` 10 用例；共享夹具 `room-routing-helpers.ts`）。
- 实现：
  - 房间级单调 `#revision`：countdown/match_start/player_left/match_end/remote_snapshot 扇出/watch_target/协议 error/scoreboard 全部经 `#nextRevision()`，废除硬编码 1；不变式限定「同一连接内同 revision ⇒ 内容一致」（`shared/protocol.ts` 注释修订，复审 O-1）。
  - dirty 批处理：`#markScoreboardDirty(immediate, now)`——成绩/断线/重连走事件时间戳门控（≥500ms 立即发；静默窗内合并为**单个一次性 setTimeout**，无常驻 500ms 定时器、无每变更 Alarm）；淘汰/终局走立即通道（终局两处统一传事件 now，复审 O-3）。
  - `#flushScoreboard`：dirty 才重排（不按每快照全员重排）；数据源=冻结名单+eliminations+seats.disconnected_at+内存快照槽（**零写库**）；entries JSON 与上次一致则跳过发布（不占 revision，方案 §5「无变化不重复推送」）；驱逐重建后槽全空且已开球 ≥500ms 跳过发布（0 分假榜不覆盖正确榜，复审 P2-1）；全员同一份 entries+revision。
  - 触发点：快照入账（score/lines 变化才标脏）、批量淘汰、两处终局、断线/重连、开局首榜；startGame/nextRound/releaseRoomData 重置批处理态（防陈旧定时器跨局补发）。
- 验收：6 人 5Hz×5s=150 帧压力下榜单含首榜 ≤11 条（≤2Hz）且全员逐字段一致；无变化时零广播、`vi.getTimerCount()===0`；静默窗内多次变化仅 1 定时器、到点一次发布最新值；淘汰即时广播且死人留榜分数冻结（420 分实测）；压力全程 sql.exec 语句级 spy：零 UPDATE/DELETE/REPLACE、INSERT 仅幂等 ensureRow、行数不变、alarmCalls 不新增（复审 P2-2/O-4）；revision 严格递增；终局立即发布最终榜（得分降序不切换）；被淘汰者后续快照不再触发；跨局批处理态作废；驱逐重建槽空跳过假榜、入账后重建真榜。
- 旧测试适配：alarm/countdown/elimination/grace 的 `revision: 1` 硬编码断言放宽为 `expect.any(Number)`（N28 语义即废除硬编码）；countdown 用例消息数 2→3（新增首榜，断言增强）。
- 门槛：worker tsc=0、worker vitest 23 文件/186 全绿；根 vitest 300 全绿、根 tsc=0、build=0、Playwright 7/7。证据 `evidence/multiplayer/N28/`。
- 复审：独立只读复审 PASS（P1×0、P2×2 均已在提交前修复：P2-1 驱逐守卫+用例、P2-2 语句级断言）。
- 遗留观察：淘汰风暴（6 人连续立即通道）最坏 6 条榜单/瞬时——受席位规模约束，可接受；`#revision` 内存态跨驱逐归零已在协议注释文档化（O-2）。


## N29 自动观战目标纯函数 ✅ PASS
- 范围：`worker/src/watch-target.ts`（新）+ `worker/test/watch-target.test.ts`（新 11 用例）。未触碰 room/协议/客户端。
- 实现（方案 §6.2 精确定义）：候选=本局全体参赛者排除本人（含已淘汰者，冻结分仍参与）；规则 1 选 `score>` 本人者中最低分（「刚好更高」），同分消行数**降序**→加入顺序升序；规则 2 无更高者（独占/并列最高）→其他玩家最低分，并列消行数**升序**→加入顺序升序（两规则 tie-break 方向不同为方案原文规定）；永不选本人；观看者不在名单/仅本人/空名单→null。纯函数：无时间/随机/IO，不修改输入，joinOrder 唯一保证输入顺序无关。
- 验收：方案 §6.2 六人例（A→B、D→B、E→C、C→F、B→E、F→A）；两人互看；两人同分；六人全同分（各选消行最少者，C 自己按 join 升序选 A）；并列最高（X/Y→Z）；淘汰者参与（淘汰高分者仍是目标、淘汰者作观看者）；规则 1 同分消行降序/join 升序；规则 2 同分消行升序/join 升序；高低分轮换 12 组×4 观看者=48 个确定性断言（每步恒式「不为本人」）；乱序不变+输入不被修改；负向 null 三例+同分不算更高。
- 门槛：worker tsc=0、worker vitest 24 文件/197 全绿；根 vitest 300 全绿、根 tsc=0（N29 为 worker 侧纯新增，根构建/E2E 无涉）。证据 `evidence/multiplayer/N29/`。
- 复审：独立只读复审 PASS（P1×0、P2×1：根目录临时条目文件不入库——已按流程在提交前删除并移入执行日志；O×4）。复审员独立推演轮换 12 组×4 观看者=48 断言逐格一致，无侥幸通过；确认两规则消行 tie-break 方向（降序/升序）与方案 L147/L148 一致、严格 `>` 语义、纯函数无副作用。
- 交接 N30：room.ts 将用 `match_roster`（join_order **必须唯一**，复审 O-1）+ 快照槽 score/lines 构造 `WatchCandidate[]`，仅在排行榜 revision/房间状态变化时按入站事件合并重算（≤1s 稳定、500ms 防抖属 room 侧，方案 L149），逐席位单发 `watch_target`，不修改公共排行榜。


## N30 自动观战目标切换（随榜单发布事件重算） ✅ PASS
- 范围：`worker/src/room.ts`（默认环→自动目标）+ 新增 `room-watch.test.ts` 8 用例 + 适配 `room-routing.test.ts`/`room-countdown.test.ts`。
- 实现：
  - 删除 `#buildDefaultWatchRing`；新增 `#applyAutoWatchTargets(generation)`：候选=match_roster 全体（含淘汰/断线/倒计时离席者，冻结分仍参与）、观看者=roster∩现存席位；逐候选跑 N29 `pickWatchTarget`，仅目标变化者记入 changed。
  - 重算钩子挂在 `#flushScoreboard` 成功广播之后（唯一发布点）：复用已读名单/槽，**不新增定时器**（复用 `#sbTimer` ≤500ms 合并窗 ⇒ 切换 ≤1s 稳定）；dedupe/守卫早退路径不重估（数据未变⇒目标不变）。
  - `#notifyWatchTargets`：changed 非空才发；整批共享一个 `#nextRevision()`；逐观看者单发 `watch_target`（公共排行榜 entries 不因目标而变）；切换即 `#outSlots.delete(connId)` 弃旧目标待补帧；目标已有本局最新帧则紧随补发（经背压单槽）。
  - `advanceToRunning` 不再预置环：首榜发布即触发重估+全员通知；驱逐惰性重建（`#ingestSnapshot`/`setWatchTarget` 空映射路径）改为**先于** dirty/flush 的静默重算（防 flush 把全席位判为变化而补发重复帧）；手动 `setWatchTarget`=临时覆盖，下一次发布被自动重估覆盖（文档化）。
  - 复审 P2-1 修复：驱逐+延迟开赛（`advanceToRunning(now≥startAt+500)`、槽全空）首榜被 N28 空槽守卫跳过⇒钩子不跑——flush 后若映射仍空则直接建立自动目标并通知（全零基线，随快照入账自纠）；复审 O-2 修复：flush 钩子加 RUNNING 门控（终局最终榜发布后不再发 watch_target/补帧）。
- 验收：A/B/C 各看不同对象（A→B、B→C、C→A）时三份 scoreboard entries JSON 逐字段一致（验收 A）；旧目标排队帧即弃（outSlots 1→0）+ 旧目标后续帧不入流、新目标帧入流（验收 B）；切换恰在事件后 500ms 合并点到达（499ms 未到/500ms 到，≤1s）且全程 `getTimerCount()≤1` 无常驻定时器；淘汰者仍可为目标（冻结最后一帧 seq1 补发实测）与观看者（仍收 watch_target）；淘汰者新快照被 N25 拒收⇒观看者保持冻结帧；手动覆盖被下一次发布覆盖；entries 去重/陈旧 seq 丢弃⇒不重估不通知。
- 旧测试适配：routing 环语义→自动目标语义（开局全零分 ids[0]→ids[1]、其余→ids[0]；leaveRoom/P2-1/P2-2 按新语义重写）；countdown 消息数 3→4（新增首个 watch_target，断言增强目标载荷）。
- 门槛：worker tsc=0、worker vitest 25 文件/205 全绿；根 vitest 300 全绿、根 tsc=0、build=0、Playwright 7/7。证据 `evidence/multiplayer/N30/`。
- 复审：独立只读复审 PASS（P1×0、P2×1 已在提交前修复：P2-1 驱逐+延迟开赛 watch_target 缺失洞→advanceToRunning 兜底建立+通知+专测「驱逐后延迟 600ms 开赛：假榜仍跳过、目标全量下发、入账后不重复通知、路由单流生效」；O×4）。复审员独立复跑全部数字吻合；手工推演 T2/T3/T4/T5/T6/T7 期望值逐格一致无侥幸；确认重算调用点仅 3 处、无新增定时器、revision 批次共享不违反 protocol 注释（限定单连接）、跨局清映射 6→0→6。
- 遗留观察：O-1 手动目标在活跃对局下一次发布（≤500ms）即被自动覆盖——符合方案 §6.2.4，已文档化+T6 钉死，若需「手动钉住」属方案级决策；O-3 驱逐后首帧目标基于「1 槽+其余全零」与同刻榜单同源、≤1s 自纠（延迟开赛路径已有专测）；O-4 日志回填即本条；N26 O6（`BAD_STATE`/`INVALID_TARGET` 未入 shared 错误目录）重新归属：N30 未接线（`setWatchTarget` 仅测试调用、无 WS/HTTP 错误面），移交 N31+ 客户端接线时一并映射入 `shared/errors.ts`。


## G2 — 关口验收（N22–N30）✅ PASS

- **基线 HEAD**：`eb05fab`（N30 之后）
- **验收范围**：清单 §6 关口 G2——N22–N30 全部 9 项通过；限流、5Hz/2Hz、单订阅目标、统一榜单与自动观战有数据证据。
- **完整性核对**：日志 N22–N30 九项均 ✅ PASS；提交链 `377d166..eb05fab` 恰 9 个 feat 逐项对应（另 docs(N27) 仅日志）；`evidence/multiplayer/N22..N30/` 原始输出齐备（抽查 N22/N25/N28/N30 与日志数字逐字吻合）；deploy.yml 仍仅 2 条历史提交（63c29d3、1963218）未触碰。
- **四要素可测性**：限流=http-ratelimit（分端点窗口、4100 IP→桶封顶 4096、429+Retry-After）+room-snapshot（20/s、4KiB 字节门槛、seq 双单调、6 人×100Hz×60s 管线有界）；5Hz/2Hz=publisher 钳制封闭+scoreboard 压力 150 帧含首榜 ≤11 条、去重零广播、无常驻定时器；单订阅=routing total=90（O(N²)=540）、背压单槽、P2-1/P2-2；统一榜单=leaderboard 并列跳号+全员同 entries/revision 逐字段一致；自动观战=watch-target 11 例（§6.2 六人例+48 格轮换）+room-watch 8 例（验收 A/B、≤500ms 合并点、淘汰者参与、驱逐+延迟开赛兜底）。
- **复跑与退出码**：worker `npx vitest run`→0（25/205）；worker `npx tsc --noEmit`→0；根 `npx vitest run`→0（17/300）；根 `npx tsc --noEmit`→0；`npm run build`→0；`npx playwright test`→0（7 passed）。证据 `evidence/multiplayer/G2/{gate-report,worker-vitest,worker-typecheck,root-vitest,root-typecheck,root-build,e2e}.txt`。
- **复审结论**：独立只读关口复审 PASS——日志/证据/提交链三方一致，复跑数字与 N30 证据吻合，四要素逐项有测试锚点+压力数据，无关口级缺口；P2×2（G2 证据目录未入库、gate-report 引用两个 tsc 文件缺失）已在关口提交前修复（补文件+入库），O×3（N26 O6 重新归属 N31+、日志标题层级已统一、N29 O 计数粒度）留痕。
- **未解决事项**：无关口级缺口；N26 O6 错误目录映射移交 N31+；进入 N31（P3 客户端：连接与大厅）。

## N31 — 联网 API/WS 客户端与生命周期 ✅ PASS

- **范围**：新建 `src/net/client.ts`（NetClient：REST create/join/ticket + WS 连接/发送/断开/退避重连/版本处理/sessionStorage 席位凭据/中文提示）；`src/net/index.ts` 增导出；新建 `tests/unit/net-client.test.ts` 20 例。
- **实现要点**：单飞 `#connectPromise` 首个 await 前同步置位（并发 connect 复用同一次握手）；重连等待期 connect() 早退不并发；握手 URL 仅含一次性票据（`?ticket=`），seatToken 只进 POST body 与 sessionStorage，全文无日志；退避 500ms×2ⁿ 封顶 8000ms，预算从首断墙钟累计（仅 open 重置），累计+下一次 delay>30s 即放弃并中文提示；版本不匹配（error 帧/v≠1/close 1002）致命不重连；S→C 轻量校验 v 精确 + type ∈ SERVER_MESSAGE_TYPES；`send` 自动补连接内单调 seq；单人无自启动副作用。
- **测试**：20 例全绿——正向（凭据落盘、URL 精确等值不含 seatToken、退避 499/500 精确到点、预算 ctor=7 后放弃零残留定时器、seq 单调、主动 close 不重连、leave 清凭据）；反向（ROOM_FULL 中文不落盘、无凭据/401 不建连、v≠1 致命不重连、未知 type 静默忽略）。
- **门槛**：worker tsc=0、worker vitest 25 文件/205 全绿（无回归）；根 vitest 18 文件/320 全绿、根 tsc=0、build=0、Playwright 7/7。证据 `evidence/multiplayer/N31/`。
- **复审**：独立只读复审 PASS（P1×0、P2×4 全部提交前修复+专测：P2-1 票据在途 leave() 僵尸连接→new WS 前守卫复查 closedIntentionally/fatal；P2-2 close-1002-only 分支假覆盖→补无 error 帧专测；P2-3 重连期票据失败零测试→补 GENERATION_STALE 韧性专测并增 onClose 通知；P2-4 致命粘滞→leave()/成功取得席位清 fatal）。复审员独立复跑 15+7 全绿、验收条款逐项核验通过。
- **遗留观察**：O-1 N26 `BAD_STATE`/`INVALID_TARGET` 仍未入 shared 错误目录（describeError 回退 INTERNAL），N32+ 需要精确文案时再入目录；O-3 重连超时文案为客户端本地语义硬编码；O-4 close() 不清 disconnectedAt（预算从首断累计，比服务端新宽限保守，注释钉死）；O-5 WS 4003 席位替换触发自动重连，双标签页互抢为 N32 装配层决策点；O-6 REST 失败重试策略移交 N32/N34 按 UI 语义决定。

## N32 — 模式入口与创建/加入 UI ✅ PASS

- **范围**：新建 `src/ui/mp-entry.ts`（分流条 + 创建/加入面板 + 纯校验助手，纯 DOM 无网络）；重写 `src/app/multiplayer.ts`（NetClient 接线）；`src/main.ts` 分流条装配；`src/styles/app.css` 面板样式；新建 `tests/unit/mp-entry.test.ts` 8 例、`tests/e2e/mp-entry.spec.ts` 4 例（双 project）；`playwright.config.ts` testMatch + webServer env。
- **实现要点**：分流条仅构建期配置 `VITE_MULTIPLAYER_API_URL` 时渲染（未配置=单机路径零变化）；单人分支必须在 `boot()` 之后渲染分流条——`mountLayout` 会 `root.textContent=''` 清空重建（首版 bug 已修+注释钉死）；面板仅需昵称+房间码，无登录/注册；本地预校验与 `shared/protocol` 同源（NICKNAME_PATTERN/ROOM_CODE 边界），服务端为最终权威；错误文案走 RestResult（describeError 中文目录）；按钮 busy 禁用防连点；teardown 关连接+移除面板。
- **测试**：单测 8 例——正向（合法昵称/边界码 100000/999999 通过并 trim、main.ts 条件渲染结构断言、multiplayer 经 ../net 接线不直接 fetch/WS、样式 44px/16px 钉死）；反向（中文/超长/空昵称、5 位/7 位/012345/字母房间码 → 中文提示、面板无 password/login 标识）。E2E 8 例（4×chromium+mobile）——分流条可达、中文控件 role 定位、boundingBox ≥44px、聚焦无横向溢出、`input[type=password]`=0、合法加入无 Worker → 中文降级「服务器暂时无法访问」。
- **门槛**：worker tsc=0、worker vitest 25 文件/205 全绿（无回归）；根 vitest 19 文件/328 全绿、根 tsc=0、build=0（multiplayer chunk 11.45 kB 独立、主包 35.67 kB 无网络代码）、Playwright 15/15（原 7 + 新 8）。证据 `evidence/multiplayer/N32/`。
- **复审**：独立只读复审 PASS（P1×0、P2×0、O×7）。复审员独立复跑全部数字与证据吻合（chunk hash 亦相同）；验收 a–f 逐项核验通过（同源正则、服务端权威未削弱、默认构建主包 tree-shake 掉分流条、deploy.yml 未触碰）。
- **遗留观察**：O-1 创建房间默认 `capacity:4/randomMode:'S1'/startLevel:1`，房主可改属 N33 大厅；O-2 加入/创建成功后仅中文提示「席位已保留」，无 WS 自动连接与大厅跳转（N33 接线 `client.connect()`）；O-3 双标签页席位互抢（N31 O-5）仍未装配处理，N33 大厅期决策；O-4 REST RATE_LIMITED 退避重试（N31 O-6）当前为手动重试（按钮恢复可用），N34 对局期再评估；O-5 分流条在单人页渲染于 boot 之后（顺序约束），若未来布局重构需保持；O-6（复审）E2E 降级用例依赖 8787 无监听（假失败非假通过，证据含端口检查）；O-7（复审）联网分支动态 import 无 .catch、href 丢弃其它 query、busy/teardown 无直接行为测试——均移交 N33 大厅装配期一并处理。


