/**
 * N09：房间 Durable Object（SQLite-backed）。
 * 每个有效房间码映射一个 DO（`idFromName(roomCode)`）。占用/释放/代际更新在 DO 内
 * 原子完成（DO 单线程 + 同步 SQL，方法内无 await）；代际（generation）用于
 * 房间码复用隔离：释放后再占用 generation+1，旧代际凭据即刻失效（清单 N09 验收）。
 * 完整状态机/席位/闹钟属 N10–N21；禁止每房间常驻 setInterval（方案 §2.1）。
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import type { ClaimResult } from './room-store';

type RoomMetaRow = { generation: number; occupied: number };

export class RoomDO extends DurableObject<Env> {
  // SQLite DO 访问方式（本地 workerd 实测）：每次经 `this.ctx.storage.sql` 取用；
  // 构造器缓存句柄在驱逐后写入不可见。
  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /**
   * 惰性建表：房间元数据（单行）。occupied=0 表示空闲可占用；generation 为
   * 有效占用次数（每次占用 +1），用于复用隔离。N08 旧表补列（幂等）。
   */
  #ensureSchema(): void {
    const sql = this.#sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS room_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         generation INTEGER NOT NULL,
         created_at TEXT NOT NULL,
         occupied INTEGER NOT NULL DEFAULT 0
       );`,
    );
    try {
      sql.exec('ALTER TABLE room_meta ADD COLUMN occupied INTEGER NOT NULL DEFAULT 0');
    } catch {
      // 列已存在（N08 旧库）：幂等忽略。
    }
  }

  /** 确保元数据行存在（初始：generation=0、空闲）。 */
  #ensureRow(): void {
    this.#sql.exec(
      'INSERT OR IGNORE INTO room_meta (id, generation, created_at, occupied) VALUES (1, 0, ?, 0)',
      new Date().toISOString(),
    );
  }

  /**
   * 原子占用：空闲则 occupied=1 且 generation+1（返回新代际）；已占用则原样返回。
   * 注意（本地 workerd 实测陷阱）：不可用「SELECT `.next()` 判空再 INSERT」守卫——
   * 未耗尽游标会使后续写入对之后查询不可见；用 `INSERT OR IGNORE` 幂等插入。
   * 方法内无 await：DO 单线程保证与其他调用串行（清单 N09「DO 内原子完成」）。
   */
  tryClaim(): ClaimResult {
    this.#ensureSchema();
    this.#ensureRow();
    this.#sql.exec(
      'UPDATE room_meta SET occupied = 1, generation = generation + 1 WHERE id = 1 AND occupied = 0',
    );
    // changes() 判定本次 UPDATE 是否生效：已占用时 claimed=false（本次未占用成功）。
    const changed = this.#sql.exec<{ c: number }>('SELECT changes() AS c').one();
    const row = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    return { claimed: Number(changed.c) === 1, generation: Number(row.generation) };
  }

  /** 释放：occupied=0；代际保留，下次占用 +1（旧凭据失效依据）。 */
  release(): ClaimResult {
    this.#ensureSchema();
    this.#ensureRow();
    this.#sql.exec('UPDATE room_meta SET occupied = 0 WHERE id = 1');
    const row = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    return { claimed: false, generation: Number(row.generation) };
  }

  /** 凭据校验：仅当代际等于当前代际且房间处于占用态时有效（复用隔离）。 */
  verifyGeneration(generation: number): { valid: boolean; generation: number } {
    this.#ensureSchema();
    this.#ensureRow();
    const row = this.#sql
      .exec<RoomMetaRow>('SELECT generation, occupied FROM room_meta WHERE id = 1')
      .one();
    const current = Number(row.generation);
    return {
      valid: row.occupied === 1 && generation === current,
      generation: current,
    };
  }
}
