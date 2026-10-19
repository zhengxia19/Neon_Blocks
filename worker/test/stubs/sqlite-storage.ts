// N11 测试桩：用 node:sqlite 模拟 workerd 的 SqlStorage（exec→游标 one/all）。
// 语义对齐：one() 恰好 1 行才返回，否则抛错（与 workerd 报错行为一致）。
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

class FakeCursor {
  private readonly rows: Row[];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  one(): Row {
    if (this.rows.length !== 1) {
      throw new Error(`Expected exactly one result from SQL query, but got ${this.rows.length} results.`);
    }
    return this.rows[0];
  }
  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]();
  }
}

export function makeSqlStorage(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  return {
    db,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const stmt = db.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH)/i.test(query);
        const rows = isReader ? stmt.all(...(bindings as never[])) : (stmt.run(...(bindings as never[])) && []);
        return new FakeCursor(rows as Row[]);
      },
    },
    close: () => db.close(),
  };
}

/** 最小 DO ctx：storage.sql + N14 Hibernation 面 + N17 Alarm 面（setAlarm/getAlarm）。 */
export interface FakeHibernationCtx {
  storage: {
    sql: ReturnType<typeof makeSqlStorage>['sql'];
    setAlarm(time: number | Date): void;
    getAlarm(): number | undefined;
  };
  acceptWebSocket(ws: FakeHibernatableSocket, attachment?: unknown): void;
  getWebSockets(): FakeHibernatableSocket[];
}

export interface FakeHibernatableSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): string;
  deserializeAttachment(): unknown;
}

export function makeFakeCtx(dbPath = ':memory:') {
  const store = makeSqlStorage(dbPath);
  const accepted: FakeHibernatableSocket[] = [];
  // N17：Alarm 语义对齐——单一待触发闹钟，setAlarm 覆盖，记录全部调用供断言。
  const alarmCalls: number[] = [];
  let alarmAt: number | undefined;
  const ctx: FakeHibernationCtx = {
    storage: {
      sql: store.sql,
      setAlarm(time) {
        const t = typeof time === 'number' ? time : time.getTime();
        alarmCalls.push(t);
        alarmAt = t;
      },
      getAlarm: () => alarmAt,
    },
    acceptWebSocket(ws, attachment) {
      accepted.push(ws);
      // 模拟平台接管；附件序列化由 DO 显式调用（与真实 API 一致）。
      if (attachment !== undefined) ws.serializeAttachment(attachment);
    },
    getWebSockets: () => accepted.slice(),
  };
  return { ctx, store, accepted, alarmCalls, getAlarmAt: () => alarmAt };
}
