/**
 * N09：房间码分配（Worker 侧，无状态）。
 * 规则（方案 §1.1 / 清单 N09）：码由 Worker 用 crypto.getRandomValues 随机取值并重试；
 * 每个码映射固定 DO，占用/代际更新在该 DO 内原子完成；禁止客户端「先检查再提交」。
 */
import type { Env } from './index';

export const ROOM_CODE_MIN = 100000;
export const ROOM_CODE_MAX = 999999;
/** 候选冲突后的最大尝试次数；超出返回可控错误（码空间耗尽近似）。 */
export const MAX_CLAIM_ATTEMPTS = 8;

/** 均匀随机 6 位房间码（100000–999999）：拒绝采样消除取模偏置。 */
export function randomRoomCode(): string {
  const range = ROOM_CODE_MAX - ROOM_CODE_MIN + 1; // 900000
  const limit = Math.floor(0xffffffff / range) * range;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return String(ROOM_CODE_MIN + (value % range));
}

export interface ClaimResult {
  claimed: boolean;
  generation: number;
}

/** 可注入的最小 DO 命名空间面（单测用 fake，生产用 DurableObjectNamespace）。 */
export interface RoomNamespaceLike {
  idFromName(code: string): { toString(): string };
  get(id: unknown): { tryClaim(): Promise<ClaimResult> | ClaimResult };
}

export type Allocation =
  | { ok: true; code: string; id: string; generation: number }
  | { ok: false; error: 'ROOM_CODE_EXHAUSTED'; attempts: number };

/**
 * 随机取码 → 映射固定 DO → DO 内原子 tryClaim；冲突则重试，至多 maxAttempts 次。
 * 服务端裁决：客户端不先检查再提交（清单 N09）。
 */
export async function allocateRoomCode(
  ns: RoomNamespaceLike,
  maxAttempts: number = MAX_CLAIM_ATTEMPTS,
): Promise<Allocation> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = randomRoomCode();
    const id = ns.idFromName(code);
    const result = await ns.get(id).tryClaim();
    if (result.claimed) {
      return { ok: true, code, id: id.toString(), generation: result.generation };
    }
  }
  return { ok: false, error: 'ROOM_CODE_EXHAUSTED', attempts: maxAttempts };
}

export type RoomNamespace = Env['ROOM_DO'];
