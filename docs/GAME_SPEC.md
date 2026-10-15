# Neon Blocks（霓虹方块）网页版游戏开发规格 v1.0

> 日期：2026-10-15｜状态：冻结基线｜适用实施模型：Qwen3.8-Flash-Next-IQ3_S
> 关联执行文档：`Neon_Blocks_原子任务清单_v1.0.md`。本文件是产品、参数和接口的**唯一规格依据**；清单负责顺序与验收。任何改变需先记录变更，不允许 Agent 自行修改玩法或技术栈。

## S01. 目标、范围和交付

- 目标：离线可玩的单人无尽马拉松网页落块游戏，具有完整开始→操作→得分升级→结束→重开闭环；标题使用原创 **Neon Blocks / 霓虹方块**。
- 运行：Windows/macOS 桌面 Chrome/Edge/Firefox 近期版本；Android Chrome、iOS Safari 主流版本。无需账号、服务器、数据库、联网 API。开发依赖安装阶段可以联网；构建后的运行不得要求联网。
- v1 必须：7 种四连块、7-bag、标准 90° SRS（双向与 I 独立墙踢）、左右移动、软降、硬降、Hold（每块一次）、Next 3、Ghost、自然重力、0.5 s 锁定延迟、满行消除、积分升级、暂停、重开、游戏结束、最高分本地保存、键盘、触屏按钮、适配布局、可选音效、减弱动画、基本可访问性、自动化测试。
- v1 不做：联机、账户、排行榜服务、T-Spin 判定及其加分、连击、Back-to-Back、完美消除奖励、游戏手柄、无限按键重绑定、PWA/离线缓存、角色立绘、付费资源、广告、复杂物理引擎或第三方游戏资源。
- 单页，部署到任意静态 Web 服务器。无侵入式提示。不得引用商业 Tetris 官方 Logo、音乐、素材或界面截图；规则仅借鉴公开描述。

## S02. 技术与目录（固定）

- Node.js **>=22.12**，npm（推荐 Node 22 LTS）；Vite `vanilla-ts`；TypeScript `strict`；Canvas 2D；原生 CSS；Vitest；Playwright（Chromium + Mobile Chrome 模拟；分别运行 desktop 与 mobile 测试，smoke 在两组执行）。不增加 React/Vue/Phaser/状态管理库/Tailwind/Canvas 游戏引擎。
- 按创建时安装的兼容最新版并**提交 `package-lock.json`**；禁止任意无审查升级。`package.json` 脚本：`dev`、`typecheck`（`tsc -b --pretty false`）、`test`（`vitest run`）、`test:e2e`（`playwright test`）、`build`（`tsc -b && vite build`）、`preview`。
- `npm ci && npm run typecheck && npm run test && npm run build` 是统一离线逻辑/构建门槛（`npm ci` 仅环境准备时运行）。E2E 在完成首个可玩集成后执行。

```text
index.html
package.json / package-lock.json / tsconfig*.json / vite.config.ts / playwright.config.ts
public/favicon.svg
src/main.ts
src/game/types.ts
src/game/constants.ts
src/game/pieces.ts
src/game/random.ts
src/game/board.ts
src/game/srs.ts
src/game/scoring.ts
src/game/engine.ts
src/ui/layout.ts
src/ui/renderer.ts
src/ui/hud.ts
src/ui/overlays.ts
src/ui/effects.ts
src/input/keyboard.ts
src/input/repeat.ts
src/input/touch.ts
src/audio/sound.ts
src/storage/settings.ts
src/styles/tokens.css
src/styles/app.css
src/styles/responsive.css
tests/unit/{pieces,random,board,srs,scoring,engine,settings}.test.ts
tests/e2e/{desktop,mobile}.spec.ts
docs/execution-log.md
docs/screenshots/   # 仅验收截图，不作为运行时资源
README.md
```

**模块职责**：`game/` 纯逻辑、不访问 DOM/Canvas/localStorage；`ui/` 仅渲染、面板与动画；`input/` 输入映射，不直接改变棋盘；`main.ts` 唯一装配入口；所有配置键在 `settings.ts` 统一管理。`engine.ts` 可以保存私有可变状态；外部仅通过 `getState()` 只读访问，不直接写入棋盘。

## S03. 逻辑规则与数据契约

### S03.1 棋盘、坐标与方块

- 内部棋盘 `Board = Cell[][]`：**10 列 × 24 行**；行号 `0…3` 隐藏，`4…23` 可见（20 行）。左上 `(x=0,y=0)`，x 向右增，y 向下增；空格 `null`，占用格 `PieceType`。绘制可见格时 `visibleY = boardY - 4`。
- `PieceType = 'I'|'O'|'T'|'S'|'Z'|'J'|'L'`；`ActivePiece={type, rotation:0|1|2|3, x:number, y:number}`，x/y 是形状方阵左上坐标；生成初始 `x=3, y=2, rotation=0`。对 3×3 与 4×4 矩阵仅**值非零**的格子参与碰撞；矩阵空白位允许越界。
- 旋转 0 态固定：`I` 4×4 `["0000","1111","0000","0000"]`；`O` 4×4 `["0000","0110","0110","0000"]`；余者 3×3：`T=["010","111","000"]`，`J=["100","111","000"]`，`L=["001","111","000"]`，`S=["011","110","000"]`，`Z=["110","011","000"]`。其中 `'1'` 表示本方块占用，不作直接颜色存储。
- 1、2、3 态：将**整个固定大小方阵**逐次顺时针 90° 旋转（`new[row][col] = old[n-1-col][row]`）；O 的 4 态始终与 0 态相同。**不要去除外围全 0 行列**，否则 SRS 踢墙不成立。
- 只能移动有效 occupied cell 到 `0 <= x < 10 && 0 <= y < 24` 且不与锁定块冲突的位置；任何越界/冲突的动作原子失败（状态不变）。
- 新块入场若初始位置不能放置，立刻 `gameover`（block-out）。锁定完成后若有占用块仍在隐藏行 `0..3`，立刻 `gameover`（lock-out）；**先检查 lock-out 再尝试下一块**，以免隐藏占用被漏判。

### S03.2 随机与队列

- Fisher–Yates：每一袋包含 `I,O,T,S,Z,J,L` 各 1 次；袋耗尽时重洗；随机函数支持 `rng: () => number` 注入用于确定性测试，值范围 `[0,1)`。不得在渲染时消费随机数。
- `nextQueue` 在 running/paused 时始终预先填充到 **5 个**（初始 ready 可为空）；UI 只显示前 **3 个**。开始从队首弹出当前块后填足 5；锁定与首次 Hold（空槽）生成块时同理。
- `heldType: PieceType|null`，`holdUsedThisPiece:boolean`。当前块首次 Hold：放入槽、从队首取下一个；已存在 Hold：与槽交换，换入块重置 rotation/x/y；在该块锁定前再次 Hold 必须无效。锁定后重置使用标记。

### S03.3 状态机、时间和输入

- `status: 'ready'|'running'|'paused'|'gameover'`，页面初始 ready；只有 running 状态可移动、旋转、Hold、改变分数或推进重力。若同一次硬降也触发消行，视觉事件以 `clear` 优先（不会同时播放 hardDrop 光尾）；无需引入复杂事件队列。
- `GameEngine` 对外 API（名称固定）：`constructor(rng?:()=>number, initialBoard?:Board)`、`getState()`、`start()`、`restart()`、`togglePause()`、`move(dx:-1|1)`、`rotate(dir:1|-1)`、`softDrop()`、`hardDrop()`、`hold()`、`step(dtMs:number)`。动作返回 void；`getState()` 返回 TypeScript readonly 视图，UI 不得修改其嵌套数组；`initialBoard` 仅为确定性边界测试注入，正常应用不传、restart 始终从空棋盘开始；内部更新在每次动作结束保持完整棋盘与有效状态。
- `step(dtMs)` 由唯一 `requestAnimationFrame` 循环驱动；只接受有限的非负 delta，单次上限 100ms；不要用 `setInterval` 或每次重启多个 RAF。切回后台首次 tick 不补算离开时间；失焦/页面隐藏自动进入 paused。
- 重力：累积到当前等级间隔自动下降 1 格；若单帧累计大于间隔，可以循环处理多个格，但最多 20 次以避免卡顿循环。等级 1–10 重力间隔 ms：`[900,750,620,510,420,350,290,240,200,170]`；11 级起 `max(60, round(170*0.85^(level-10)))`。
- 触底且不能继续下降时启动 500ms 锁定计时；落地期间成功水平移动/旋转，允许重置延迟，**每块最多 15 次**，之后不再重置；离地时停止地面计时，重落地重新计时，但不能刷新 15 次计数。硬降立即锁定、不等延迟；软降只要能移动则下一格并加 1 分，不能移动时不立即锁定。
- 键盘方向：`←` 左；`→` 右；`↓` 软降；`↑` 或 `Space` 硬降；`X` 顺时针、`Z` 逆时针；`C` Hold；`P`/`Escape` 暂停；`Enter` 在 ready 或 gameover 时开始/重开；Esc 关闭设置优先于暂停。按钮和键盘调用相同 Engine 方法。
- 左右：首次 keydown 立即移动 1 格；按住 150ms（DAS）后每 45ms（ARR）再移动 1 格；防重复键盘 keydown 造成双触发。`↓` 按住每 35ms 触发一次 `softDrop()`，首次即刻触发；`↑/Space/X/Z/C/P` 长按不重复触发。页面失焦、弹窗、松开即清空持续输入。左右同时按下时最后按下方向优先，松开后可恢复另一方向的持续移动。
- 触屏虚拟按键：左、右、软降支持长按（同上节）；顺转、逆转、硬降、Hold 单击一次；单独暂停按钮。按钮可见清晰，最小触控目标 **44×44 CSS px**；监听 `pointerdown`/`pointerup`/`pointercancel`，不使用仅适用于鼠标的事件；游戏区域 `touch-action: none` 防止触摸操作滚屏。不要设置整个文档禁止滚动。

### S03.4 SRS 墙踢（固定坐标表）

- 先计算目标旋转阵列（旋转态 `0→1→2→3→0`），再按下表偏移 `(dx,dy)` 依次测试**第一处可放置**即成功，全部失败则完全维持原状态。O 旋转不改变位置、不踢墙。
- 下表已转换为本项目**屏幕坐标，y 向下为正**。`1` 为 R，`3` 为 L；不得再次翻转 dy，不得用一组简单 ±1 通用踢墙替代。参考原 SRS 文献通常使用 y 向上，此处专门做了坐标转换。

| 状态变化 | J/L/S/T/Z：按顺序测试偏移 | I：按顺序测试偏移 |
|---|---|---|
| 0→1 | `(0,0),(-1,0),(-1,-1),(0,2),(-1,2)` | `(0,0),(-2,0),(1,0),(-2,1),(1,-2)` |
| 1→0 | `(0,0),(1,0),(1,1),(0,-2),(1,-2)` | `(0,0),(2,0),(-1,0),(2,-1),(-1,2)` |
| 1→2 | `(0,0),(1,0),(1,1),(0,-2),(1,-2)` | `(0,0),(-1,0),(2,0),(-1,-2),(2,1)` |
| 2→1 | `(0,0),(-1,0),(-1,-1),(0,2),(-1,2)` | `(0,0),(1,0),(-2,0),(1,2),(-2,-1)` |
| 2→3 | `(0,0),(1,0),(1,-1),(0,2),(1,2)` | `(0,0),(2,0),(-1,0),(2,-1),(-1,2)` |
| 3→2 | `(0,0),(-1,0),(-1,1),(0,-2),(-1,-2)` | `(0,0),(-2,0),(1,0),(-2,1),(1,-2)` |
| 3→0 | `(0,0),(-1,0),(-1,1),(0,-2),(-1,-2)` | `(0,0),(1,0),(-2,0),(1,2),(-2,-1)` |
| 0→3 | `(0,0),(1,0),(1,-1),(0,2),(1,2)` | `(0,0),(-1,0),(2,0),(-1,-2),(2,1)` |

### S03.5 消行、计分、等级

- 碰撞确定后锁入棋盘；检测**所有** 24 行是否满 10 格；同时移除已满行，原顺序的非满行整体下移，并在顶部补等量 `null` 行；最多一次 4 行，行数为 0..4。
- 清行使用清行发生**之前**的 level：1/2/3/4 行分别加 `100/300/500/800 × level`；手动软降每有效移动一格 +1；硬降按实际落差每格 +2（0 格 +0）；自然重力 +0。无连击、T-Spin、B2B 等额外分数。
- 初始 `score=0, lines=0, level=1`；每累计 10 行提升一级：`level=1+floor(lines/10)`，无级别上限。按清行前的 level 结算本次消除，再更新等级。
- `bestScore` 来自持久层，不属于 Engine 规则；仅当游戏分数超过已保存最高分时同步保存（允许每次变化时保存），存储错误不可使游戏崩溃。

## S04. 视觉规范（不得自行换主题）

### S04.1 方向与效果

- 关键词：**午夜蓝 / 赛博霓虹 / 精致轻玻璃 / 安静背景、清晰棋盘**。UI 尽量使用原创 CSS、Canvas 像素绘制和一个自绘几何 SVG 图标，不引入外部 PNG/JPG、CDN 图库、网络字体或商业标识。
- 页面背景：深蓝紫径向渐变，两个低透明柔光斑 + 非交互点阵背景；静态点阵，不使用全屏粒子循环。游戏本体对比度高，远离花哨背景。
- 方块：填充色 + 顶部轻微亮边 + 底部较深阴影，轻量玻璃糖果质感；只在方块内部使用渐变，每格 1px 内描边；格子圆角约格宽的 12%，不得大到模糊方形轮廓。锁定块和活动块视觉一致，幽灵块使用 30% 色描边、无填充。
- 网格：主棋盘背景 `#0B1022`、细网格线 `rgba(255,255,255,0.055)`，外框淡紫发光。清行：约 140ms 透明度闪烁/横向扫光；硬降：120ms 竖线光尾；允许减少动画时立即取消特效。不允许大面积屏闪、画面颤动。

### S04.2 色板（精确色值）

| Token | HEX | 用途 |
|---|---|---|
| `--bg` | `#080B19` | 页面深底 |
| `--panel` | `#12192E` | 卡片背景 |
| `--board` | `#0B1022` | 棋盘背景 |
| `--text` | `#EDF3FF` | 正文主色 |
| `--muted` | `#A6B5D4` | 辅助字 |
| `--accent` | `#A58CFF` | 主按钮与边框 |
| `--accent-2` | `#45D6E8` | 辅助高光 |
| `I` | `#45D6E8` | 青 |
| `O` | `#FFD166` | 黄 |
| `T` | `#C792EA` | 紫 |
| `S` | `#5EE0A0` | 绿 |
| `Z` | `#FF6B82` | 红 |
| `J` | `#648BFF` | 蓝 |
| `L` | `#FFAC67` | 橙 |

- 字体：本地系统字体栈 `Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`（Inter 若用户设备未装则自动回退；不得远程下载）。标题字重 700–800，数值用 `font-variant-numeric:tabular-nums`；正文不得低于 12px，触屏关键数值 14px 以上。
- UI 卡片 16px 圆角、`1px solid rgba(188,198,255,.16)`、柔和阴影；按钮 12px 圆角、有明显 hover/active/focus-visible；背景色优先于 blur，`backdrop-filter` 只能作为可选渐进增强。

### S04.3 页面和画面结构

**桌面（视口 >= 768px）**：顶部品牌标题、简短模式描述和暂停/声音/设置操作；中部三列：左栏 HOLD、当前分数及历史最高；中栏 10×20 棋盘；右栏 NEXT（三枚）、等级、清行数；底部一行键盘说明。主区域最大宽度 1060px、外侧安全边距 24px、列间距 16–24px；棋盘名义 CSS 尺寸 **300×600px**（单元格 30px），在低矮屏幕同比缩小。

**移动（视口 < 768px）**：顶部品牌缩短为 `NEON BLOCKS` + 简短分数/等级显示；中部同屏采用 **左窄 HOLD / 中间棋盘 / 右窄 NEXT**（面板宽 60–74px，间隙 6–8px），保持玩家一眼看到关键预览；下方设置 2 行虚拟按钮（左右/软降、旋转左右/硬降/Hold，根据可用宽度换行）；暂停按钮固定在顶部可见。棋盘按可用宽高**同比缩放**，不可拉伸、不裁切，最小支持 320×640 视口，允许高度极低设备纵向滚动但不得横向溢出。NEXT 面板移动端至少显示前 2 块，能容纳则显示第 3 块；逻辑仍始终预存 5 块。

示意（非精确字符宽度，仅表达关系）：

```text
┌────────────────────────────────────────────────────┐
│ ◇ NEON BLOCKS                         [♪] [⚙] [Ⅱ]  │
│                 ENDLESS / MARATHON                 │
├────────────┬────────────────────┬─────────────────┤
│ HOLD       │                    │ NEXT            │
│  [T]       │    10 × 20 GRID    │ [L]             │
│            │   ▦ ▦ ▦ ▦ ▦ ▦ ▦   │ [I]             │
│ SCORE      │   ▦ ▦ ▦ ▦ ▦ ▦ ▦   │ [O]             │
│  002460    │                    │                 │
│ BEST       │                    │ LEVEL  03       │
│  012400    │                    │ LINES  26       │
└────────────┴────────────────────┴─────────────────┘
│   ← → 移动 / ↓ 软降 / ↑ 或 Space 硬降 / Z X 旋转  │
```

- 三种覆盖层：READY（欢迎介绍+高辨识度“开始游戏”按钮+简短操作说明）、PAUSED（暂停中+继续/重新开始）、GAMEOVER（本局成绩+最高分+再玩一次）；均为 `role=dialog` 的真实 HTML，而不是只在 Canvas 绘制文字。设置弹窗同理，弹出后自动暂停。
- 固定区块属性：棋盘 `aria-label="游戏棋盘，10 列 20 行"`；按钮 `<button type="button">` 有 aria-label；页面 `<main>` 与标题层次有意义；焦点可见，设置弹窗按 Escape 关闭并恢复触发按钮焦点。重要状态文字可读，Canvas 并非唯一状态来源。

### S04.4 静态 SVG 图标

- `public/favicon.svg`：透明背景的原创 4 块阶梯/闪电形几何标记，主色 `#A58CFF` 和 `#45D6E8`，viewBox `0 0 64 64`，不加商业文字、不借用已有图标。
- 品牌左侧可重复使用该 SVG（`<img>` 本地地址），不必再制作大型插画；方块和 NEXT/HOLD 的绘制即核心游戏图像。禁止“先找网图凑页面”。

## S05. Canvas 渲染性能与动画契约

- 游戏逻辑固定网格坐标、与像素无关；`renderer.ts` 使用 2D Canvas，CSS 盒子大小×`min(devicePixelRatio,2)` 设置内部 backing store，每次重新设置 `ctx.setTransform(dpr,0,0,dpr,0,0)`，避免累计 scale。监听 ResizeObserver 或 window resize，不重复创建事件监听。
- 使用单个主棋盘 Canvas 绘制背景网格、锁定块、ghost、活动块；**NEXT/HOLD 预览**可用 CSS Grid 4×4 小格或 Canvas，但二者须调用相同方块色板与矩阵；预览不得依赖游戏主循环重新生成 DOM。
- `requestAnimationFrame` 用 timestamp 算 dt，单循环，游戏逻辑和渲染分离。UI 数字仅变化时更新 DOM；动画每帧至多遍历 240 棋盘格+活动单元格。避免 `shadowBlur` 对每块重复设置或复杂 `filter`；柔光外框由 CSS 实现。
- 目标：中档桌面 Chromium 1080p 下稳定达到显示器常见 60fps；功能正确性优先；3 分钟连续试玩无明显卡顿、内存持续无界增长、按键积压。不是承诺所有设备 60fps；只有真实浏览器测量后才能给出测试通过结论。
- `prefers-reduced-motion:reduce` 下关闭/简化清行扫光、硬降光尾、背景运动；`audio` 默认关闭，并且 AudioContext 只能在用户手势后创建。暂停/切后台不能继续播放持续音频。

## S06. 输入与体验边界

- READY/PAUSED/GAMEOVER 的 Canvas 不接受移动输入；开始后无需先点击 Canvas 聚焦即可由页面正常键盘操作（当输入焦点位于按钮时，方向键等依然响应，设置交互时不响应）；可滚动页面非游戏状态不应被一律拦截。
- 只有在 running 且不是表单/对话框输入焦点时，对受控的游戏方向/空格按键 `preventDefault`；不要劫持浏览器所有快捷键。
- 重新开始：通过按钮立即重置并开始新局；处于 running 状态的菜单“重新开始”需二次确认，防止误触。结束覆盖层显示本局得分与最高分。
- 页面离开可不恢复残局（v1 非存档游戏）；保留用户配置和最高分。静音、ghost 开关、减少动画开关来自本地存储且有默认值。

## S07. 设置持久化

- 存储 key `neon-blocks:v1:settings`，对象 `{soundEnabled:false,ghostEnabled:true,reducedMotion:false}`，系统 `prefers-reduced-motion` 为 true 时**最终减少动画=系统偏好 OR 用户选项**。
- key `neon-blocks:v1:best-score` 是非负安全整数文本，解析失败→0。旧损坏 JSON→默认值。localStorage 访问在 `try/catch` 内，私密模式或禁用存储时游戏依然可玩。
- 无其他必须保留的数据；刷新后游戏复位 ready；不保存正在下落的方块。

## S08. 声效、反馈与质量门槛

- WebAudio 合成 4 种短声：move（弱、可节流）、rotate、lock、clear；不需要音乐和音频素材。默认静音，避免页面初次打开自动播放；移动长按时不得每帧发声。
- 轻量动效：清行 140ms，高亮后消失；硬降光迹 120ms；分数文本短暂闪亮 CSS 过渡。FX 层不影响逻辑/命中；用户关闭/系统减少动画时直接跳过。
- 核心 6 份单元测试（pieces/random/board/srs/scoring/engine）及设置测试（settings）可运行；E2E 分别覆盖桌面键盘、手机触控、暂停和重开、设置恢复、基本 DOM 可见性；测试稳定，无依赖真实时间的 sleep（使用 Playwright expect 的等待或 Fake Clock）。
- 关键回归：七袋无重复、越界不能移动、SRS 双向与 I 独立踢墙、Hold 锁定前限 1 次、硬降即时锁定、清 4 行+800×level、10 行升级、背景自动暂停、restart 清空计数、移动端无横向溢出。
- 发版质量门槛：`npm run typecheck`、`npm run test`、`npm run build`、`npm run test:e2e` 全部 exit code 0；实测人工通过 Chrome/Edge（PC）与手机浏览器，记录截图和手动结果。若实际无法在目标浏览器验证，状态标为“未验证”，不能写“通过”。

## S09. Agent 执行规范

1. 每轮只执行清单中**最早未完成且依赖已经通过**的一个任务。只读该任务、其注明的本规格节、必要的相关代码；不自发做下一步。
2. 允许修改范围以任务列出的文件为主；仅当构建需要，可改 `package.json`/`package-lock.json`，需写入变更记录。禁止无批准更换架构/加依赖/改需求。
3. 实现 → 对应自动测试 → 全量现有测试 → typecheck/build → 记录证据 → 勾选任务，**任一失败则不勾选、不开始下一项**。
4. 执行日志 `docs/execution-log.md` 必须每项追加：任务 ID、时间、修改文件、关键实现、实际执行命令+退出码、测试数量/结果、截图位置（若有）、问题与修复。可将日志行或测试证据复制到外部任务平台，但不得只给聊天口头结论。
5. 已有失败如果不属本任务且阻塞：记录 BLOCKED，说明复现步骤并停下；不得绕过验收、注释掉失败测试或改弱预期。超出边界应先停下来请求修改规格。
6. 不提交 `node_modules/`、`dist/`、`test-results/` 到仓库；`docs/screenshots/` 可以保留最终验收截图。没有 Git 仓库时禁止捏造 commit hash。

## S10. 参考资料与核对说明

- 公开的玩法共识（**并非官方授权文档**）：https://tetris.wiki/Tetris_Guideline （10×20、7-bag、Ghost、Hold 的参考）
- SRS 各向墙踢：https://tetris.wiki/Super_Rotation_System （本规格已做 y 方向转换）
- 计分示例：https://tetris.wiki/Scoring （本项目只选取普通清行及软硬降子集）
- Vite 官方：https://vite.dev/guide/ ；Vitest：https://vitest.dev/guide/ ；Playwright：https://playwright.dev/docs/intro
- MDN Canvas 性能：https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
- MDN requestAnimationFrame：https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- MDN 减少动画：https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
- 已查看 TETR.IO 公开游戏界面作为**信息层级**参考（左 HOLD / 中主棋盘 / 右 NEXT）；本项目不复制其页面、图像、代码、特效。参考不构成必须兼容商业游戏每项规则。

**规格结论**：上述数字、矩阵、坐标、颜色与接口是硬约束。v1 首先保证玩法正确、操控稳定和布局完整，再增加轻量视觉反馈；不因追求特效损害性能或阻塞任务。
