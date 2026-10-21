# Neon Blocks｜霓虹方块

TypeScript + Vite 构建的**静态站点**网页俄罗斯方块（Tetris Guideline 规则），
支持**单人模式**与 **2～6 人联网对战模式**。

- 单人模式无后端、无外部图片/字体、运行期零网络请求；规则引擎与 Canvas 渲染严格分离，
  单元测试 + Playwright 端到端测试全覆盖。
- 联网对战由独立的 **Cloudflare Workers + SQLite-backed Durable Objects** 房间服务支撑
  （`worker/` 目录，独立 package），前端仍为纯静态站点，经
  `VITE_MULTIPLAYER_API_URL` 连接公开 API。

## 功能

### 单人模式

- 标准 10×20 棋盘（隐藏生成区 4 行）、7-bag 随机、SRS 旋转（含 I 独立踢墙表与双向墙踢）
- 幽灵方块（Ghost）、Hold 暂存（每块一次）、NEXT 三预览
- 软降/硬降、锁定延迟 500ms（移动/旋转重置上限 15 次）、长按 DAS 150ms / ARR 45ms
- 消行计分（1/2/3/4 行 = 100/300/500/800 × 等级，硬降每格 2 分、软降每格 1 分）、每 10 行升一级
- READY / RUNNING / PAUSED / GAME OVER 四状态覆盖层；失焦或切后台自动暂停
- 霓虹视觉：面板配色、方块渐变高光、清行闪光与硬降拖影（`prefers-reduced-motion` 自动降级）
- WebAudio 合成 4 种短音（move/rotate/lock/clear），**默认静音**避免自动播放限制
- 本地持久化：设置与历史最高分跨刷新保留；键盘与触屏双输入

### 联网对战模式（2～6 人同步竞赛）

- 首页单人/联网分流；创建/加入 6 位数字房间码，昵称 `^[A-Za-z0-9]{1,16}$`
- 房主设置容量 2～6 人、随机模式 S1（全员同序列）/ S2（按席位派生种子）/ S3（房主自定义种子）、
  起始等级 1～10；全员准备后开赛，改配置自动清空准备状态
- 服务器权威时钟：统一倒计时开局、600 秒上限、DO Alarm 幂等裁决；仅剩 1 人存活立即胜出
- 固定**双棋盘**：自己主棋盘 + 服务端自动选定的 1 个观察对象（绝无第三张棋盘）
- 全员统一实时排行榜（服务端同 revision，同分并列名次，胜者独立标记），限频 ≤2Hz
- 棋盘快照上行默认 4 次/秒（硬上限 5 次/秒、≤4 KiB），服务端单目标路由转发，无全互播
- 断线宽限 30 秒（刷新/断网自动重连恢复，超时按淘汰）；联网模式禁用个人暂停/重开
- 结算展示剩余时间、已淘汰、获胜/并列与「已淘汰」列；仅房主可开启下一局

## 安装与运行

要求 **Node.js ≥ 20**（实测 Node 24.x + npm 11）。

```bash
npm ci            # 安装前端依赖（package-lock 锁定）
npm run dev       # 开发服务器（默认 http://localhost:5173）
npm run build     # 类型检查 + 生产构建 → dist/
npm run preview   # 本地预览 dist（构建产物）
```

本地联调联网模式（另开终端启动房间服务）：

```bash
cd worker
npm install       # Worker 独立 package（Wrangler 等均为 devDependency）
npm run dev       # wrangler dev，本地 8787 端口模拟 Worker/DO
```

前端联网入口按「配置模式」分流：URL 带 `?mode=multiplayer` 且构建/开发期配置了
`VITE_MULTIPLAYER_API_URL` 才进入联网装配，任一条件不满足一律回退单人模式
（单机永远可玩）。开发时可直接设置环境变量，例如
`$env:VITE_MULTIPLAYER_API_URL="http://127.0.0.1:8787"` 后 `npm run dev`。

> **Windows 提示**：部分 Windows 环境（本机实测）中 Vite 默认绑定 `localhost`
> 时实际只监听 IPv6 环回 `[::1]`，浏览器按 IPv4（`127.0.0.1`）解析会得到
> “连接被拒绝”。此时显式绑定 IPv4 即可：
> `npm run dev -- --host 127.0.0.1` 后打开 <http://127.0.0.1:5173/>；
> 预览同理：`npm run preview -- --host 127.0.0.1`。

## 部署

### 前端（GitHub Pages）

`npm run build` 后把 `dist/` 整个目录交给任意静态服务器
（Nginx / GitHub Pages / 对象存储均可），直接打开 `index.html` 即可；
无回退路由要求。GitHub Pages 工作流 `.github/workflows/deploy.yml` 保持原样；
联网 API 地址由仓库根 `.env.production` 在 Vite 构建期注入
（`VITE_MULTIPLAYER_API_URL=https://neon-api.notesofxia.cn`）。

### 房间服务（Cloudflare Workers）

在 `worker/` 目录执行 `npm run deploy`（`wrangler deploy`）。当前生产配置
（`worker/wrangler.jsonc`）：

- Worker 名 `neon-blocks-room-api`，单一 SQLite-backed Durable Object（`RoomDO`）；
- 公网入口为自定义域 `https://neon-api.notesofxia.cn`（`workers_dev:false`，
  workers.dev 已关闭），zone 级 Rate Limiting Rules 每 IP 50 req/10s；
- CORS 白名单 `ALLOWED_ORIGINS` 仅 GitHub Pages 站点；`ALLOW_DEV_ORIGINS=true`
  仅在本地模拟/测试时并入开发白名单。

## 操作

### 键盘（桌面）

| 按键 | 动作 |
| --- | --- |
| ← / → | 左右移动（长按连移） |
| ↓ | 软降（长按加速） |
| ↑ 或 X | 顺时针旋转 |
| Z | 逆时针旋转 |
| 空格 | 硬降 |
| C | Hold 暂存 |
| P 或 Esc | 暂停 / 继续（仅单人；联网比赛不可个人暂停） |
| Enter | 开始（READY）/ 再玩一次（GAME OVER） |

在输入框或打开的设置对话框内，游戏快捷键自动让位于焦点控件。

### 触屏（窄屏 / 粗指针设备）

屏幕下方 7 枚 ≥44px 虚拟键：← 移动、→ 移动、↓ 软降、⤓ 硬降、↺ 逆时针、↻ 顺时针、⤒ Hold；
左右与软降支持长按连发。暂停与设置在顶部图标按钮。

### 联网流程

首页选择「联网对战」→ 输入昵称 → 创建房间（发 6 位房间码）或输入房间码加入 →
房主设置人数/随机模式/等级、全员点「准备」→ 统一倒计时开赛 → 对局中查看自己的棋盘、
自动切换的对手棋盘与全员排行榜 → 结算后房主可开下一局或离房。

## 测试

```bash
npm run typecheck   # tsc 全量类型检查（前端 + shared）
npm run test        # Vitest 单元测试（引擎/SRS/协议/存储/网络等）
npm run test:e2e    # Playwright E2E（chromium 桌面 + Pixel 7 移动模拟）
npm run build       # 构建
```

联网服务端：

```bash
npm --prefix worker run typecheck   # Worker 类型检查
npm --prefix worker test            # Worker 单元测试（DO 房间状态机/限流/榜单等）
```

- E2E 首次运行前需安装浏览器：`npx playwright install chromium`。
- `mp-*` 联网 E2E 用例需要本机 Worker（`http://127.0.0.1:8787`，即 `worker` 目录 `npm run dev`）；
  未运行时用例内自动跳过（全量跑显示为 skipped，无回归误报）。
- 跨网测试可用 `E2E_API_URL=<预发API>` 让 E2E 指向远端 Worker。

## 设计说明

- `src/game/`：纯规则引擎（无 DOM/无渲染/无网络依赖），可注入 rng 与计时器实现确定性测试。
- `src/ui/`：Canvas 渲染器、HUD、覆盖层、特效、远程棋盘、排行榜、联网入口/大厅（事件驱动、不持有定时器循环）。
- `src/input/`：键盘长按状态机（DAS/ARR 在 rAF 帧内推进，零 setInterval）与触控按钮。
- `src/storage/`：localStorage 读写（异常安全，脏数据回退默认值）。
- `src/audio/`：WebAudio 振荡器合成短音，启用时才创建 AudioContext。
- `src/net/`：联网 API/WS 客户端（指数退避重连、sessionStorage 席位凭据）、快照编码与限频发布。
- `src/app/`：模式分流与联网装配（按服务器种子/时钟构造本地引擎；网络代码不进单人主包）。
- `shared/`：前后端共享的协议版本、消息类型与校验常量（双方同一份源码编译）。
- `worker/`：Cloudflare Worker + `RoomDO`（Hibernation WebSocket、DO Alarm 权威时钟、
  SQLite 仅存关键业务状态，棋盘快照不落库）。
- 存储键：`neon-blocks:v1:settings`（JSON `{soundEnabled, ghostEnabled, reducedMotion}`）、
  `neon-blocks:v1:best-score`（十进制整数字符串）、
  `neon_blocks_mp_seat_v1`（sessionStorage，联网席位凭据，含短期 seatToken，不进 URL/日志）。

## 兼容性

在 Windows 10/11 的 Chromium 内核浏览器（Chrome / Edge）实测通过；
移动版 Chromium（Pixel 7 模拟，320–390px 视口）触控闭环通过；
联网对战 2～6 人功能矩阵与 600 秒 soak/恶意流量压测通过（见 `evidence/multiplayer/`）。
其他现代浏览器理论上兼容但未逐一验证。

## 已知范围限制

- 无聊天、无账号登录、无全球排行榜、无垃圾行攻击（联网为同步竞赛/生存淘汰制）；
- 无 T-Spin/B2B/连击加分；
- 单人刷新/关闭不恢复残局（非存档游戏），仅保留设置与最高分；联网断线超 30 秒按淘汰、
  凭 sessionStorage 席位凭据可在宽限期内恢复；
- 音效默认关闭，需顶部喇叭按钮或设置弹窗手动开启；
- 移动端为虚拟按键方案，未做手势滑动画布操作；
- 服务端为休闲好友赛规模设计（免费额度口径见 `evidence/multiplayer/N43/README.md`），
  非重度并发商用架构。
