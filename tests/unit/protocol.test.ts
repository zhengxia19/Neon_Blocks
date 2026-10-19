import { describe, expect, it } from 'vitest';
import { BOARD_HEIGHT as GAME_BOARD_HEIGHT, BOARD_WIDTH as GAME_BOARD_WIDTH } from '../../src/game/constants';
import {
  ERROR_CATALOG,
  ERROR_CODES,
  describeError,
  isErrorCode,
} from '../../shared/errors';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  CLIENT_MESSAGE_TYPES,
  FORBIDDEN_CLIENT_FIELDS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  VERSION_CLOSE_CODE,
  decodeMessage,
  encodeMessage,
  isVersionSupported,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol';

const clientSamples: ClientMessage[] = [
  { v: 1, type: 'ready', seq: 1 },
  { v: 1, type: 'start', seq: 2 },
  { v: 1, type: 'settings_update', seq: 3, capacity: 4, randomMode: 'S3', customSeed: 'abc123', startLevel: 5 },
  {
    v: 1,
    type: 'snapshot',
    seq: 4,
    snapshot: {
      seq: 4,
      board: Array.from({ length: BOARD_HEIGHT }, () => '.'.repeat(BOARD_WIDTH)),
      active: { t: 'T', r: 1, x: 4, y: 5 },
      score: 1234,
      lines: 7,
      level: 2,
      status: 'running',
    },
  },
  { v: 1, type: 'gameover', seq: 5, reason: 'topout' },
  { v: 1, type: 'leave', seq: 6 },
  { v: 1, type: 'ping', seq: 7, clientTime: 1700000000000 },
];

const serverSamples: ServerMessage[] = [
  {
    v: 1,
    type: 'room_state',
    revision: 9,
    roomGeneration: 3,
    phase: 'LOBBY',
    roomCode: '123456',
    settings: { capacity: 4, randomMode: 'S1', startLevel: 1 },
    players: [
      {
        playerId: 's_1',
        nickname: 'alice',
        seatIndex: 1,
        isHost: true,
        ready: false,
        status: 'lobby',
        score: 0,
        lines: 0,
        level: 1,
      },
    ],
    matchId: null,
    startAt: null,
    deadlineAt: null,
    serverTime: 1700000000000,
  },
  {
    v: 1,
    type: 'player_joined',
    revision: 10,
    player: {
      playerId: 's_2',
      nickname: 'bob',
      seatIndex: 2,
      isHost: false,
      ready: false,
      status: 'lobby',
      score: 0,
      lines: 0,
      level: 1,
    },
  },
  { v: 1, type: 'player_left', revision: 11, playerId: 's_2', reason: 'left' },
  { v: 1, type: 'countdown', revision: 12, matchId: 'm_1', startAt: 1000, deadlineAt: 601000 },
  {
    v: 1,
    type: 'match_start',
    revision: 13,
    matchId: 'm_1',
    startAt: 1000,
    deadlineAt: 601000,
    rngAlgo: 'xorshift32-bag7-v1',
    seatSeed: 123456789,
    seatIndex: 2,
    startLevel: 3,
  },
  {
    v: 1,
    type: 'scoreboard',
    revision: 14,
    entries: [
      { playerId: 's_1', nickname: 'alice', score: 900, lines: 4, rank: 1, status: 'playing' },
      { playerId: 's_2', nickname: 'bob', score: 900, lines: 4, rank: 1, status: 'eliminated' },
    ],
  },
  { v: 1, type: 'watch_target', revision: 15, targetPlayerId: 's_1' },
  {
    v: 1,
    type: 'remote_snapshot',
    revision: 15,
    targetPlayerId: 's_1',
    snapshot: {
      seq: 88,
      board: Array.from({ length: BOARD_HEIGHT }, () => '.'.repeat(BOARD_WIDTH)),
      active: null,
      score: 900,
      lines: 4,
      level: 1,
      status: 'gameover',
    },
  },
  {
    v: 1,
    type: 'match_end',
    revision: 16,
    matchId: 'm_1',
    reason: 'survival',
    winners: ['s_1'],
    standings: [
      { playerId: 's_1', nickname: 'alice', score: 900, lines: 4, placement: 1, eliminatedAt: null },
      { playerId: 's_2', nickname: 'bob', score: 900, lines: 4, placement: null, eliminatedAt: 5000 },
    ],
  },
  { v: 1, type: 'error', revision: 17, code: 'NOT_HOST', message: '只有房主可以执行该操作。', retryable: false },
  { v: 1, type: 'pong', seq: 7, serverTime: 1700000000123 },
];

describe('N03 协议契约（shared/protocol.ts）', () => {
  it('正向：全部客户端/服务端消息可序列化并反序列化回等价对象', () => {
    for (const msg of [...clientSamples, ...serverSamples]) {
      const text = encodeMessage(msg);
      expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(decodeMessage(text)).toEqual(msg);
    }
  });

  it('正向：消息类型白名单与已批准方案 §7.2 完全一致', () => {
    expect([...CLIENT_MESSAGE_TYPES].sort()).toEqual(
      ['gameover', 'leave', 'ping', 'ready', 'settings_update', 'snapshot', 'start'].sort(),
    );
    expect([...SERVER_MESSAGE_TYPES].sort()).toEqual(
      [
        'countdown',
        'error',
        'match_end',
        'match_start',
        'player_joined',
        'player_left',
        'pong',
        'remote_snapshot',
        'room_state',
        'scoreboard',
        'watch_target',
      ].sort(),
    );
  });

  it('正向：版本判定只接受精确版本，前后端引用同一常量', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(isVersionSupported(PROTOCOL_VERSION)).toBe(true);
    expect(isVersionSupported(2)).toBe(false);
    expect(isVersionSupported('1')).toBe(false);
    expect(isVersionSupported(undefined)).toBe(false);
    expect(VERSION_CLOSE_CODE).toBe(1002);
  });

  it('反向：非法 JSON / 数组 / null 解析为 null，不抛未处理异常', () => {
    expect(decodeMessage('not json')).toBeNull();
    expect(decodeMessage('')).toBeNull();
    expect(decodeMessage('[1,2]')).toBeNull();
    expect(decodeMessage('null')).toBeNull();
    expect(decodeMessage('"str"')).toBeNull();
  });

  it('反向：未知消息类型不在白名单内（服务端应回 UNKNOWN_TYPE 并忽略）', () => {
    const unknown = decodeMessage('{"v":1,"type":"chat","text":"hi"}') as { type: string };
    expect((SERVER_MESSAGE_TYPES as readonly string[]).includes(unknown.type)).toBe(false);
    expect((CLIENT_MESSAGE_TYPES as readonly string[]).includes(unknown.type)).toBe(false);
  });

  it('反向：客户端消息禁止携带服务端权威字段', () => {
    const polluted = decodeMessage(
      '{"v":1,"type":"gameover","seq":9,"playerId":"s_1","winners":["s_1"],"eliminatedAt":123}',
    ) as Record<string, unknown>;
    const hits = Object.keys(polluted).filter((k) =>
      (FORBIDDEN_CLIENT_FIELDS as readonly string[]).includes(k),
    );
    expect(hits.sort()).toEqual(['eliminatedAt', 'playerId', 'winners']);
  });

  it('反向：协议版本错误的样本可被识别为不兼容', () => {
    const bad = decodeMessage('{"v":0,"type":"ready","seq":1}') as { v: number };
    expect(isVersionSupported(bad.v)).toBe(false);
  });

  it('shared 棋盘尺寸与 src/game/constants 一致', () => {
    expect(BOARD_WIDTH).toBe(GAME_BOARD_WIDTH);
    expect(BOARD_HEIGHT).toBe(GAME_BOARD_HEIGHT);
  });

  it('正向：错误目录完整且为中文提示', () => {
    for (const code of ERROR_CODES) {
      const entry = ERROR_CATALOG[code];
      expect(entry.message.length).toBeGreaterThan(0);
      expect(/[一-鿿]/.test(entry.message)).toBe(true);
      expect(typeof entry.retryable).toBe('boolean');
    }
    expect(describeError('ROOM_FULL')).toEqual(ERROR_CATALOG.ROOM_FULL);
  });

  it('反向：未知错误码判定失败并统一回退 INTERNAL，不泄露内部文本', () => {
    expect(isErrorCode('NOPE')).toBe(false);
    expect(isErrorCode('ROOM_FULL')).toBe(true);
    expect(describeError('NOPE')).toEqual(ERROR_CATALOG.INTERNAL);
    expect(PROTOCOL_ID).toBe('neon-blocks-mp');
  });
});
