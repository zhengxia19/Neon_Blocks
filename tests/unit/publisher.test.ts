// N24：快照发布器——250ms 默认节流（5Hz 上限）、去重、失效/单机不发、慢网只留最新帧。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotPayload } from '../../shared/protocol';
import { SnapshotPublisher } from '../../src/net/publisher';

function snap(seq: number): SnapshotPayload {
  return {
    seq,
    board: Array.from({ length: 24 }, () => '..........'),
    active: { t: 'T', r: 0, x: 4, y: 2 },
    score: seq * 100,
    lines: 0,
    level: 1,
    status: 'running',
  };
}

function makePublisher(opts?: { intervalMs?: number; acceptSend?: boolean }) {
  const sent: string[] = [];
  const pub = new SnapshotPublisher({
    send: (text) => {
      if (opts?.acceptSend === false) return false;
      sent.push(text);
      return true;
    },
    intervalMs: opts?.intervalMs,
  });
  pub.setConnected(true);
  return { pub, sent };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe('N24 发布器正向', () => {
  it('首帧立即发送；内容未变不发（去重按编码比较）', () => {
    const { pub, sent } = makePublisher();
    expect(pub.publish(snap(1))).toEqual({ sent: true });
    expect(pub.publish(snap(1))).toEqual({ sent: false, reason: 'unchanged' });
    expect(sent).toHaveLength(1);
    // seq 变化即内容变化：不被去重吞掉
    vi.advanceTimersByTime(250);
    expect(pub.publish(snap(2)).sent).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('节流：窗口内挂 trailing 定时器，到期只发最新一帧（慢网语义）', () => {
    const { pub, sent } = makePublisher();
    pub.publish(snap(1)); // t=0 立即
    expect(pub.publish(snap(2))).toEqual({ sent: false, reason: 'throttled' });
    expect(pub.publish(snap(3))).toEqual({ sent: false, reason: 'throttled' }); // 覆盖旧 pending
    expect(pub.hasPending).toBe(true);
    vi.advanceTimersByTime(249);
    expect(sent).toHaveLength(1); // 未到期不多发
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    const last = JSON.parse(sent[1]) as SnapshotPayload;
    expect(last.seq).toBe(3); // 只保留最新一帧，seq=2 被丢弃
    expect(pub.hasPending).toBe(false);
  });

  it('60 FPS 连发 10 分钟：≤2400 条/玩家（默认 250ms），绝非 36000 条', () => {
    const { pub, sent } = makePublisher();
    // 36000 帧 × 16.666ms ≈ 599.98s（窗口严格 <600s，杜绝边界外多挂一帧）
    for (let i = 0; i < 36_000; i += 1) {
      pub.publish(snap(i));
      vi.advanceTimersByTime(16.666);
    }
    expect(sent.length).toBeLessThanOrEqual(2_400);
    expect(sent.length).toBeGreaterThanOrEqual(2_350); // 确按 ~4Hz 满速，非退化静默
    expect(sent.length).toBeLessThan(36_000 / 10); // 远低于逐帧上报
  });

  it('intervalMs 为 NaN/Infinity（配置解析失败）回落默认 250ms，不击穿限频', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { pub, sent } = makePublisher({ intervalMs: bad });
      for (let i = 0; i < 600; i += 1) {
        pub.publish(snap(i));
        vi.advanceTimersByTime(16.666); // 10 秒 60FPS
      }
      expect(sent.length).toBeLessThanOrEqual(41); // 10s/250ms + 首帧
      expect(sent.length).toBeGreaterThan(30);
    }
  });

  it('5Hz 上限：intervalMs=50 被钳制到 200ms，10 秒最多 51 条', () => {
    const { pub, sent } = makePublisher({ intervalMs: 50 });
    for (let ms = 0; ms <= 10_000; ms += 50) {
      pub.publish(snap(ms));
      vi.advanceTimersByTime(50);
    }
    expect(sent.length).toBeLessThanOrEqual(51); // 10s / 200ms + 首帧
    expect(sent.length).toBeGreaterThan(40); // 钳制后仍按 5Hz 满速
  });
});

describe('N24 发布器反向与状态机', () => {
  it('连接失效不发；重连后由最新帧恢复', () => {
    const { pub, sent } = makePublisher();
    pub.publish(snap(1));
    pub.setConnected(false);
    expect(pub.publish(snap(2))).toEqual({ sent: false, reason: 'inactive' });
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1); // 断线期间零上报，trailing 也被丢弃
    pub.setConnected(true);
    expect(pub.publish(snap(3)).sent).toBe(true); // 重连后立即可发（窗口早已过）
    expect(sent).toHaveLength(2);
  });

  it('单机模式（active=false）不发', () => {
    const { pub, sent } = makePublisher();
    pub.setActive(false);
    expect(pub.publish(snap(1))).toEqual({ sent: false, reason: 'inactive' });
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(0);
  });

  it('非法快照拒绝且不发送、不污染去重基线', () => {
    const { pub, sent } = makePublisher();
    const broken = { ...snap(1), board: ['short'] } as unknown as SnapshotPayload;
    expect(pub.publish(broken)).toEqual({ sent: false, reason: 'invalid' });
    expect(sent).toHaveLength(0);
    expect(pub.publish(snap(1)).sent).toBe(true); // 基线未被非法输入吞掉
  });

  it('传输层拒绝（send=false）：回滚 pending，重连后自动重发同一帧', () => {
    const sent: string[] = [];
    let accept = false;
    const pub = new SnapshotPublisher({
      send: (text) => {
        if (!accept) return false;
        sent.push(text);
        return true;
      },
    });
    pub.setConnected(true);
    expect(pub.publish(snap(7))).toEqual({ sent: false, reason: 'transport_down' });
    expect(pub.hasPending).toBe(true);
    accept = true;
    pub.setConnected(true); // 重连：pending 挂回节流窗口
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(1);
    expect((JSON.parse(sent[0]) as SnapshotPayload).seq).toBe(7);
  });

  it('stop() 清定时器：停机后不再有任何发送', () => {
    const { pub, sent } = makePublisher();
    pub.publish(snap(1));
    pub.publish(snap(2)); // throttled，挂有 trailing
    pub.stop();
    expect(pub.hasPending).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
  });

  it('trailing 到期时若内容已与上一致则跳过（不多发重复帧）', () => {
    const { pub, sent } = makePublisher();
    pub.publish(snap(1)); // t0 发送 seq1
    pub.publish(snap(2)); // throttled pending seq2
    // 模拟另一路径已把 seq2 发出（如手动 flush 前重发）：直接再 publish 同内容
    vi.advanceTimersByTime(250); // trailing 发出 seq2
    expect(sent).toHaveLength(2);
    pub.publish(snap(2)); // 与上一致 → unchanged
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(2);
  });
});
