/**
 * N08：房间 Durable Object 骨架（SQLite-backed）。
 * 每个有效房间码映射一个 DO（`idFromName(roomCode)`）；本骨架只建立 SQLite
 * 元数据表与代际（generation）探针，验证绑定可实例化、存储可用。
 * 完整状态机/席位/闹钟属 N09–N21；禁止每房间常驻 setInterval（方案 §2.1）。
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

type RoomMetaRow = { generation: number };

export class RoomDO extends DurableObject<Env> {
  // SQLite DO 访问方式（本地 workerd 实测）：每次经 `this.ctx.storage.sql` 取用；
  // 构造器缓存句柄在驱逐后写入不可见。
  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** 惰性建表：房间元数据（单行），generation 用于房间码复用隔离（N09）。 */
  #ensureSchema(): void {
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS room_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         generation INTEGER NOT NULL,
         created_at TEXT NOT NULL
       );`,
    );
  }

  /**
   * N08 验收探针：确保元数据行存在并返回当前代际。
   * 同一 DO 重复调用幂等（generation 不变）；不同房间码的 DO 各自独立。
   * 注意（本地 workerd 实测陷阱）：不可用「SELECT .next() 判空再 INSERT」守卫——
   * 未耗尽的游标会使后续写入对之后查询不可见；用 `INSERT OR IGNORE` 幂等插入。
   */
  probe(code: string): RoomMetaRow & { code: string } {
    this.#ensureSchema();
    this.#sql.exec(
      'INSERT OR IGNORE INTO room_meta (id, generation, created_at) VALUES (1, 1, ?)',
      new Date().toISOString(),
    );
    const row = this.#sql
      .exec<RoomMetaRow>('SELECT generation FROM room_meta WHERE id = 1')
      .one();
    return { code, generation: Number(row.generation) };
  }
}
