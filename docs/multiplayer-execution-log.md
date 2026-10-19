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
