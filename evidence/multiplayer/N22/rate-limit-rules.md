# N22 边缘限流规则的配置/依赖（Cloudflare Rate Limiting Rules）

## 1. 两层机制与各自边界

| 层 | 机制 | 计数范围 | 角色 |
|---|---|---|---|
| Worker 内 | 有界滑动窗口（`worker/src/index.ts`：`rateWindow` Map，60s 窗口，桶数封顶 4096，按插入序淘汰） | **每实例（isolate/colo）**，非全局 | 纵深防御 + 本地模拟可验证；恶意 IP 基数增长时表大小封顶，不构成无限增长进程级 Map |
| 边缘 | Cloudflare Rate Limiting Rules（WAF 安全规则） | 全 zone 分布式一致 | **按 IP 的分布式限流权威机制**（清单 N22 指定） |

Worker 桶为每实例计数：同一 IP 的最坏全局放行量 ≈ 限额 × 该端点活跃 isolate 数（有界但非精确）。因此分布式 IP 限流**必须**由边缘规则承担，Worker 桶只保证单实例内的下限保护。

## 2. 免费计划能力核实（2026-08 检索）

- 新版 Rate Limiting Rules 各计划配额：**Free = 每 zone 1 条规则**；计数周期 Free 仅支持 **10 s**；缓解（mitigation）时长 Free 仅 **10 s**；计数特征（characteristics）Free 仅 **IP Source Address**；动作可用 Managed Challenge / Block（Free/Pro/Business 用 challenge 动作时为 request throttling，不可选时长）。
  来源：https://developers.cloudflare.com/waf/rate-limiting-rules/ （计划对照表）、https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/
- 旧版 Rate Limiting（已弃用）Free：1 条规则、仅 Block、周期 10s/1min、封禁 1min/1h。
  来源：https://developers.cloudflare.com/waf/reference/legacy/old-rate-limiting
- 仪表盘创建路径：Security → WAF → Rate Limiting Rules（zone 级）。
  来源：https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/

**依赖**：Rate Limiting Rules 挂在 **zone** 上。`*.workers.dev` 预览子域属于 Cloudflare 共享 zone，免费计划无法为其自建规则；须绑定**自定义域/路由**（N44 部署阶段）后规则方可生效。

## 3. 建议规则（免费计划 1 条额度，覆盖创建+试码主面）

```
表达式:  (http.request.method eq "POST" and http.request.uri.path contains "/api/rooms")
特征:    IP Source Address
周期:    10 s
阈值:    10 次/周期（正常好友访问远低于此；脚本洪泛必超）
动作:    Managed Challenge（止损场景可改 Block）
时长:    10 s（Free 上限）
```

WS 握手（`/ws/*`）不经 WAF HTTP 规则计数覆盖时，由 Worker 内 probe 桶 + 票据单次性兜底。

## 4. 免费计划不足以支撑时的生产开关

若部署时 zone 无法承载所需分布式 IP 限流（如仍停留在 workers.dev 预览域、或规则额度/周期不足），置
`PUBLIC_CREATE_ENABLED = "false"`（`worker/wrangler.jsonc` vars）→ `POST /api/rooms` 一律
**503 CREATE_DISABLED**（`shared/errors.ts` 目录码，retryable），公开创建止损；既有房间的
join/ticket/ws 不受影响，正常好友访问不误拒。开关恢复 `"true"` 即回正常（单测
`http-ratelimit.test.ts` 正反双向覆盖）。

## 5. 本地模拟验证结果（见同目录 `smoke-local.txt`）

- 高频创建：同 IP 30/min 限额 → 29×201 + 5×429，`Retry-After: 49`；
- 试码冷却：对不存在房间 24 连 join（预算 20）→ 20×404 + 4×429，`Retry-After: 60`；
- 桶独立：创建桶耗尽后既有房间 join 仍 200；
- 正常路径不误拒：create 201 / join 200 / ticket 200 / WS Open+pong。
