# G3 关口检查：N31–N40 全部关闭 + 单机全量回归

> 任务清单 §关口 G3：进入 G4（N41–N43）前的单机全量回归必跑项。
> 执行时间：2026-10-21，基线提交 `c5e290d`（N40-b）。

## N31–N40 关闭记录（提交哈希）
| 任务 | 提交 | 任务 | 提交 |
| --- | --- | --- | --- |
| N31 | `cdbf46f` | N36 | `d13962d` |
| N32 | `c637c8a` | N37 | `dc11e4e` |
| N33 | `255c48f` | N38 | `a760d64` |
| N34 | `5185121` | N39-a | `1e2f325` |
| N35 | `80eb0ee` | N39-b | `d770871` |
| — | — | N40-a | `7277cca` |
| — | — | N40-b | `c5e290d` |

每项均含独立只读复审（P1/P2 修复后关闭）与 `evidence/multiplayer/Nxx/` 证据目录。

## 单机全量四项命令（清单 §0-7，必跑）
| 命令 | 结果 | 用时 |
| --- | --- | --- |
| `npm ci` | 退出码 0 | 2.4s |
| `npm run typecheck`（tsc -b） | 0 错误 | — |
| `npm run test`（vitest run） | 27 文件 / 412 通过 | 1.3s |
| `npm run build`（tsc -b && vite build） | 退出码 0，built in 125ms | — |

## E2E（`npx playwright test`）
- 全量（无 worker，8787 端口确认无监听）：**15 通过 / 12 跳过**（mp 组按 workerUp 守卫跳过），6.4s。
- mp 组（worker 8787 在跑）：mp-lobby 4 + mp-layout 3 + mp-boards 1 + mp-results 1 + mp-resilience 3 = **12 通过**，26.8s。

## Worker 侧
- `npx vitest run`（worker 目录）：27 文件 / 219 通过。
- `npx tsc --noEmit`：0 错误。

## 结论
**G3 PASS**：无单机退化（四项命令 + 全量 E2E 全绿），联网 G3 段（N31–N40）全部关闭。原始输出见本目录。
