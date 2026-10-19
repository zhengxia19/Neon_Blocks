// Neon Blocks — WebAudio 合成短音效（规格 S08/S07，任务 T049）。
// 4 种短声：move(≈40ms 弱、节流)/rotate(≈65ms)/lock(≈85ms)/clear(≈150ms)，
// 峰值音量 < 0.1，oscillator + gain 合成，无任何音频素材。
// 默认静音；AudioContext 懒创建（仅启用后首次播放时实例化，S08「只能在用户
// 手势后创建」由装配层保证首次调用发生在手势回调内）。所有播放异常吞掉。
// 无持续音源——暂停/切后台不会有音频残留（S08）。

/** 音效种类（S08 四种）。 */
export type SoundKind = 'move' | 'rotate' | 'lock' | 'clear';

/** 每种音效的振荡器配方：频率（Hz）、时长（ms）、峰值增益、波形。 */
export interface VoiceProfile {
  waveform: OscillatorType;
  frequencyHz: number;
  /** 滑向的目标频率（无滑音时等于 frequencyHz）。 */
  targetHz: number;
  durationMs: number;
  peakGain: number; // 必须 < 0.1（S08 音量约束）
}

/** 四种短声的固定配方（频率/包络互异 → 开声后可分辨）。 */
export const VOICE_PROFILES: Readonly<Record<SoundKind, VoiceProfile>> = Object.freeze({
  move: Object.freeze({ waveform: 'triangle', frequencyHz: 240, targetHz: 240, durationMs: 40, peakGain: 0.035 }),
  rotate: Object.freeze({ waveform: 'square', frequencyHz: 420, targetHz: 560, durationMs: 65, peakGain: 0.05 }),
  lock: Object.freeze({ waveform: 'sine', frequencyHz: 180, targetHz: 90, durationMs: 85, peakGain: 0.08 }),
  clear: Object.freeze({ waveform: 'triangle', frequencyHz: 523, targetHz: 784, durationMs: 150, peakGain: 0.09 }),
});

/** move 音效节流窗口（长按移动不得每帧发声，S08；ARR=45ms 下仍再夹一道）。 */
export const MOVE_THROTTLE_MS = 50;

/** 与 AudioContext 结构兼容的最小接口（便于单测/浏览器桩注入）。 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  resume(): Promise<void> | void;
  suspend?: () => Promise<void> | void;
  close?: () => Promise<void> | void;
  createOscillator(): AudioNodeLike & { type: string; frequency: { value: number; setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void }; start(t?: number): void; stop(t?: number): void };
  createGain(): AudioNodeLike & { gain: { value: number; setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void } };
}

interface AudioNodeLike {
  connect<T>(destination: T): T;
}

export interface SoundManagerOptions {
  /** 初始启用状态（缺省 false：默认静音，S07/S08）。 */
  enabled?: boolean;
  /** AudioContext 工厂（缺省原生构造；测试注入桩）。 */
  contextFactory?: () => AudioContextLike;
  /** 时钟（缺省 performance.now；move 节流用）。 */
  now?: () => number;
}

/**
 * 音效管理器：setEnabled(false) 立即静音（挂起上下文，已发声尾音即停）；
 * setEnabled(true) 恢复。playSound 在未启用 / 无手势上下文异常时静默降级。
 */
export class SoundManager {
  #enabled: boolean;
  #ctx: AudioContextLike | null = null;
  #lastMoveAt = Number.NEGATIVE_INFINITY;
  readonly #contextFactory: () => AudioContextLike;
  readonly #now: () => number;

  constructor(options: SoundManagerOptions = {}) {
    this.#enabled = options.enabled ?? false;
    this.#contextFactory =
      options.contextFactory ??
      (() => {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: new () => AudioContextLike }).webkitAudioContext;
        return new Ctor();
      });
    this.#now = options.now ?? (() => performance.now());
  }

  /** AudioContext 是否已实例化（验收「未启用不实例化」的测试点读）。 */
  get contextCreated(): boolean {
    return this.#ctx !== null;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** 启用/关闭音效：关闭立即挂起上下文（静音即刻生效）；启用不预建上下文。 */
  setEnabled(value: boolean): void {
    this.#enabled = value;
    if (!value && this.#ctx !== null) {
      try {
        void this.#ctx.suspend?.();
      } catch {
        // 忽略挂起异常：静音语义已由 enabled 门保证。
      }
    }
  }

  /** 懒创建 AudioContext（首次启用播放时）。异常 → null（安全降级为静音）。 */
  #ensureContext(): AudioContextLike | null {
    if (this.#ctx !== null) {
      return this.#ctx;
    }
    try {
      this.#ctx = this.#contextFactory();
    } catch {
      return null; // AudioContext 不可用 → 全程静音降级
    }
    return this.#ctx;
  }

  /** 播放一种短声；未启用直接返回（不实例化上下文，S08 默认无声）。 */
  playSound(kind: SoundKind): void {
    if (!this.#enabled) {
      return;
    }
    if (kind === 'move') {
      const now = this.#now();
      if (now - this.#lastMoveAt < MOVE_THROTTLE_MS) {
        return; // 长按移动节流（S08：不得每帧发声）
      }
      this.#lastMoveAt = now;
    }
    const profile = VOICE_PROFILES[kind];
    try {
      const ctx = this.#ensureContext();
      if (ctx === null) {
        return;
      }
      if (ctx.state === 'suspended') {
        try {
          void ctx.resume();
        } catch {
          // resume 失败：本次静默。
        }
      }
      const t0 = ctx.currentTime;
      const duration = profile.durationMs / 1000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = profile.waveform;
      osc.frequency.setValueAtTime(profile.frequencyHz, t0);
      if (profile.targetHz !== profile.frequencyHz) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, profile.targetHz), t0 + duration);
      }
      // 短攻击 → 峰值 → 指数释放（峰值 < 0.1，S08）。
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(profile.peakGain, t0 + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.005);
    } catch {
      // 任何播放异常吞掉：音效绝不阻塞或中断游戏（S08）。
    }
  }

  /** 释放：关闭并丢弃 AudioContext；之后再 playSound 保持安静直至重新启用。 */
  dispose(): void {
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#enabled = false;
    try {
      void ctx?.close?.();
    } catch {
      // 忽略关闭异常。
    }
  }
}
