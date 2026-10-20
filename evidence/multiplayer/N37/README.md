# N37 证据：全员统一排行榜组件

## 验收对照（任务清单 N37 / 方案 §5）
- 仅渲染服务端 `scoreboard` 广播的同一份榜单（LeaderboardEntry[]，同 revision 全员一致）：`buildRows` 逐行照抄输入顺序与 rank——客户端不排序、不计算名次（乱序输入照抄的反向单测钉死）。
- 表内 2～6 人按得分排（服务端权威）；自己仅高亮（`lb-self` 行类 + `aria-current`，不改行序）。
- 胜者独立标识：`winnersSummary` 横幅（「本局胜者：…」按榜单顺序取昵称，全员文案一致）+ 行标记 `lb-winner`，与名次/得分第一语义分离；标识不改变行序（终局仍按得分排，单测钉死）。
- 已淘汰者留榜分数固定（statusLabel「已淘汰」）；断线显示「连接中断」。
- 「不同客户端名单/顺序/分数/名次完全一致」由组件无排序/无名次计算 + 服务端单份广播保证；跨客户端 E2E 断言属 N38 接线范围。

## 原始输出
| 文件 | 结果 |
| --- | --- |
| root-vitest.txt | 24 文件 / 369 用例全过（新增 leaderboard-ui.test.ts 8 例） |
| root-tsc.txt | 0 错误 |
| build.txt | 构建成功；mp chunk 22.43 kB 不变（组件尚未接线，N38 入包）；index CSS 11.31 kB（+lb 样式） |
| worker-vitest.txt | 26 文件 / 216 用例全过（服务端零改动） |
| worker-tsc.txt | 0 错误 |
| e2e-full-no-worker.txt | 15 passed / 7 skipped（新 CSS 无回归） |

## 测试构成（leaderboard-ui.test.ts 8 例）
- 正向：六状态中文映射；分数降序+并列名次（1,2,2,4）逐行照抄+本人仅高亮；终局已淘汰留榜+胜者标记不改行序（得分第一 p_w 2000 ≠ 胜者 p_s，rank 1/2/3 断言）；winnersSummary 多胜者按榜单顺序/空胜者空串；未知 winnerId 不影响行。
- 反向：乱序输入照抄（证明客户端绝不重排）；源码无 fetch/WebSocket/innerHTML/`.sort(`/`Date.now`/`Math.random`。

## 复审（独立只读，PASS：P1×0、P2×0、O×4）
复跑数字与证据逐项吻合；mp chunk 未含组件经产物字符串扫描证实。合入前修复复审 O-1（终局 fixture 名次不自洽 → 1/2/3 + rank 断言）、O-2（update 按引用保存 entries → 复制数组）。行为级 DOM 覆盖由 N38 E2E 兑现（O-5）。
