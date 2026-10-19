# Neon Blocks 网页游戏开发：原子任务清单 v1.0

> 日期：2026-10-15｜目标执行模型：Qwen3.8-Flash-Next-IQ3_S｜任务状态：均未实施
> 唯一规格文件：`Neon_Blocks_开发规格_v1.0.md`；导入代码仓库后路径：`docs/GAME_SPEC.md`。**本清单不是已完成项目或真实测试报告。**

## 0. 执行总规程（Agent 必读）

1. **严格串行**：只处理最早一个未完成、且其“依赖”全部 PASS 的任务；每轮只写本任务允许的代码和测试。不能批量领取、不能提前勾选、不能自创需求。即使一次性读完清单，也只完成当前一个任务。
2. **先读指定内容**：任务下方 `规格` 标记对应规格文档章节（如 S03.4），精确读取即可；不要在每次任务将所有历史日志和整份文档重复喂入模型。检查相关源码后按文字逐步操作。
3. **修改边界**：原则上只改列出的文件。若已有代码需要为接口联通做小改，允许追加 1 个直接依赖文件，但必须在日志说明；涉及改技术栈、规则、色板、验收标准、引入运行时依赖，必须先停止申请规格变更。
4. **验证闭环**：执行任务指定命令；T001 仅执行模板现有构建，T002–T003 执行 typecheck/build，T004 开始必须执行 `npm run typecheck && npm run test && npm run build`；仅 E2E 首次可用后才要求 e2e（T057 以后所有任务增加 `npm run test:e2e`）。浏览器/截图任务必须提供可检验浏览器证据。
5. **出错阻断**：任一指定命令失败、关键人工验收无法执行或断言不满足，任务维持 `[ ]`，执行日志记 `BLOCKED/FAIL` 和复现命令，修复并重验后才继续。**没有执行过的测试不能声称通过。** 不能放宽测试、不能删除失败断言、不能跳过任务。
6. **勾选与日志的原子性**：全部验证 PASS 后，先将时间/文件/执行命令及退出码/结果写入 `docs/execution-log.md`，再把唯一一个 `[ ]` 改为 `[x]`。若有提交权限，可每次独立 commit（不是通过条件）；无 Git 不编造提交。
7. **已知前置**：运行环境需 Node >=22.12、npm、浏览器；E2E 需 Chromium。无法下载依赖可阻断但不得替代成伪造结果。用户交付两个 Markdown 文件时，T003 负责将两文件复制到实际项目 `docs/`。

### 每轮固定回报格式（供低能力模型复制使用）

```text
当前任务：Txxx <任务名>
结果：PASS / FAIL / BLOCKED
修改文件：...
实现动作：①...②...③...
执行命令与退出码：...
自动测试：通过 X / 失败 Y / 未运行 Z
人工/浏览器证据：截图路径或“未验证及原因”
执行日志：docs/execution-log.md 中的记录行
下一项：只有 PASS 才说明下一 ID；FAIL/BLOCKED 则停在本 ID
```

## 1. 阶段与验收关口

| 阶段 | 交付成果 | 阶段关口 |
|---|---|---|
| P0 | 工程初始化、版本与测试基线 | build/typecheck、smoke 测试通过 |
| P1 | 无浏览器依赖的方块/棋盘/SRS/计分 | 核心单元测试通过 |
| P2 | 单人完整可运行 GameEngine | 游戏逻辑全量单测通过 |
| P3 | 桌面/移动 UI 视觉骨架与 Canvas | 视口与静态画面验收 |
| P4 | 键鼠/触控/设置/音频 | 组件与交互功能齐备 |
| P5 | 装配整体、失焦暂停、分数持久化 | 能手动完成游戏闭环 |
| P6 | 自动化、性能、视觉、部署 | 四命令均通过、人工截图核验 |

**验收顺序不可颠倒**：先纯逻辑，再引擎，再 UI 与输入，最后整体验证。初始所有任务 `☐`，不提前假定环境、构建或实测结果。

## 2. 逐项原子任务

### P0 环境与工程

#### - [x] T001｜创建 Vite 原生 TS 工程
- **依赖**：无。**允许修改文件**：`package.json、index.html、src/main.ts、tsconfig*.json、.gitignore`。**规格**：S02。
- **明确步骤**：
  1. 在空项目目录执行 `npm create vite@latest . -- --template vanilla-ts --no-interactive`；若目录非空先检查冲突，禁止覆盖用户文件。
  2. 执行 `npm install`，保留 lockfile；删掉模板演示计数器样例，不添加第三方框架。
  3. 确认 `git status` 中不存在 `node_modules`。
- **验证命令/动作**：`npm run build`、`npm run dev -- --host 127.0.0.1`（检查正常响应后停止）。
- **通过条件**：浏览器可打开空白项目页面；构建退出码 0；仅使用 vanilla-ts。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T002｜固定脚本和开发依赖
- **依赖**：T001。**允许修改文件**：`package.json、package-lock.json、vite.config.ts`。**规格**：S02。
- **明确步骤**：
  1. 安装 `vitest` 与 `@playwright/test` 开发依赖。
  2. 添加规格 S02 中的 6 个 npm 脚本，保持 `typecheck` 的 `tsc -b` 契约。
  3. 仅当 Vitest 配置确有需求时写 `vite.config.ts`；不要增加 ESLint/React。
- **验证命令/动作**：`npm run typecheck`、`npm run build`；此时尚无测试，单元测试从 T004 起列入通用门禁。
- **通过条件**：所有 npm 脚本存在；typecheck/build 为 0；依赖写入 lockfile。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T003｜归档两份输入文档和建立执行日志
- **依赖**：T001。**允许修改文件**：`docs/GAME_SPEC.md、docs/TASKS.md、docs/execution-log.md`。**规格**：S09。
- **明确步骤**：
  1. 原样复制用户提供的开发规格到 `docs/GAME_SPEC.md`，任务清单到 `docs/TASKS.md`；不得自行改写。
  2. 创建 execution-log，表头固定 `ID | 时间 | 修改文件 | 命令与退出码 | 验收证据 | 结论/阻塞`。
  3. 新增 T001/T002 已核实的历史日志记录，未知结果写“未验证”而非猜测。
- **验证命令/动作**：核对 `docs/GAME_SPEC.md`/`docs/TASKS.md` 与输入版本；查看日志有表头。
- **通过条件**：三份文档存在；文档无截断；日志格式可持续追加。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T004｜建立 Vitest 的最小工作样例
- **依赖**：T002。**允许修改文件**：`tests/unit/smoke.test.ts（后续可保留）、vite.config.ts（仅必要时）`。**规格**：S02,S08。
- **明确步骤**：
  1. 新建 `smoke.test.ts`，包含 `expect(1+1).toBe(2)`。
  2. 确认 Vitest 在 node 环境，不依赖 DOM。
  3. 修正配置使 `npm run test` 能自动检索 `tests/unit/**/*.test.ts`。
- **验证命令/动作**：`npm run test`。
- **通过条件**：至少 1 个测试通过；exit code 0；不得跳过测试。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T005｜配置 E2E 浏览器与服务器
- **依赖**：T002。**允许修改文件**：`playwright.config.ts、tests/e2e/smoke.spec.ts`。**规格**：S02,S08。
- **明确步骤**：
  1. 配置 Chromium desktop 与 mobile-chrome 两个 project；设置 project `testMatch`：chromium 仅执行 `desktop.spec.ts` 与 `smoke.spec.ts`、mobile-chrome 仅执行 `mobile.spec.ts` 与 `smoke.spec.ts`，以免跨设备误跑；为测试配置 Vite `webServer` 自动启动 localhost 固定端口 4173（命令 `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort`）。
  2. 新建 smoke 用例检查页面 `<body>` 可见；截图目录用 `test-results/`。
  3. 在可安装浏览器的环境执行 `npx playwright install chromium`。
- **验证命令/动作**：`npm run test:e2e -- --project=chromium`。
- **通过条件**：至少 1 个 smoke 测试通过；webServer 可启停；若浏览器安装被阻断则标 BLOCKED。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T006｜制作原创品牌 favicon SVG
- **依赖**：T001。**允许修改文件**：`public/favicon.svg、index.html`。**规格**：S04.4。
- **明确步骤**：
  1. 用 `viewBox="0 0 64 64"` 绘制 4 个阶梯排列的小矩形（圆角不超 5），色彩 `#A58CFF` 与 `#45D6E8`。
  2. 关联 `<link rel="icon" href="/favicon.svg">`；不要引入第三方图片或官方 Logo。
- **验证命令/动作**：`npm run build`，浏览器 Network 确认 favicon 无 404。
- **通过条件**：SVG 有效、图标在深色页面可分辨、构建成功。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T007｜写定基础设计 Token
- **依赖**：T001。**允许修改文件**：`src/styles/tokens.css、src/main.ts`。**规格**：S04.2。
- **明确步骤**：
  1. 按 S04.2 写根级 CSS 变量（全色板、字体、圆角、间距）。
  2. 让 main.ts 仅导入 token 样式，暂不引入未创建模块。
  3. 定义全局 `box-sizing:border-box`、深色页面基础色，保留焦点可见样式位置。
- **验证命令/动作**：`npm run typecheck && npm run build`。
- **通过条件**：变量名及 hex 值与规格逐一对应，无外部字体请求。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

### P1 纯逻辑

#### - [x] T008｜定义类型与状态结构
- **依赖**：T001。**允许修改文件**：`src/game/types.ts`。**规格**：S03。
- **明确步骤**：
  1. 创建 `PieceType`、`Cell`、`Board`、`ActivePiece`、`GameStatus` 联合类型。
  2. 创建 `GameState`，含 `board,active,nextQueue,bag,heldType,holdUsedThisPiece,status,score,lines,level,gravityElapsedMs,lockElapsedMs,lockResetCount,lastEvent`。
  3. `lastEvent` 类型为 `null | {id:number,kind:"lock"|"hardDrop"|"clear"|"gameover",count?:number}`，明确状态数据定义；禁止 `any`。
- **验证命令/动作**：`npm run typecheck`。
- **通过条件**：导出类型可被其他文件导入；strict 编译无错误。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T009｜固定棋盘与时间常量
- **依赖**：T008。**允许修改文件**：`src/game/constants.ts`。**规格**：S03.1,S03.3。
- **明确步骤**：
  1. 定义 `BOARD_WIDTH=10`,`BOARD_HEIGHT=24`,`HIDDEN_ROWS=4`,`VISIBLE_ROWS=20`,`LOCK_DELAY_MS=500`,`LOCK_RESET_LIMIT=15`。
  2. 定义 `DAS_MS=150`,`ARR_MS=45`,`SOFT_DROP_MS=35` 和等级 1–10 下落表。
  3. 常量使用 `as const` 并导出；不得出现第二套魔法数字。
- **验证命令/动作**：`npm run typecheck`。
- **通过条件**：所有数值与 S03 相同；无循环引用。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T010｜写七种出生形状矩阵
- **依赖**：T008。**允许修改文件**：`src/game/pieces.ts、tests/unit/pieces.test.ts`。**规格**：S03.1。
- **明确步骤**：
  1. 按 S03.1 原样定义 I/O 的 4×4 和五种 3×3 的 0 态矩阵。
  2. 暴露 `getMatrix(type,rotation)`；此任务 rotation=0 需完整正确，其他旋转态先可显式报未实现，不得伪装完成。
  3. 测试七种每个恰好 4 格、初态逐行匹配规格。
- **验证命令/动作**：`npx vitest run tests/unit/pieces.test.ts`。
- **通过条件**：七种初态全部通过、每种都是 4 个实体格。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T011｜实现固定阵列的四旋转态
- **依赖**：T010。**允许修改文件**：`src/game/pieces.ts、tests/unit/pieces.test.ts`。**规格**：S03.1。
- **明确步骤**：
  1. 添加 `rotateMatrixCW`，返回固定尺寸的新阵列，不剪边。
  2. 以 0 态连续旋转 1/2/3 次缓存 4 态；O 四态相同。
  3. 增加旋转四次恢复、每态 4 格、I 竖态列位置测试。
- **验证命令/动作**：`npx vitest run tests/unit/pieces.test.ts`。
- **通过条件**：7×4 个矩阵合法；旋转回原位；无原地突变。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T012｜实现可注入随机的 7-bag
- **依赖**：T008。**允许修改文件**：`src/game/random.ts、tests/unit/random.test.ts`。**规格**：S03.2。
- **明确步骤**：
  1. 用 Fisher–Yates 打乱含全部 7 种方块的数组。
  2. 提供 `drawFromBag(bag,rng)`（可返回新 bag 与 type，或小类）；随机仅在用尽袋时调用。
  3. 以确定性随机函数验证连续 14 枚每组 7 枚互不重复、同序列稳定。
- **验证命令/动作**：`npx vitest run tests/unit/random.test.ts`。
- **通过条件**：两袋各含七种不重、不漏；不会在调用 `draw` 外消耗随机。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T013｜创建与复制棋盘
- **依赖**：T008, T009。**允许修改文件**：`src/game/board.ts、tests/unit/board.test.ts`。**规格**：S03.1。
- **明确步骤**：
  1. 定义 `createEmptyBoard()`，填满 24×10 个 null。
  2. 定义 `cloneBoard(board)`，深复制行。
  3. 测试尺寸、独立行引用与原棋盘不被改动。
- **验证命令/动作**：`npx vitest run tests/unit/board.test.ts`。
- **通过条件**：每行 10 格；改变复制不影响原棋盘。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T014｜实现占用格碰撞判断
- **依赖**：T011, T013。**允许修改文件**：`src/game/board.ts、tests/unit/board.test.ts`。**规格**：S03.1。
- **明确步骤**：
  1. 添加 `canPlace(board,piece):boolean`；只检查矩阵为 1 的格。
  2. 拒绝实体格左/右/上/下越界及与锁定格重叠。
  3. 测试空矩阵边缘允许、四方向实体格越界拒绝、穿透拒绝。
- **验证命令/动作**：`npx vitest run tests/unit/board.test.ts`。
- **通过条件**：至少含 6 组边界断言、无抛出/非法索引。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T015｜将落地方块锁入棋盘
- **依赖**：T014。**允许修改文件**：`src/game/board.ts、tests/unit/board.test.ts`。**规格**：S03.1,S03.5。
- **明确步骤**：
  1. 创建 `mergePiece(board,piece)`，返回新 Board。
  2. 对每个实体格写入对应 PieceType；输入无效时显式抛错（引擎只在有效位置调用）。
  3. 测试恰好新增四格、原棋盘保持不变、越界不能默默忽略。
- **验证命令/动作**：`npx vitest run tests/unit/board.test.ts`。
- **通过条件**：4 格锁入正确坐标；入参不被修改。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T016｜实现同时消除满行
- **依赖**：T013, T015。**允许修改文件**：`src/game/board.ts、tests/unit/board.test.ts`。**规格**：S03.5。
- **明确步骤**：
  1. 实现 `clearFullRows(board):{board,cleared}`，筛掉所有满 10 格的行。
  2. 在顶部一次性补足 null 行，非满行原顺序不变。
  3. 测试清 0/1/2/4 行、清除后 24×10 不变、其余行下移位置准确。
- **验证命令/动作**：`npx vitest run tests/unit/board.test.ts`。
- **通过条件**：各测试预期行位置准确；不逐行消除造成跳漏。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T017｜录入完整 SRS 墙踢静态表
- **依赖**：T008。**允许修改文件**：`src/game/srs.ts、tests/unit/srs.test.ts`。**规格**：S03.4。
- **明确步骤**：
  1. 将 S03.4 的 J/L/S/T/Z 和 I 两组八方向各五偏移抄入 readonly 常量。
  2. 使用坐标 y 向下的表，不做二次变换；导出 `getKickOffsets(type,from,to)`。
  3. 检查首偏移 `(0,0)`、I 的 0→1 含 `(-2,0)`、O 不踢墙。
- **验证命令/动作**：`npx vitest run tests/unit/srs.test.ts`。
- **通过条件**：16 组偏移长度=5、顺序与文档逐项一致。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T018｜实现 SRS 顺转/逆转
- **依赖**：T011, T014, T017。**允许修改文件**：`src/game/srs.ts、tests/unit/srs.test.ts`。**规格**：S03.4。
- **明确步骤**：
  1. 新增 `tryRotate(board,piece,dir)`；计算 0/1/2/3 的循环目标态。
  2. 顺序尝试 kick，遇首个可放置返回新 piece，全部失败返回原 piece；O 不移动。
  3. 测试自由旋转、靠左/右墙、靠地、阻挡全失败、I 特例、逆旋。
- **验证命令/动作**：`npx vitest run tests/unit/srs.test.ts`。
- **通过条件**：墙边旋转成功且不穿墙；阻挡时 x/y/rotation 完全不变。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T019｜实现幽灵块落点计算
- **依赖**：T014。**允许修改文件**：`src/game/board.ts、tests/unit/board.test.ts`。**规格**：S03.2,S04.1。
- **明确步骤**：
  1. 新增 `getGhostY(board,piece):number`，只循环下探直到下一格冲突。
  2. 不修改棋盘、active、分数或随机源。
  3. 测试空棋盘、堆叠顶、当前已在底部三种情况。
- **验证命令/动作**：`npx vitest run tests/unit/board.test.ts`。
- **通过条件**：返回合法最大 y，`y+1` 必冲突；无状态副作用。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T020｜实现分数纯函数
- **依赖**：T008。**允许修改文件**：`src/game/scoring.ts、tests/unit/scoring.test.ts`。**规格**：S03.5。
- **明确步骤**：
  1. 定义 `lineClearPoints(cleared,level)` 支持 0..4、`dropPoints(kind,cells)` 支持 soft/hard。
  2. 映射 0/1/2/3/4 为 0/100/300/500/800×level；soft 1、hard 2。
  3. 测试 4 行×2 级=1600、soft 3=3、hard 3=6、0=0，非法输入显式拒绝。
- **验证命令/动作**：`npx vitest run tests/unit/scoring.test.ts`。
- **通过条件**：分数表与 S03.5 全匹配。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T021｜实现等级与重力公式
- **依赖**：T009, T020。**允许修改文件**：`src/game/scoring.ts、tests/unit/scoring.test.ts`。**规格**：S03.3,S03.5。
- **明确步骤**：
  1. 导出 `levelForLines(totalLines)`，公式 1+floor(lines/10)。
  2. 导出 `gravityIntervalMs(level)`，按 L1–L10 表和 L11+ 公式，底线 60ms。
  3. 测试 lines=0/9/10/20，L1/L10/L11/L30、L30>=60。
- **验证命令/动作**：`npx vitest run tests/unit/scoring.test.ts`。
- **通过条件**：等级边界准确，重力随等级不增加。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

### P2 游戏引擎

#### - [x] T022｜创建 Engine 与初始 ready 状态
- **依赖**：T008, T012, T013。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.2,S03.3。
- **明确步骤**：
  1. 创建 GameEngine(rng=Math.random, initialBoard?:Board) 类，保存私有 state、rng、事件自增序号。
  2. 初始化 ready/null active/空 hold/分数 0/等级 1/空棋盘。
  3. 导出只读 `getState()`，单测检查初态（不可通过 UI 直接修改）。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：ready 状态完整、所有字段有正确初值。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T023｜填充 NEXT 队列及生成活动块
- **依赖**：T011, T012, T014, T022。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.1,S03.2。
- **明确步骤**：
  1. 添加私有 `refillQueue()`，使 nextQueue 长度始终保持 5。
  2. 添加私有 `spawnNext()`：shift 队首→在 x3/y2/r0 放置→补队列；入场碰撞则 status=gameover。
  3. 在此任务先实现 `start()`：仅 ready→running、调用 spawnNext；单测第一块有效、队列始终 5、首块确定性。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：出生位置/初态对；任何时候 NEXT 至少 5 个。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T024｜实现 Engine 的水平移动
- **依赖**：T014, T022, T023。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3。
- **明确步骤**：
  1. 实现 `move(-1|1)`，仅 running 时处理；调用 canPlace 决定是否更改 x。
  2. 不允许横向穿过边界/锁定块；操作本身不增加分数。
  3. 测试普通移动、左/右贴墙无效、ready 时无效（暂停测试在 T031 补齐）。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：移动只改变 x；非法移动彻底不改变状态。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T025｜实现 Engine 顺逆旋转
- **依赖**：T018, T022, T023。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3,S03.4。
- **明确步骤**：
  1. 暴露 `rotate(1|-1)`，只在 running 时调用 tryRotate。
  2. 将成功返回的位置和旋转态写回 state；不允许 engine 实现第二套自制踢墙。
  3. 单测顺转、逆转、ready 时不生效（paused 测试在 T031 补齐）。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：引擎旋转与 srs.ts 完全一致。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [x] T026｜实现单次软降及每格加分
- **依赖**：T014, T020, T022, T023。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3,S03.5。
- **明确步骤**：
  1. 定义 `softDrop()`：仅能下一格时 y+1、score+1。
  2. 触底时保持位置、分数不变，不直接锁定。
  3. 单测成功一次 +1、不能落时 +0、ready +0（paused 测试在 T031 补齐）。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：软降与自然重力分数分离，没有双重加分。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T027｜实现硬降并立即锁块
- **依赖**：T015, T016, T019, T020, T023。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3,S03.5。
- **明确步骤**：
  1. 定义 `hardDrop()`，计算 ghostY−active.y 取得落差，增加 `2*落差` 分。
  2. 立即锁入棋盘，清行（先记数量），生成下一块；发出 hardDrop 事件。
  3. 本任务先确保锁定/消行正确，清行积分统一在 T033 补齐，禁止写临时错误公式。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：硬降后旧块变已锁定块、active 为新块、落差奖励准确、无需等待重力。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T028｜实现基于 dt 的自然重力
- **依赖**：T021, T022, T023, T027。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3。
- **明确步骤**：
  1. `step(dtMs)` 非 running 直接返回，NaN/负数作 0，最大 100ms。
  2. 重力累加到当前等级间隔时移动一格，最多循环 20 次；自然下落不给分。
  3. 以连续 100ms `step()` 多次触发来测试 900ms 首次下降与 ready 不下降（paused 测试在 T031 补齐）。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：不依赖 setInterval；积分不会因自然落下变化。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T029｜实现落地锁定延迟和限次重置
- **依赖**：T024, T025, T028。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3。
- **明确步骤**：
  1. 落地检测在 `step()`，着地累计 500ms 后锁定；离地清零计时，但保留重置次数。
  2. 着地且成功水平移动/旋转可重置计时，最多 15 次；失败动作不重置。
  3. 单测 499ms 不锁、>=500ms 锁、16 次后不再重置、移出地面再落下。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：不允许无限重置锁定延迟；硬降仍立即锁。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T030｜实现 Hold 单块一次
- **依赖**：T023, T027。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.2。
- **明确步骤**：
  1. 首次 hold 将 active.type 存入槽并从队列产生新块；再次 hold 在锁定前无效。
  2. 槽已有方块时交换，新 active 恢复 r0/x3/y2；成功锁定后重置限制。
  3. 测试第一次、第二次无效、锁块后再次可用、换入不合法则 gameover。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：持有次数准确，Hold 不随机偷换或跳队列。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T031｜实现开始、重开、暂停状态转换
- **依赖**：T022, T023, T028。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.3。
- **明确步骤**：
  1. 在 T023 已有 `start()` 上复核仅 ready 可用；新增 `restart()`：任意状态清空进度并 running。
  2. `togglePause()`：running↔paused；ready/gameover 下无效。
  3. 重开重置 score/lines/level/board/held、落地计时和事件；测试每条状态转换。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：四状态之间仅发生允许的转换；pause 时 step/输入无效。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T032｜处理 block-out 和 lock-out 结束
- **依赖**：T027, T030, T031。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.1,S03.3。
- **明确步骤**：
  1. 出生碰撞转 gameover 并清除 active。
  2. 锁定后先检查隐藏行占用（0..3），有则 gameover，不再生成新块。
  3. 结束时增加带唯一 id 的 gameover 事件；通过构造器 `initialBoard` 注入可复现棋盘单测两类失败，正常游戏不传此参数。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：两类 top-out 不会崩溃；游戏结束后输入不再生效。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T033｜结算清行积分、累计行数和等级
- **依赖**：T016, T020, T021, T027。**允许修改文件**：`src/game/engine.ts、tests/unit/engine.test.ts`。**规格**：S03.5。
- **明确步骤**：
  1. 在锁定路径取得 cleared，按锁前 level 调 lineClearPoints 增加分数。
  2. 增加总 lines 并用 levelForLines 重新计算等级；产生 `clear` 事件（含行数）。
  3. 测试一次清 4 行 800×旧 level、9→10 行提升 1 级、软硬降附加分独立。
- **验证命令/动作**：`npx vitest run tests/unit/engine.test.ts`。
- **通过条件**：消行加分一次且仅一次；等级边界正确，事件能供特效使用。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T034｜引擎纯逻辑回归测试
- **依赖**：T029, T030, T031, T032, T033。**允许修改文件**：`tests/unit/engine.test.ts、tests/unit/srs.test.ts`。**规格**：S03,S08。
- **明确步骤**：
  1. 补足开始→移动→降落→锁定→Hold→重开测试，固定 RNG，不依赖 sleep。
  2. 增加 SRS I 墙踢、无法旋转原态不变用例；失败测试不能跳过。
  3. 完整运行全部 unit、typecheck 和构建。
- **验证命令/动作**：`npm run typecheck && npm run test && npm run build`。
- **通过条件**：所有核心测试通过；不存在 todo/skip 掩盖失败。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

### P3 布局与渲染

#### - [ ] T035｜创建语义化网页骨架
- **依赖**：T007, T034。**允许修改文件**：`index.html、src/ui/layout.ts、src/main.ts`。**规格**：S04.3。
- **明确步骤**：
  1. 创建 `layout.ts` 中静态 DOM 结构：header/main/3 panels/canvas 及状态按钮容器。
  2. 用 JS 初始化一次布局，不在每次 frame 重新创建结构；为 Canvas 添 aria-label。
  3. main.ts 暂只创建静态 layout，后续在 T053 接 Engine；确保无空导入。
- **验证命令/动作**：`npm run typecheck && npm run build`，浏览器 DOM 检查。
- **通过条件**：桌面能看见品牌、HOLD、棋盘、NEXT、SCORE、LEVEL；无浏览器控制台错误。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T036｜实现桌面三栏静态样式
- **依赖**：T035。**允许修改文件**：`src/styles/app.css、src/main.ts`。**规格**：S04.1,S04.2,S04.3。
- **明确步骤**：
  1. 按 S04.3 实现三栏居中布局，最大宽 1060px，主棋盘容器宽约 300px，左右卡片。
  2. 卡片用 S04.2 色板、圆角 16px、边框，背景径向柔光和固定点阵；不得铺满高亮粒子。
  3. main.ts 引入 app.css。
- **验证命令/动作**：`npm run build`，浏览器 1440×900 截图。
- **通过条件**：三栏不重叠；主棋盘比两侧醒目；文本清晰、色板准确。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T037｜实现移动端布局断点
- **依赖**：T036。**允许修改文件**：`src/styles/responsive.css、src/main.ts`。**规格**：S04.3。
- **明确步骤**：
  1. 增加 <768px 媒体规则：60–74px 左右窄侧栏，中间棋盘同比缩小，标题压缩。
  2. 按 320×640 与 390×844 计算并保证无横向滚动；不把 Canvas 挤出主栏。
  3. main.ts 导入 responsive.css，保留小屏自然纵向滚动。
- **验证命令/动作**：`npm run build`，Chrome 响应模式检查 320/390px。
- **通过条件**：两种宽度 documentElement.scrollWidth <= innerWidth；棋盘完全可见，面板无重叠。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T038｜实现 Canvas 高清缩放
- **依赖**：T035, T037。**允许修改文件**：`src/ui/renderer.ts`。**规格**：S05。
- **明确步骤**：
  1. 导出 `BoardRenderer` 类接收 canvas，公开 `resize()`、`render(state,opts)`；初始 render 可只清屏。
  2. 读取 CSS 实际 width/height，内部像素× min(DPR,2)，每次使用 `setTransform` 重置缩放。
  3. 确保 10×20 每格等宽等高，边界位置不插值变形，浏览器缩放/窗口 resize 后仍清晰。
- **验证命令/动作**：`npm run typecheck && npm run build`，浏览器高 DPR 检查。
- **通过条件**：内部 canvas.width 与 CSS 尺寸×dpr 一致；resize 不叠加比例。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T039｜画棋盘底色与网格线
- **依赖**：T038。**允许修改文件**：`src/ui/renderer.ts`。**规格**：S03.1,S04.1。
- **明确步骤**：
  1. 使用 `#0B1022` 填背景。
  2. 画 10×20 条网格交叉的细线、透明度规格，网格线对齐 CSS 格尺寸。
  3. 可见行只绘制内部 board 的 4..23；不可把隐藏缓冲区画出来。
- **验证命令/动作**：`npm run build`，浏览器棋盘截图。
- **通过条件**：可见精确 10 列 20 行；颜色、纵横比正确。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T040｜绘制锁定块和活动块
- **依赖**：T011, T039。**允许修改文件**：`src/ui/renderer.ts`。**规格**：S04.1,S04.2,S05。
- **明确步骤**：
  1. 按 `board[4..23]` 绘制锁定块，活动块用 getMatrix 根据 x/y 绘制。
  2. 每格使用类型颜色、轻亮边/底暗边/圆角，绘制时省略隐藏行部分。
  3. 画面只读取 state，不修改 engine。
- **验证命令/动作**：`npm run typecheck && npm run build`，构造静态 state 目测七色。
- **通过条件**：4 格形状轮廓与坐标一致；左上/底边无越界绘图。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T041｜绘制落点预判 Ghost
- **依赖**：T019, T040。**允许修改文件**：`src/ui/renderer.ts`。**规格**：S03.2,S04.1。
- **明确步骤**：
  1. 用 getGhostY 得到活动块投影坐标，仅绘制描边不填充（30% 透明）。
  2. Ghost 与 active 同位置时不重复绘制轮廓；受参数 `ghostEnabled` 控制。
  3. 绘制失败/暂停时不能调用随机生成。
- **验证命令/动作**：`npm run typecheck && npm run build`，截图检查 Ghost 对齐。
- **通过条件**：投影准确落在堆叠顶部；开关不影响游戏内部状态。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T042｜渲染 HOLD/NEXT 方块预览
- **依赖**：T035, T011。**允许修改文件**：`src/ui/hud.ts、src/styles/app.css`。**规格**：S04.2,S04.3,S05。
- **明确步骤**：
  1. 建立 4×4 CSS 小格预览函数（将 3×3 形状在 4×4 居中）。
  2. HOLD 空槽展示占位图，非空展示对应类型；NEXT 依次前 3 枚、移动端至少前 2 枚。
  3. 更新已有格子颜色，不每 frame 重建 12 个以上预览 DOM；保持固定色板。
- **验证命令/动作**：`npm run typecheck && npm run build`，静态 UI 检查七型预览。
- **通过条件**：预览图形与 S03.1 一致；无多余四格错位；HOLD/NEXT 标签可见。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T043｜显示分数等级行数和最高分
- **依赖**：T042。**允许修改文件**：`src/ui/hud.ts、src/styles/app.css`。**规格**：S04.2,S04.3。
- **明确步骤**：
  1. 实现 `updateHud(state,bestScore)`，只在数值改变时更新对应 textContent。
  2. 分数与最高分使用 `tabular-nums`；至少 6 位左侧补 0（超 6 位完整显示）；等级与行数不截断。
  3. 桌面侧栏和移动端压缩信息保持一致数值。
- **验证命令/动作**：`npm run typecheck && npm run build`，通过模拟状态检查显示值。
- **通过条件**：数值对应 state，任意分数不会显示 NaN/undefined。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T044｜创建 ready/paused/gameover HTML 覆盖层
- **依赖**：T035。**允许修改文件**：`src/ui/overlays.ts、src/styles/app.css`。**规格**：S04.3。
- **明确步骤**：
  1. 添加三种 `role=dialog` 覆盖层，ready 有“开始游戏”、paused 有“继续”、gameover 有“再玩一次”。
  2. 游戏结束显示本局 SCORE 和 BEST，覆盖层由外部状态驱动显示/隐藏，交互绑定留到 T055。
  3. overlay 关闭后恢复正常棋盘可见，焦点不落在隐藏控件。
- **验证命令/动作**：`npm run typecheck && npm run build`，浏览器逐个切状态截图。
- **通过条件**：三种覆盖层文案/按钮完整；Canvas 后面的控件不遮挡弹层。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T045｜实现清行与硬降短特效
- **依赖**：T040。**允许修改文件**：`src/ui/effects.ts、src/ui/renderer.ts`。**规格**：S04.1,S08。
- **明确步骤**：
  1. EffectsController 消费 engine.lastEvent.id，禁止同事件反复触发。
  2. `clear` 高亮 140ms，`hardDrop` 光尾 120ms；仅在 render 中读效果快照，不修改棋盘。
  3. 提供 `reducedMotion` 开关直接取消效果，避免昂贵 Canvas blur/大量粒子。
- **验证命令/动作**：`npm run typecheck && npm run build`，手动模拟事件时间线。
- **通过条件**：时间结束自动清理，重复渲染同一事件不会无限重播。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

### P4 设置与输入

#### - [ ] T046｜实现设置读取/校验/写入
- **依赖**：T001。**允许修改文件**：`src/storage/settings.ts、tests/unit/settings.test.ts`。**规格**：S07。
- **明确步骤**：
  1. 按 S07 实现 `loadSettings()`/`saveSettings()`，默认静音、Ghost 开、减少动画关。
  2. JSON 非法/字段类型不符时逐字段回退；localStorage 抛异常时返回默认。
  3. 用 stub localStorage 单测：默认、保存重读、损坏、禁止写入。
- **验证命令/动作**：`npx vitest run tests/unit/settings.test.ts`。
- **通过条件**：设置安全降级，无未捕获 DOMException。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T047｜保存和读取历史最高分
- **依赖**：T046。**允许修改文件**：`src/storage/settings.ts、tests/unit/settings.test.ts`。**规格**：S03.5,S07。
- **明确步骤**：
  1. 实现 `readBestScore()`/`writeBestScore(value)`，键值精确匹配 S07。
  2. 解析不合法/负数/超安全整数为 0；只接受非负安全整数，存储出错不抛。
  3. 单测新高分、无变化、数据损坏与禁用存储。
- **验证命令/动作**：`npx vitest run tests/unit/settings.test.ts`。
- **通过条件**：刷新后最高分准确，写入失败不阻塞游戏。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T048｜制作设置弹窗 HTML/CSS
- **依赖**：T044, T046。**允许修改文件**：`src/ui/overlays.ts、src/styles/app.css`。**规格**：S04.3,S07。
- **明确步骤**：
  1. 设置弹窗提供 Sound、Ghost、Reduced motion 三个 labeled checkbox。
  2. 页面按钮“设置”与弹窗“关闭/保存”存在，Tab 能进入选项，Escape 关闭规则预留。
  3. UI 控件改设置后调用 saveSettings，设置可回读；运行状态自动暂停的绑定留到 T056。
- **验证命令/动作**：`npm run typecheck && npm run build`，手动测试 checkbox。
- **通过条件**：三个设置项目都有可见标签和选中状态；保存重开浏览器保持。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T049｜合成四种短 WebAudio 音效
- **依赖**：T046。**允许修改文件**：`src/audio/sound.ts`。**规格**：S08。
- **明确步骤**：
  1. 实现短音 move/rotate/lock/clear（约 40/65/85/150ms，音量低于 0.1），优先 oscillator+gain。
  2. 首次有用户交互才懒创建 AudioContext，soundEnabled=false 时不实例化或播放。
  3. 暴露 `playSound(kind)`、`setEnabled(value)`、`dispose()`；任何播放异常吞掉并安全降级。
- **验证命令/动作**：`npm run typecheck && npm run build`，浏览器测试有声/静音。
- **通过条件**：默认无自动播放、开声后四种可分辨、静音立刻生效。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T050｜实现键盘单次按键映射
- **依赖**：T031。**允许修改文件**：`src/input/keyboard.ts`。**规格**：S03.3,S06。
- **明确步骤**：
  1. 创建 KeyboardController(engine)，映射 ←/→/↓/↑/Space/X/Z/C/P/Escape/Enter。
  2. `event.repeat` 对一次性动作（旋转/硬降/Hold/暂停）忽略；只在游戏运行且必要时 preventDefault。
  3. 用 `dispose()` 移除监听；将开始/覆盖层快捷键通过回调交给 main 而不自行改 UI。
- **验证命令/动作**：`npm run typecheck && npm run build`，手动 keydown 测试映射。
- **通过条件**：任意单次输入只调用一次 Engine 方法；文本输入/设置弹窗不劫持快捷键。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T051｜实现键盘移动与软降长按
- **依赖**：T050。**允许修改文件**：`src/input/keyboard.ts、src/input/repeat.ts`。**规格**：S03.3,S06。
- **明确步骤**：
  1. 在 repeat.ts 实现可复用的 RepeatController，提供 DAS=150ms、ARR=45ms 和 soft=35ms，无独立计时器；键盘首次按下立即执行，左右 DAS 150ms 后 ARR 45ms，向下间隔 35ms。
  2. 同时按左右：最后按键优先；释放当前方向恢复另一方向；失焦可 `releaseAll()`。
  3. 使用 RAF tick 或输入 update(dt)，不创建无限 setInterval；`event.repeat` 仅记按住标记。
- **验证命令/动作**：`npm run typecheck && npm run build`，浏览器按住左右/向下验证。
- **通过条件**：长按平滑、无两路方向对抗、抬键后立即停止。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T052｜实现虚拟触控按钮与按住反馈
- **依赖**：T035, T051。**允许修改文件**：`src/input/touch.ts、src/styles/responsive.css`。**规格**：S03.3,S04.3。
- **明确步骤**：
  1. 在移动端渲染 7 按键：←、→、↓、旋转左、旋转右、硬降、Hold；另有顶部 Pause。
  2. 三个持续键**复用 `src/input/repeat.ts` 的 RepeatController**，按下立即执行并遵循 T051 相同 DAS/ARR/软降速率，其他按键一次触发；用 pointercancel 终止输入。
  3. 44×44px 起、pressed 态明显，给每个按钮中文 aria-label，页面其他区域保留正常滚动。
- **验证命令/动作**：`npm run typecheck && npm run build`，移动模拟器按下拖离和松开检查。
- **通过条件**：7 按键映射无误、不因手指移出而粘连；无横向溢出。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

### P5 集成

#### - [ ] T053｜在入口装配引擎、HUD、渲染与输入
- **依赖**：T035, T038, T041, T043, T050, T051, T052。**允许修改文件**：`src/main.ts`。**规格**：S02,S05。
- **明确步骤**：
  1. 创建一份 GameEngine、一份 BoardRenderer、HUD、KeyboardController、TouchController。
  2. `requestAnimationFrame` 单循环：计算 dt→处理长按→`engine.step(dt)`→render→只在变化时 updateHud；窗口 resize 调 renderer.resize。
  3. 添加模块级 teardown（测试热重载时不重复监听），`getState()` 只读。
- **验证命令/动作**：`npm run typecheck && npm run test && npm run build`，浏览器试玩。
- **通过条件**：页面出现实时棋盘；按键会使 active 移动；页面无重复 RAF/控制台错误。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T054｜处理窗口失焦和隐藏自动暂停
- **依赖**：T053。**允许修改文件**：`src/main.ts、src/input/keyboard.ts、src/input/touch.ts`。**规格**：S03.3,S06。
- **明确步骤**：
  1. 监听 `window.blur` 与 `document.visibilitychange`，running 时自动 togglePause。
  2. 立即 releaseAll 持续输入；恢复可见只重置 RAF 上次时间戳，**不自动恢复运行**。
  3. 手动测试切标签 5 秒再回，不掉块、不粘键。
- **验证命令/动作**：`npm run typecheck && npm run build`，浏览器切标签实测。
- **通过条件**：返回后仍 paused，背景经过时间未折算进重力。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T055｜绑定开始、暂停、继续和重开按钮
- **依赖**：T044, T053。**允许修改文件**：`src/main.ts、src/ui/overlays.ts`。**规格**：S03.3,S04.3,S06。
- **明确步骤**：
  1. READY 开始调用 engine.start，PAUSED 继续调用 togglePause，GAMEOVER 再玩一次调用 restart。
  2. 暂停按钮切换，running 下“重新开始”应弹原生 confirm 或自绘确认；确认取消时状态不变。
  3. Enter 只在 ready/gameover 激活开始/重开，Escape 或 P 切暂停。
- **验证命令/动作**：`npm run typecheck && npm run build`，完整开始→暂停→继续→重开手动测试。
- **通过条件**：不出现两个活动游戏同时运行；无意外重启。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T056｜绑定设置、音效、最高分与 Ghost
- **依赖**：T045, T047, T048, T049, T053, T055。**允许修改文件**：`src/main.ts、src/ui/overlays.ts`。**规格**：S05,S07,S08。
- **明确步骤**：
  1. 启动读取 settings/best，实时将 Ghost/降低动画传给 renderer/effects，将 sound 传给 SoundManager。
  2. Engine 的事件仅消费一次并发短音；分数有新高时保存/更新 HUD；设置打开自动暂停、关闭后保持 paused 由用户继续。
  3. 使用系统减少动画偏好 OR 设置开关求最终开关；销毁清理监听/声音。
- **验证命令/动作**：`npm run typecheck && npm run test && npm run build`，刷新检查存储。
- **通过条件**：设置和最高分跨刷新有效；静音无声；Ghost 开关即时更新；弹设置不偷跑游戏。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

### P6 自动测试与打磨

#### - [ ] T057｜桌面 Playwright 游戏闭环
- **依赖**：T005, T056。**允许修改文件**：`tests/e2e/desktop.spec.ts`。**规格**：S08。
- **明确步骤**：
  1. 在 chromium 运行：页面初始 READY→点击开始→使用左右/旋转→硬降后 score 增加→P 暂停→继续→重开。
  2. 使用 locator 与 expect 检查分数、overlay 和 Canvas 存在，不依赖任意固定等待。
  3. 另测设置静音/ghost 保存后 page.reload 正确。
- **验证命令/动作**：`npm run test:e2e -- --project=chromium`。
- **通过条件**：全部 E2E 通过；有可重现断言，非只检查截图。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T058｜移动 Playwright 触控闭环
- **依赖**：T005, T052, T056。**允许修改文件**：`tests/e2e/mobile.spec.ts、playwright.config.ts（仅必要时）`。**规格**：S04.3,S08。
- **明确步骤**：
  1. 在 mobile-chrome project 检查 390×844：触控开始、左移、旋转、硬降、暂停、继续。
  2. `document.documentElement.scrollWidth<=innerWidth`；定位 7 个虚拟键且 bounding box 每键>=44×44。
  3. 再用 320×640 跑 viewport 临时覆盖，无水平溢出。
- **验证命令/动作**：`npm run test:e2e -- --project=mobile-chrome`。
- **通过条件**：两个视口无横向滚动、触控动作成功，按键触控目标达标。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T059｜键盘焦点、文字对比与语义复查
- **依赖**：T048, T055, T058。**允许修改文件**：`src/ui/layout.ts、src/ui/overlays.ts、src/styles/app.css`。**规格**：S04.2,S04.3,S06。
- **明确步骤**：
  1. 检查每个按钮是否 button/aria-label、标题层级、Canvas 说明、焦点外框。
  2. 设置 dialog 打开焦点进入对话框，Escape 关闭返回设置按钮；隐藏的控件不参与 Tab。
  3. 检查灰字在 panel 背景可辨，正文不低于 12px，关键数值不低于 14px。
- **验证命令/动作**：`npm run build`，Tab/Shift+Tab/Escape 人工验证。
- **通过条件**：键盘可使用主要控件；焦点不丢失；无无名按钮。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T060｜减少动画与特效生命周期检查
- **依赖**：T045, T056。**允许修改文件**：`src/ui/effects.ts、src/styles/app.css、src/main.ts（仅必要时）`。**规格**：S05,S08。
- **明确步骤**：
  1. 加 `prefers-reduced-motion` CSS 降级和 JS 开关，系统偏好优先。
  2. 验证事件重复渲染不会重播 FX，重开时清理旧 FX；背景不跑连续粒子。
  3. 实测减少动画后清行和硬降的强光停止。
- **验证命令/动作**：`npm run build`，Emulate CSS prefers-reduced-motion 手动检查。
- **通过条件**：减少动画生效；关闭特效不改变消行或积分。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T061｜性能测量和按需微调
- **依赖**：T053, T056, T060。**允许修改文件**：`docs/execution-log.md、src/ui/renderer.ts（仅确有性能证据时）`。**规格**：S05,S08。
- **明确步骤**：
  1. 使用 Chromium Performance 或自定义 `performance.now()` 记录 3 分钟试玩帧时间与内存趋势，浏览器/机器/分辨率写入日志。
  2. 检查是否多 RAF、泄露 input listener、Canvas resize 重复缩放。
  3. 只有实测确认瓶颈才优化；优化前后记录相同条件指标。
- **验证命令/动作**：`npm run typecheck && npm run test && npm run build`，浏览器性能录制。
- **通过条件**：3 分钟可持续玩；没有明显帧积压/无界内存增长；记录实际数据而非编造 60fps。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T062｜固定视口截图和人工视觉核对
- **依赖**：T056, T058, T059。**允许修改文件**：`docs/screenshots/、docs/execution-log.md`。**规格**：S04,S08。
- **明确步骤**：
  1. 生成 1440×900 PC、390×844 mobile、320×640 mobile 三种真实浏览器截图（READY 与 RUNNING 各至少一次）。
  2. 对照 S04 检查主棋盘可辨、无切边、侧栏不重叠、按钮足够大、颜色无偏差。
  3. 截图按 `desktop-running.png` 等命名；发现问题应新建纠错条目、不要假勾选。
- **验证命令/动作**：人工审阅 6 张截图 + `npm run build`。
- **通过条件**：至少 6 张截图可查看；所有视觉问题记录 PASS/FAIL，未完成不能写通过。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T063｜最终自动回归与行为核对
- **依赖**：T034, T057, T058, T060, T061, T062。**允许修改文件**：`docs/execution-log.md、tests/unit/*.test.ts（仅修复发现问题）`。**规格**：S08,S09。
- **明确步骤**：
  1. 顺序运行四条最终命令并记录退出码与测试数量。
  2. 复核七袋/边界/双向踢墙/I 踢墙/Hold 限制/4 行清行/10 行升级/自动暂停/重启。
  3. 对失败只修根因并重跑全量，不要删除断言、跳过用例。
- **验证命令/动作**：`npm run typecheck && npm run test && npm run build && npm run test:e2e`。
- **通过条件**：四命令全部 0；行为核对有对应自动测试或手动证据。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T064｜编写最终部署说明
- **依赖**：T063。**允许修改文件**：`README.md`。**规格**：S01,S02,S07。
- **明确步骤**：
  1. 写项目功能、按键/触控操作表、Node 版本、安装与运行命令、静态部署方法。
  2. 写设计说明、存储 key、测试命令、已知不支持范围（无联机/T-Spin/账号）。
  3. 只写经过测试的兼容性；注明音效默认关闭。
- **验证命令/动作**：阅读 README，复制命令在干净环境 `npm ci && npm run build`。
- **通过条件**：第三方无需问开发者即可启动；文档与实际脚本相符。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

#### - [ ] T065｜正式发布质量门禁与结项
- **依赖**：T063, T064。**允许修改文件**：`docs/execution-log.md、docs/screenshots/（存在时）`。**规格**：S01,S08,S09。
- **明确步骤**：
  1. 核验每个任务的 checkbox 必须对应 execution-log 记录；关闭所有 BLOCKED/FAIL。
  2. 最终执行 `npm run typecheck && npm run test && npm run build && npm run test:e2e`；检查 `dist/index.html` 与静态资源链接。
  3. 生成最终报告：通过数、实际环境、遗留问题、构建产物位置；最后再勾选 T065。
- **验证命令/动作**：`npm run typecheck && npm run test && npm run build && npm run test:e2e`。
- **通过条件**：所有依赖任务已 PASS、四门槛均为 0，存在可部署 dist/；任何阻断不得标完成。 **且通用质量门禁通过、执行日志已写入**；否则不勾选。

## 3. 完成定义（全部必须同时满足）

- [ ] T001–T065 **逐项**勾选且每项有执行日志证据，未完成不能通过补日志冒充。
- [ ] 页面可从 READY 正常开始，真实完成至少 10 次锁块、1 次清行、暂停/恢复/结束/再开始。
- [ ] 键盘全部映射可用；手机触控全部映射可用；手机宽 320/390px 无水平滚动。
- [ ] SRS 5 点尝试逻辑、I 独立墙踢、7-bag、Hold 单块 1 次、Ghost、重力与锁定延迟通过测试。
- [ ] 1440×900 / 390×844 / 320×640 实际截图保存；没有人工看过不得勾选视觉合格。
- [ ] `npm run typecheck` / `npm run test` / `npm run build` / `npm run test:e2e` 全部退出码 0。
- [ ] `dist/` 可由静态服务器打开；没有公网后端、外部图片、外部字体或运行时网络依赖。
- [ ] README、测试结果、实际性能记录、已知局限完整；最终 BLOCKED 数量=0。

## 4. 回归复审检查点

1. **重复/冗余**：允许一个模块被多个任务修改，但各项只负责独立行为；T010 初态与 T011 旋转、T017 数据与 T018 调用、T020 分数函数与 T033 引擎结算、T051 键盘长按与 T052 触摸按钮均分工明确，禁止重复实现两套逻辑。
2. **跨阶段边界**：T027 硬降负责锁定与消行流程，T033 才完成统一清行积分；T035–T045 可以采用静态状态预览，在 T053 前不声称游戏 UI 已可玩。
3. **测试证据**：仅在 E2E 建立后执行端到端门禁；早期所有单元测试都必须保持全量通过；可视测试需要截图，不能用“代码看起来没问题”替代。
4. **模型弱点规避**：不让模型自行设计复杂规则、色彩、交互映射或分解任务；一次任务不做功能开发+架构改造+性能调参三个方向。
5. **规格优先**：如本文任务描述和规格冲突，先阻断并反馈两处具体语句，不应偷偷以较易实现版本覆盖产品要求。

## 5. 资料链接

- 规则：https://tetris.wiki/Tetris_Guideline ｜踢墙：https://tetris.wiki/Super_Rotation_System ｜分数：https://tetris.wiki/Scoring
- 开发：https://vite.dev/guide/ ｜测试：https://vitest.dev/guide/ ｜E2E：https://playwright.dev/docs/intro

**版本状态：v1.0 已完成文本设计，代码开发尚未开始。**
