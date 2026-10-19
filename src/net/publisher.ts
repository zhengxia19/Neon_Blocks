/**
 * N24：客户端快照发布器——节流（默认 250ms，硬下限 200ms=最大 5Hz）、
 * 去重（与上一已接受快照编码一致则不发）、连接失效/单机模式不发、
 * 慢网只保留最新一帧（trailing 定时器仅挂一个，pending 覆盖旧帧）。
 *
 * 验收锚点：60 FPS 连发 10 分钟 ≤2400 条/玩家（默认间隔），绝非 36000 条。
 */
import type { SnapshotPayload } from '../../shared/protocol';
import { encodeSnapshot } from './snapshot';

/** 默认发布间隔（毫秒）。 */
export const SNAPSHOT_INTERVAL_MS = 250 as const;
/** 最小间隔（毫秒）：任何配置不得快于 5Hz。 */
export const SNAPSHOT_MIN_INTERVAL_MS = 200 as const;

export type PublishReject = 'inactive' | 'invalid' | 'unchanged' | 'throttled' | 'transport_down';
export type PublishResult = { sent: true } | { sent: false; reason: PublishReject };

export interface PublisherOptions {
  /** 传输出口：由 N31 连接层注入；仅在返回 true 时计为已发送。 */
  send: (text: string) => boolean;
  /** 期望间隔；低于 200ms 一律钳制（5Hz 上限）。 */
  intervalMs?: number;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
}

export class SnapshotPublisher {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly send: (text: string) => boolean;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastEncoded: string | null = null;
  private pending: string | null = null;
  private active = true;
  private connected = false;

  constructor(opts: PublisherOptions) {
    this.send = opts.send;
    this.now = opts.now ?? Date.now;
    const requested = opts.intervalMs ?? SNAPSHOT_INTERVAL_MS;
    // 钳制封闭：NaN/Infinity（配置解析失败）回落默认值，防 due=NaN 击穿 5Hz 上限。
    this.intervalMs = Number.isFinite(requested)
      ? Math.max(SNAPSHOT_MIN_INTERVAL_MS, requested)
      : SNAPSHOT_INTERVAL_MS;
  }

  /** 单机模式或未进入联网装配时置 false：任何 publish 均不发。 */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.dropPending();
  }

  /** 连接状态：断开即丢弃 pending 与定时器；重连时把 pending 挂回节流窗口。 */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      this.dropPending();
    } else if (this.pending !== null && this.timer === null) {
      const delay = Math.max(0, this.lastSentAt + this.intervalMs - this.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, delay);
    }
  }

  /** 发布一帧：去重→节流→立即发或挂 trailing（只保留最新一帧）。 */
  publish(snapshot: SnapshotPayload): PublishResult {
    if (!this.active || !this.connected) return { sent: false, reason: 'inactive' };
    let text: string;
    try {
      text = encodeSnapshot(snapshot);
    } catch {
      return { sent: false, reason: 'invalid' };
    }
    if (text === this.lastEncoded) return { sent: false, reason: 'unchanged' };
    const now = this.now();
    const due = this.lastSentAt + this.intervalMs;
    if (now >= due) {
      if (this.deliver(text, now)) {
        // 直发的是最新帧：旧 pending 必为陈旧帧，清除以防定时器晚发旧帧。
        this.pending = null;
        return { sent: true };
      }
      return { sent: false, reason: 'transport_down' }; // 已回滚为 pending
    }
    this.pending = text; // 慢网/高频：旧 pending 被覆盖，只保留最新一帧
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, due - now);
    }
    return { sent: false, reason: 'throttled' };
  }

  /** 停机：清定时器与 pending（页面卸载/离开房间时调用）。 */
  stop(): void {
    this.dropPending();
  }

  /** 当前是否有待发的最新帧（诊断用）。 */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  private flush(): void {
    if (this.pending === null) return;
    if (!this.active || !this.connected) return;
    const text = this.pending;
    this.pending = null;
    if (text === this.lastEncoded) return; // trailing 到期前若已发出同内容则跳过
    this.deliver(text, this.now());
  }

  private deliver(text: string, now: number): boolean {
    if (!this.send(text)) {
      // 传输层拒绝（连接实际已死）：回滚为 pending，等待重连后重发。
      this.pending = text;
      return false;
    }
    this.lastEncoded = text;
    this.lastSentAt = now;
    return true;
  }

  private dropPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
