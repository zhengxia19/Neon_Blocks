import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type SnapshotPayload,
} from '../../shared/protocol';
import {
  utf8ByteLength,
  validateBoard,
  validateCapacity,
  validateClientMessage,
  validateCreateRoomRequest,
  validateCustomSeed,
  validateJoinRoomRequest,
  validateNickname,
  validateRandomMode,
  validateRoomCode,
  validateSeatToken,
  validateSnapshotPayload,
  validateStartLevel,
  validateTicket,
  withinMessageLimit,
  type Result,
} from '../../shared/validate';

function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

function expectCode(r: Result<unknown>, code: string): void {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
}

const validBoard = Array.from({ length: 24 }, (_, y) =>
  Array.from({ length: 10 }, (_, x) => (y === 23 && x < 4 ? 'I' : '.')).join(''),
);

const validSnapshot: SnapshotPayload = {
  seq: 42,
  board: validBoard,
  active: { t: 'T', r: 2, x: 4, y: 20 },
  score: 12345,
  lines: 12,
  level: 3,
  status: 'running',
};

describe('N04 协议运行时校验（shared/validate.ts）', () => {
  it('正向：昵称/房间码/容量/等级/模式边界内合法', () => {
    expect(expectOk(validateNickname('abcDEF123'))).toBe('abcDEF123');
    expect(expectOk(validateRoomCode('100000'))).toBe('100000');
    expect(expectOk(validateRoomCode('999999'))).toBe('999999');
    expect(expectOk(validateRoomCode(123456))).toBe('123456');
    for (const c of [2, 3, 4, 5, 6]) expect(expectOk(validateCapacity(c))).toBe(c);
    for (const l of [1, 5, 10]) expect(expectOk(validateStartLevel(l))).toBe(l);
    for (const m of ['S1', 'S2', 'S3']) expect(expectOk(validateRandomMode(m))).toBe(m);
  });

  it('反向：非法昵称/房间码/容量/等级/模式返回对应错误码', () => {
    expectCode(validateNickname(''), 'BAD_NICKNAME');
    expectCode(validateNickname('a'.repeat(17)), 'BAD_NICKNAME');
    expectCode(validateNickname('张三'), 'BAD_NICKNAME');
    expectCode(validateNickname('a-b_1'), 'BAD_NICKNAME');
    expectCode(validateNickname(123), 'BAD_NICKNAME');
    expectCode(validateRoomCode('099999'), 'BAD_ROOM_CODE');
    expectCode(validateRoomCode('12345'), 'BAD_ROOM_CODE');
    expectCode(validateRoomCode('abcdef'), 'BAD_ROOM_CODE');
    expectCode(validateRoomCode(1000000), 'BAD_ROOM_CODE');
    expectCode(validateCapacity(1), 'BAD_CAPACITY');
    expectCode(validateCapacity(7), 'BAD_CAPACITY');
    expectCode(validateCapacity(2.5), 'BAD_CAPACITY');
    expectCode(validateStartLevel(0), 'BAD_LEVEL');
    expectCode(validateStartLevel(11), 'BAD_LEVEL');
    expectCode(validateRandomMode('S4'), 'BAD_MODE');
  });

  it('正向：S3 必须带 1–32 位字母数字种子，S1/S2 必须不带', () => {
    expect(expectOk(validateCustomSeed('Ab9', 'S3'))).toBe('Ab9');
    expect(expectOk(validateCustomSeed('a'.repeat(32), 'S3'))).toBe('a'.repeat(32));
    expectCode(validateCustomSeed(undefined, 'S3'), 'BAD_SEED');
    expectCode(validateCustomSeed('a'.repeat(33), 'S3'), 'BAD_SEED');
    expectCode(validateCustomSeed('ab-c', 'S3'), 'BAD_SEED');
    expectCode(validateCustomSeed('abc', 'S1'), 'BAD_SEED');
    expect(expectOk(validateCustomSeed(undefined, 'S2'))).toBeUndefined();
  });

  it('正向：创建/加入请求合法组合通过，未知字段被丢弃', () => {
    const req = expectOk(
      validateCreateRoomRequest({
        nickname: 'alice',
        capacity: 4,
        randomMode: 'S3',
        customSeed: 'seed42',
        startLevel: 5,
        hackerField: 'x',
      }),
    );
    expect(req).toEqual({
      nickname: 'alice',
      capacity: 4,
      randomMode: 'S3',
      startLevel: 5,
      customSeed: 'seed42',
    });
    expect(Object.keys(req).sort()).toEqual(['capacity', 'customSeed', 'nickname', 'randomMode', 'startLevel']);
    expect(expectOk(validateJoinRoomRequest({ nickname: 'bob', extra: 1 }))).toEqual({ nickname: 'bob' });
  });

  it('反向：创建/加入请求非法参数返回 4xx 级错误码', () => {
    expectCode(validateCreateRoomRequest(null), 'BAD_MESSAGE');
    expectCode(validateCreateRoomRequest('nickname'), 'BAD_MESSAGE');
    expectCode(validateCreateRoomRequest({ nickname: 'ok', capacity: 9, randomMode: 'S1', startLevel: 1 }), 'BAD_CAPACITY');
    expectCode(validateCreateRoomRequest({ nickname: '', capacity: 4, randomMode: 'S1', startLevel: 1 }), 'BAD_NICKNAME');
    expectCode(validateJoinRoomRequest({}), 'BAD_NICKNAME');
  });

  it('正向/反向：席位令牌与一次性票据格式区分', () => {
    const token = 'A'.repeat(43);
    expect(expectOk(validateSeatToken(token))).toBe(token);
    expectCode(validateSeatToken('short'), 'UNAUTHORIZED');
    expectCode(validateSeatToken('a'.repeat(200)), 'UNAUTHORIZED');
    expectCode(validateSeatToken('has space'), 'UNAUTHORIZED');
    expect(expectOk(validateTicket('t'.repeat(22)))).toBeDefined();
    expectCode(validateTicket('short'), 'TOKEN_EXPIRED');
  });

  it('正向：24×10 棋盘与快照载荷合法', () => {
    expect(expectOk(validateBoard(validBoard))).toEqual(validBoard);
    const snap = expectOk(validateSnapshotPayload(validSnapshot));
    expect(snap).toEqual(validSnapshot);
    const noActive = expectOk(validateSnapshotPayload({ ...validSnapshot, active: null }));
    expect(noActive.active).toBeNull();
  });

  it('反向：棋盘行数/行长/非法字符/坐标越界/状态非法均拒绝', () => {
    expectCode(validateBoard(validBoard.slice(0, 23)), 'BAD_SNAPSHOT');
    expectCode(validateBoard([...validBoard.slice(0, 23), '123456789']), 'BAD_SNAPSHOT');
    expectCode(validateBoard([...validBoard.slice(0, 23), 'XXXXXXXXXX']), 'BAD_SNAPSHOT');
    expectCode(validateBoard([...validBoard.slice(0, 23), 1234567890 as unknown as string]), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, active: { t: 'T', r: 2, x: 99, y: 20 } }), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, active: { t: 'X', r: 0, x: 4, y: 4 } }), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, active: { t: 'T', r: 5, x: 4, y: 4 } }), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, status: 'paused' }), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, score: -1 }), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, level: 0 }), 'BAD_SNAPSHOT');
    expectCode(validateSnapshotPayload({ ...validSnapshot, seq: 1.5 }), 'BAD_SNAPSHOT');
    const stripped = expectOk(validateSnapshotPayload({ ...validSnapshot, injected: 'x' }));
    expect(Object.keys(stripped).sort()).toEqual(['active', 'board', 'level', 'lines', 'score', 'seq', 'status']);
  });

  it('正向：全部客户端消息类型严格校验通过并重建白名单对象', () => {
    expect(expectOk(validateClientMessage({ v: 1, type: 'ready', seq: 0 }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'ready',
      seq: 0,
    });
    expect(expectOk(validateClientMessage({ v: 1, type: 'leave', seq: 3, junk: 1 }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'leave',
      seq: 3,
    });
    const snap = expectOk(validateClientMessage({ v: 1, type: 'snapshot', seq: 7, snapshot: validSnapshot }));
    expect(snap.type).toBe('snapshot');
    const settings = expectOk(
      validateClientMessage({ v: 1, type: 'settings_update', seq: 8, capacity: 6, randomMode: 'S2', startLevel: 10 }),
    );
    expect(settings.type).toBe('settings_update');
    expect(expectOk(validateClientMessage({ v: 1, type: 'gameover', seq: 9, reason: 'voluntary' })).type).toBe('gameover');
    expect(expectOk(validateClientMessage({ v: 1, type: 'ping', seq: 10, clientTime: 1700 })).type).toBe('ping');
  });

  it('反向：版本错误/未知类型/服务端禁止字段/缺 seq 分别返回不同错误码', () => {
    expectCode(validateClientMessage({ v: 0, type: 'ready', seq: 1 }), 'PROTOCOL_VERSION');
    expectCode(validateClientMessage({ type: 'ready', seq: 1 }), 'PROTOCOL_VERSION');
    expectCode(validateClientMessage({ v: 1, type: 'chat', seq: 1 }), 'UNKNOWN_TYPE');
    expectCode(validateClientMessage({ v: 1, type: 'gameover', seq: 1, winners: ['s_1'] }), 'FORBIDDEN_FIELD');
    expectCode(validateClientMessage({ v: 1, type: 'snapshot', seq: 1, playerId: 's_1', snapshot: validSnapshot }), 'FORBIDDEN_FIELD');
    expectCode(validateClientMessage({ v: 1, type: 'ready' }), 'BAD_MESSAGE');
    expectCode(validateClientMessage({ v: 1, type: 'gameover', seq: 1, reason: 'cheat' }), 'BAD_MESSAGE');
    expectCode(validateClientMessage({ v: 1, type: 'ping', seq: 1, clientTime: Number.NaN }), 'BAD_MESSAGE');
  });

  it('反向：污染输入与畸形输入不抛未处理异常', () => {
    for (const bad of [undefined, null, 42, 'string', [], [{}], true]) {
      expect(() => validateClientMessage(bad)).not.toThrow();
      expectCode(validateClientMessage(bad), 'BAD_MESSAGE');
    }
    const polluted = JSON.parse('{"v":1,"type":"ready","seq":1,"__proto__":{"polluted":true}}');
    expect(expectOk(validateClientMessage(polluted))).toEqual({ v: 1, type: 'ready', seq: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('正向/反向：报文 UTF-8 字节上限 4KiB', () => {
    expect(utf8ByteLength('中文')).toBe(6);
    expect(MAX_MESSAGE_BYTES).toBe(4096);
    const text = JSON.stringify({ v: 1, type: 'snapshot', seq: 999, snapshot: validSnapshot });
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(withinMessageLimit(text)).toBe(true);
    expect(withinMessageLimit('x'.repeat(MAX_MESSAGE_BYTES))).toBe(true);
    expect(withinMessageLimit('x'.repeat(MAX_MESSAGE_BYTES + 1))).toBe(false);
    expect(withinMessageLimit('中'.repeat(2049))).toBe(false);
  });
});
