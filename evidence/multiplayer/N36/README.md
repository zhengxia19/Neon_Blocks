# N36 证据：固定双棋盘响应式布局

## 验收对照（任务清单 N36 / 方案 §6.1）
- 桌面 1280：本人 300×600 主棋盘 + 对手 180×360（60%，处于 55%～70% 区间）+ 旁边排行榜列；无重叠、无横向溢出 → `shot-desktop.png`
- 390×844 / 320×568：对手棋盘缩略条置顶（order:-1 整行）、本人游戏区与触屏按键优先——触控区完整位于首屏视口内（E2E 断言 `touchBox.y+height ≤ viewport.height`）；排行榜手机默认折叠、一键展开全部玩家 → `shot-390.png`、`shot-320.png`
- 全页严格 2 个 Canvas（`locator('canvas')` count===2，双端各自验证）
- 320/390/桌面均断言 `scrollWidth - clientWidth ≤ 0`（无横向溢出）

## 原始输出
| 文件 | 结果 |
| --- | --- |
| root-vitest.txt | 23 文件 / 361 用例全过（新增 multiplayer-layout.test.ts 6 用例） |
| root-tsc.txt | 0 错误 |
| build.txt | 构建成功；multiplayer chunk 22.43 kB（首次包含双棋盘布局，哈希变化符合预期） |
| worker-vitest.txt | 26 文件 / 216 用例全过（Worker 侧无改动） |
| worker-tsc.txt | 0 错误 |
| e2e-with-worker.txt | mp-lobby 4 + mp-layout 3 = 7/7（Worker 8787 在跑） |
| e2e-full-no-worker.txt | 15 passed / 7 skipped（mp-lobby 4 + mp-layout 3 自动跳过） |

## 截图
- `shot-desktop.png`（1280×720，5 列：暂存/得分 | 主棋盘 | 下一个/等级/消行 | 对手棋盘 | 排行榜）
- `shot-390.png`（390×844，对手缩略条置顶 + 本人游戏区 + 折叠排行榜）
- `shot-320.png`（320×568，触控区 7 键完整首屏可见，排行榜折叠）

## 过程记录
- 首版桌面 5 列规则泄漏到移动断点（`.mp-mode .playfield` 优先级高于 responsive.css）→ 移入 `@media (min-width: 768px)`。
- 320×568 触控区超首屏：压缩手机预算——对手缩略 48×96、面板 padding 收紧、mp 手机隐藏侧栏重复统计（得分/最高分/等级已在顶栏 mini 条）、本人棋盘 `max-height: calc(100vh - 440px)`。
- 折叠判定在挂载时求值：E2E 手机用例改为从建房起即用小视口（与真实手机用户一致）。
- 大厅 ready 点击偶发丢失竞态：mp-layout 用 `readyUp`（对端席位确认+补点）、mp-lobby N34 用 `readyBoth` 加固；复审后补 `isEnabled` 守卫——ready 单向成功后按钮禁用，无条件补点会 actionability 挂死（N34 用例曾因此超时）。
- 复审 P2-1：match.ts rAF 循环缺 `touchRepeat.update(dtMs)`/`keyboard.update(dtMs)`——RepeatController 无独立计时器，长按 ↓（键盘与触屏）只触发一次软降；已补每帧推进（与单人主循环同构）+节奏断言。
