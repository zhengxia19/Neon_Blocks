/**
 * N10：房间码分配（Worker 侧，无状态）。
 * 规则（方案 §1.1 / 清单 N09–N10）：码由 Worker 用 crypto.getRandomValues 随机取值并重试；
 * 每个码映射固定 DO，占用+配置+房主席位写入在该 DO 内原子完成（createRoom）；
 * 禁止客户端「先检查再提交」。
 */
import type { CreateRoomRequest } from '../../shared/protocol';
import type { Env } from './index';
import type { CreateClaim, JoinResult } from './room';

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

/** 可注入的最小 DO 命名空间面（单测用 fake，生产用 DurableObjectNamespace）。 */
export interface RoomNamespaceLike {
  idFromName(code: string): { toString(): string };
  get(id: unknown): {
    createRoom(req: CreateRoomRequest): Promise<CreateClaim>;
    joinRoom(nickname: string): Promise<JoinResult>;
  };
}

export type Allocation =
  | ({ ok: true; code: string; id: string } & Extract<CreateClaim, { claimed: true }>)
  | { ok: false; error: 'ROOM_CODE_EXHAUSTED'; attempts: number };

/**
 * 随机取码 → 映射固定 DO → DO 内原子 createRoom；候选被占用则换码重试，
 * 至多 maxAttempts 次后返回可控错误。服务端裁决（清单 N09/N10）。
 */
export async function allocateRoomCode(
  ns: RoomNamespaceLike,
  req: CreateRoomRequest,
  maxAttempts: number = MAX_CLAIM_ATTEMPTS,
): Promise<Allocation> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = randomRoomCode();
    const id = ns.idFromName(code);
    const claim = await ns.get(id).createRoom(req);
    if (claim.claimed) {
      return { ok: true, code, id: id.toString(), ...claim };
    }
  }
  return { ok: false, error: 'ROOM_CODE_EXHAUSTED', attempts: maxAttempts };
}

export type RoomNamespace = Env['ROOM_DO'];
