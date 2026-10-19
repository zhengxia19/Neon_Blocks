// vitest（node 环境）对 `cloudflare:workers` 的最小 stub：仅供导入解析；
// DO 运行时行为由 wrangler 本地模拟实证（见 evidence/multiplayer/N08/wrangler-local.txt）。
export class DurableObject {
  ctx: unknown;
  constructor(ctx: unknown, _env: unknown) {
    this.ctx = ctx;
  }
}
