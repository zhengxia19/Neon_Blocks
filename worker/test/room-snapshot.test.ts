// N25：服务器侧快照校验、限流与背压——恶意 100Hz/1MiB/乱序不造成无界增长；
// 只认当前局 matchId 的未淘汰参赛者；seq 严格单调；出站单槽丢弃旧帧。
import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomRequest } from '../../shared/protocol';
import { RoomDO } from '../src/room';
import { makeFakeCtx, type FakeHibernatableSocket } from './stubs/sqlite-storage';

interface WsState {
  sent: string[];
  attachment: unknown;
  closed: { code: number; reason: string } | null;
  bufferedAmount: number;
}

function makeFakeWs(): { ws: WebSocket; state: WsState } {
  const state: WsState = { sent: [], attachment: null, closed: null, bufferedAmount: 0 };
  const ws: FakeHibernatableSocket = {
    send: (m: string) => state.sent.push(m),
    close: (code?: number, reason?: string) => {
      state.closed = { code: code ?? 1005, reason: reason ?? '' };
    },
    serializeAttachment: (a: unknown) => {
      state.attachment = a;
      return JSON.stringify(a);
    },
    deserializeAttachment: () => state.attachment,
    // N25：背压测试面——读取测试内可写的 state.bufferedAmount。
    get bufferedAmount() {
      return state.bufferedAmount;
    },
  };
  return { ws: ws as unknown as WebSocket, state };
}

const T0 = 1_700_000_000_000;
const EMPTY_BOARD = Array.from({ length: 24 }, () => '..........');

function snapPayload(seq: number) {
  return {
    seq,
    board: EMPTY_BOARD,
    active: null,
    score: 100 * seq,
    lines: seq,
    level: 1,
    status: 'running',
  };
}

function snapMsg(seq: number): string {
  return JSON.stringify({ v: 1, type: 'snapshot', seq, snapshot: snapPayload(seq) });
}

/** 就绪大厅 → 开局 → RUNNING，并为每个席位挂好 Hibernation 连接。 */
async function runningMatch(capacity: number) {
  vi.useFakeTimers({ now: T0 });
  const { ctx, store } = makeFakeCtx();
  const room = new RoomDO(ctx as never, {} as never);
  const request: CreateRoomRequest = {
    nickname: 'host1',
    capacity,
    randomMode: 'S1',
    startLevel: 1,
  };
  const created = await room.createRoom(request);
  if (!created.claimed) throw new Error('claim failed');
  const ids = [created.playerId];
  const tokens = new Map<string, string>([[created.playerId, created.seatToken]]);
  for (let i = 1; i < capacity; i += 1) {
    const joined = await room.joinRoom(`g${i}`);
    if (!joined.joined) throw new Error('join failed');
    ids.push(joined.playerId);
    tokens.set(joined.playerId, joined.seatToken);
  }
  for (const id of ids) room.setReady(id, true);
  const states = new Map<string, WsState>();
  const sockets = new Map<string, WebSocket>();
  for (const id of ids) {
    const { ws, state } = makeFakeWs();
    const issued = await room.issueTicket(id, tokens.get(id) as string);
    if (!issued.issued) throw new Error('ticket failed');
    await room.attachWebSocket(issued.ticket, ws);
    states.set(id, state);
    sockets.set(id, ws);
  }
  const res = room.startGame(created.playerId);
  if (!res.started) throw new Error(JSON.stringify(res));
  room.advanceToRunning(res.match.startAt);
  // 开局广播（countdown）不属于本任务断言面：清空出站记录。
  for (const st of states.values()) st.sent.length = 0;
  return {
    room,
    sql: store.sql,
    host: created.playerId,
    ids,
    states,
    sockets,
    matchId: res.match.matchId,
  };
}

function parsed(state: WsState): Record<string, unknown>[] {
  return state.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function connIdOf(state: WsState): string {
  return String((state.attachment as { connId: string }).connId);
}

describe('N25 快照入账与身份/局态校验', () => {
  it('RUNNING 快照入账：peek 携带服务器 matchId；SQLite 零新增写入', async () => {
    const { room, ids, sockets, sql, matchId } = await runningMatch(3);
    const countAll = (): number =>
      Number(
        [
          ...sql.exec(
            "SELECT (SELECT count(*) FROM seats) + (SELECT count(*) FROM seat_conns)" +
              " + (SELECT count(*) FROM match_roster) + (SELECT count(*) FROM match_state)" +
              " + (SELECT count(*) FROM eliminations) + (SELECT count(*) FROM ws_tickets) AS c",
          ),
        ][0].c,
      );
    const before = countAll();
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1));
    const slot = room.peekSnapshot(ids[1]);
    expect(slot).not.toBeNull();
    expect(slot?.seq).toBe(1);
    expect(slot?.matchId).toBe(matchId); // 服务器权威 matchId（非客户端声明）
    expect(JSON.parse(slot?.encoded as string).score).toBe(100);
    expect(countAll()).toBe(before); // 逐帧零 SQLite 写入
    vi.useRealTimers();
  });

  it('快照 seq 严格单调：陈旧/重复丢弃，前进接受', async () => {
    const { room, ids, sockets } = await runningMatch(2);
    const ws = sockets.get(ids[0]) as never;
    room.webSocketMessage(ws, snapMsg(5));
    expect(room.peekSnapshot(ids[0])?.seq).toBe(5);
    room.webSocketMessage(ws, snapMsg(3)); // 陈旧
    expect(room.peekSnapshot(ids[0])?.seq).toBe(5);
    room.webSocketMessage(ws, snapMsg(5)); // 重复
    expect(room.peekSnapshot(ids[0])?.seq).toBe(5);
    room.webSocketMessage(ws, snapMsg(6));
    expect(room.peekSnapshot(ids[0])?.seq).toBe(6);
    vi.useRealTimers();
  });

  it('信封 seq 陈旧整条丢弃（快照 seq 再新也不入账）', async () => {
    const { room, ids, sockets } = await runningMatch(2);
    const ws = sockets.get(ids[0]) as never;
    room.webSocketMessage(ws, snapMsg(5));
    room.webSocketMessage(ws, snapMsg(99)); // 信封 seq=99 接受
    // 信封 seq=4 回退（快照 seq=100 更新）→ 整条丢弃
    room.webSocketMessage(
      ws,
      JSON.stringify({ v: 1, type: 'snapshot', seq: 4, snapshot: snapPayload(100) }),
    );
    expect(room.peekSnapshot(ids[0])?.seq).toBe(99);
    vi.useRealTimers();
  });

  it('已淘汰 / 跨局残留快照不入账', async () => {
    const { room, host, ids, sockets, matchId } = await runningMatch(3);
    // 已淘汰：ids[1] 出局后其快照被拒
    room.reportElimination(ids[1], matchId, T0 + 60_000);
    room.webSocketMessage(sockets.get(ids[1]) as never, snapMsg(1));
    expect(room.peekSnapshot(ids[1])).toBeNull();
    // 跨局残留：终局 → nextRound → 再开局后旧 seq 不阻塞新局
    room.reportElimination(ids[2], matchId, T0 + 61_000);
    room.nextRound(host);
    for (const id of ids) room.setReady(id, true);
    const res = room.startGame(host);
    if (!res.started) throw new Error('restart failed');
    room.advanceToRunning(res.match.startAt);
    room.webSocketMessage(sockets.get(ids[0]) as never, snapMsg(1));
    expect(room.peekSnapshot(ids[0])?.seq).toBe(1);
    expect(room.peekSnapshot(ids[0])?.matchId).toBe(res.match.matchId);
    vi.useRealTimers();
  });

  it('gameover 接线：matchId 与淘汰时刻均由服务器供给；客户端带 matchId 字段被拒', async () => {
    const { room, ids, states, sockets, sql, matchId } = await runningMatch(2);
    vi.advanceTimersByTime(5_000);
    room.webSocketMessage(
      sockets.get(ids[1]) as never,
      JSON.stringify({ v: 1, type: 'gameover', seq: 1, reason: 'topout' }),
    );
    const rows = [
      ...sql.exec(
        'SELECT eliminated_at, match_id FROM eliminations WHERE player_id = ?',
        ids[1],
      ),
    ] as { eliminated_at: number; match_id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].match_id).toBe(matchId);
    expect(rows[0].eliminated_at).toBe(T0 + 5_000); // 服务端接收时刻
    // 负例：客户端指定 matchId（禁止字段）→ error 回复，不入淘汰表
    room.webSocketMessage(
      sockets.get(ids[0]) as never,
      JSON.stringify({ v: 1, type: 'gameover', seq: 1, reason: 'topout', matchId: 'm_fake' }),
    );
    const msgs = parsed(states.get(ids[0]) as WsState).filter((m) => m.type === 'error');
    expect(msgs[0]).toMatchObject({ type: 'error', code: 'FORBIDDEN_FIELD' });
    const rows0 = [...sql.exec('SELECT 1 AS n FROM eliminations WHERE player_id = ?', ids[0])];
    expect(rows0.length).toBe(0);
    vi.useRealTimers();
  });
});

describe('N25 恶意流量硬上限', () => {
  it('1MiB 报文：不进解析、不回复、不入账', async () => {
    const { room, ids, states, sockets } = await runningMatch(2);
    const st = states.get(ids[0]) as WsState;
    room.webSocketMessage(sockets.get(ids[0]) as never, 'x'.repeat(1_000_001));
    expect(st.sent.length).toBe(0);
    expect(room.peekSnapshot(ids[0])).toBeNull();
    expect(room.pipelineStats().snapshots).toBe(0);
    // 4KiB 原始字节口径：4096 个 UTF-16 单元（3 字节/单元 = 12,288 字节）严格拒绝。
    room.webSocketMessage(sockets.get(ids[0]) as never, 'あ'.repeat(4096));
    expect(st.sent.length).toBe(0);
    expect(st.closed).toBeNull();
    vi.useRealTimers();
  });

  it('二进制帧直接关闭（4003），不解析', async () => {
    const { room, ids, states, sockets } = await runningMatch(2);
    const st = states.get(ids[0]) as WsState;
    room.webSocketMessage(sockets.get(ids[0]) as never, new ArrayBuffer(64));
    expect(st.closed).toEqual({ code: 4003, reason: 'binary frame not allowed' });
    vi.useRealTimers();
  });

  it('100Hz 洪水：每秒至多 20 条入账，窗口滑过后恢复', async () => {
    const { room, ids, sockets } = await runningMatch(2);
    const ws = sockets.get(ids[0]) as never;
    for (let i = 1; i <= 100; i += 1) room.webSocketMessage(ws, snapMsg(i));
    expect(room.peekSnapshot(ids[0])?.seq).toBe(20); // 第 21 条起解析前丢弃
    vi.advanceTimersByTime(1001);
    room.webSocketMessage(ws, snapMsg(21));
    expect(room.peekSnapshot(ids[0])?.seq).toBe(21);
    vi.useRealTimers();
  });

  it('协议违规不放大：坏 JSON/禁止字段回复 error 且连接保持；版本不符关闭 1002', async () => {
    const { room, ids, states, sockets } = await runningMatch(2);
    const st = states.get(ids[0]) as WsState;
    const ws = sockets.get(ids[0]) as never;
    room.webSocketMessage(ws, '{oops');
    room.webSocketMessage(
      ws,
      JSON.stringify({ v: 1, type: 'snapshot', seq: 1, playerId: 'evil', snapshot: snapPayload(1) }),
    );
    const msgs = parsed(st);
    expect(msgs[0]).toMatchObject({ type: 'error', code: 'BAD_MESSAGE', retryable: true });
    expect(msgs[1]).toMatchObject({ type: 'error', code: 'FORBIDDEN_FIELD', retryable: false });
    expect(st.closed).toBeNull(); // 连接保持（协议违规不放大断连）
    // 冻结契约：版本不符先回 error(PROTOCOL_VERSION) 再 1002 关闭。
    room.webSocketMessage(ws, JSON.stringify({ v: 99, type: 'ping', seq: 1, clientTime: 1 }));
    const after = parsed(st);
    expect(after[2]).toMatchObject({ type: 'error', code: 'PROTOCOL_VERSION', retryable: false });
    expect(st.closed).toEqual({ code: 1002, reason: 'protocol version mismatch' });
    vi.useRealTimers();
  });

  it('6 人 × 100Hz × 60 秒：内存管线有界（快照≤6、连接≤6、背压槽≤6）', async () => {
    const { room, ids, sockets } = await runningMatch(6);
    for (let sec = 0; sec < 60; sec += 1) {
      for (let i = 0; i < 100; i += 1) {
        for (const id of ids) {
          room.webSocketMessage(sockets.get(id) as never, snapMsg(sec * 100 + i + 1));
        }
      }
      vi.advanceTimersByTime(1000);
    }
    const stats = room.pipelineStats();
    expect(stats.snapshots).toBeLessThanOrEqual(6);
    expect(stats.conns).toBeLessThanOrEqual(6);
    expect(stats.outSlots).toBeLessThanOrEqual(6);
    // N42：出站门控时戳表与槽补发定时器同样受连接数约束（活跃期非空 ⇒ 证明在用）。
    expect(stats.frameGateSize).toBeLessThanOrEqual(6);
    expect(stats.frameGateSize).toBeGreaterThan(0);
    expect(stats.slotTimerSize).toBeLessThanOrEqual(6);
    // 断线清理：全部 close 后连接态归零
    for (const id of ids) room.webSocketClose(sockets.get(id) as never, 1000, '', true);
    const after = room.pipelineStats();
    expect(after.conns).toBe(0);
    expect(after.outSlots).toBe(0);
    expect(after.frameGateSize).toBe(0); // N42：门控时戳随连接终结清理
    expect(after.slotTimerSize).toBe(0); // N42：补发定时器随连接终结清理
    vi.useRealTimers();
  });
});

describe('N25 出站背压（丢弃旧帧保留新帧）', () => {
  it('缓冲超限入单槽并覆盖；回落后补发最新槽帧', async () => {
    const { room, ids, states, sockets } = await runningMatch(2);
    const st = states.get(ids[0]) as WsState;
    const ws = sockets.get(ids[0]) as never;
    const connId = connIdOf(st);
    st.bufferedAmount = 20_000; // 超过 16KiB 阈值
    room.deliverFrame(connId, ws, 'frame-A');
    room.deliverFrame(connId, ws, 'frame-B'); // 覆盖：丢弃旧帧 A
    expect(st.sent.length).toBe(0);
    expect(room.pipelineStats().outSlots).toBe(1);
    st.bufferedAmount = 0;
    room.deliverFrame(connId, ws, 'frame-C');
    expect(st.sent).toEqual(['frame-B', 'frame-C']); // 先补发槽内最新，再发当前
    expect(room.pipelineStats().outSlots).toBe(0);
    vi.useRealTimers();
  });

  it('正常缓冲直发不排队', async () => {
    const { room, ids, states, sockets } = await runningMatch(2);
    const st = states.get(ids[0]) as WsState;
    room.deliverFrame(connIdOf(st), sockets.get(ids[0]) as never, 'frame-A');
    expect(st.sent).toEqual(['frame-A']);
    expect(room.pipelineStats().outSlots).toBe(0);
    vi.useRealTimers();
  });
});
