# Neon Blocks｜霓虹方块

纯前端网页版俄罗斯方块（Tetris Guideline 规则）。TypeScript + Vite 构建为**静态站点**：
无后端、无外部图片/字体、运行期零网络请求。规则引擎与 Canvas 渲染严格分离，
单元测试 + Playwright 端到端测试全覆盖。

## 功能

- 标准 10×20 棋盘（隐藏生成区 4 行）、7-bag 随机、SRS 旋转（含 I 独立踢墙表与双向墙踢）
- 幽灵方块（Ghost）、Hold 暂存（每块一次）、NEXT 三预览
- 软降/硬降、锁定延迟 500ms（移动/旋转重置上限 15 次）、长按 DAS 150ms / ARR 45ms
- 消行计分（1/2/3/4 行 = 100/300/500/800 × 等级，硬降每格 2 分、软降每格 1 分）、每 10 行升一级
- READY / RUNNING / PAUSED / GAME OVER 四状态覆盖层；失焦或切后台自动暂停
- 霓虹视觉：面板配色、方块渐变高光、清行闪光与硬降拖影（`prefers-reduced-motion` 自动降级）
- WebAudio 合成 4 种短音（move/rotate/lock/clear），**默认静音**避免自动播放限制
- 本地持久化：设置与历史最高分跨刷新保留；键盘与触屏双输入

## 安装与运行

要求 **Node.js ≥ 20**（实测 Node 24.x + npm 11）。

```bash
npm ci            # 安装依赖（package-lock 锁定）
npm run dev       # 开发服务器（默认 http://localhost:5173）
npm run build     # 类型检查 + 生产构建 → dist/
npm run preview   # 本地预览 dist（构建产物）
```

## 静态部署

`npm run build` 后把 `dist/` 整个目录交给任意静态服务器
（Nginx / GitHub Pages / 对象存储均可），直接打开 `index.html` 即可；
无环境变量、无 API、无回退路由要求。

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
| P 或 Esc | 暂停 / 继续 |
| Enter | 开始（READY）/ 再玩一次（GAME OVER） |

在输入框或打开的设置对话框内，游戏快捷键自动让位于焦点控件。

### 触屏（窄屏 / 粗指针设备）

屏幕下方 7 枚 ≥44px 虚拟键：← 移动、→ 移动、↓ 软降、⤓ 硬降、↺ 逆时针、↻ 顺时针、⤒ Hold；
左右与软降支持长按连发。暂停与设置在顶部图标按钮。

## 测试

```bash
npm run typecheck   # tsc 全量类型检查
npm run test        # Vitest 单元测试（引擎/SRS/存储等）
npm run test:e2e    # Playwright E2E（chromium 桌面 + Pixel 7 移动模拟）
npm run build       # 构建
```

E2E 首次运行前需安装浏览器：`npx playwright install chromium`。

## 设计说明

- `src/game/`：纯规则引擎（无 DOM/无渲染），可注入 rng 与计时器实现确定性测试。
- `src/ui/`：Canvas 渲染器、HUD、覆盖层、特效（事件驱动、140ms 内自动清理，不持有定时器循环）。
- `src/input/`：键盘长按状态机（DAS/ARR 在 rAF 帧内推进，零 setInterval）与触控按钮。
- `src/storage/`：localStorage 读写（异常安全，脏数据回退默认值）。
- `src/audio/`：WebAudio 振荡器合成短音，启用时才创建 AudioContext。
- 存储键：`neon-blocks:v1:settings`（JSON `{soundEnabled, ghostEnabled, reducedMotion}`）、
  `neon-blocks:v1:best-score`（十进制整数字符串）。

## 兼容性

在 Windows 10/11 的 Chromium 内核浏览器（Chrome / Edge）实测通过；
移动版 Chromium（Pixel 7 模拟，320–390px 视口）触控闭环通过。
其他现代浏览器理论上兼容但未逐一验证。

## 已知范围限制（v1）

- 无联机、无 T-Spin/B2B/连击加分、无账号与云端存档；
- 刷新/关闭不恢复残局（非存档游戏），仅保留设置与最高分；
- 音效默认关闭，需顶部喇叭按钮或设置弹窗手动开启；
- 移动端为虚拟按键方案，未做手势滑动画布操作。
