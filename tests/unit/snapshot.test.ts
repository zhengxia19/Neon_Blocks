// N23：棋盘快照紧凑编码——编解码一致、硬大小 ≤4 KiB、异常行数/格值立即拒绝。
import { describe, expect, it } from 'vitest';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  SNAPSHOT_MAX_BYTES,
  type SnapshotPayload,
} from '../../shared/protocol';
import {
  SnapshotError,
  decodeSnapshot,
  encodeSnapshot,
  utf8ByteLength,
  validateSnapshot,
} from '../../src/net/snapshot';

function emptyBoard(): string[] {
  return Array.from({ length: BOARD_HEIGHT }, () => '.'.repeat(BOARD_WIDTH));
}

function fullBoard(): string[] {
  const chars = 'IOTSZJL';
  return Array.from({ length: BOARD_HEIGHT }, (_, r) =>
    Array.from({ length: BOARD_WIDTH }, (_, c) => chars[(r + c) % chars.length]).join(''),
  );
}

const BASE: SnapshotPayload = {
  seq: 42,
  board: emptyBoard(),
  active: { t: 'T', r: 1, x: 4, y: 2 },
  score: 12345,
  lines: 7,
  level: 3,
  status: 'running',
};

describe('N23 快照编解码正向', () => {
  it('空棋盘/满棋盘/active=null 往返一致，且为紧凑 JSON 文本', () => {
    const cases: SnapshotPayload[] = [
      BASE,
      { ...BASE, board: fullBoard() },
      { ...BASE, active: null, status: 'gameover', seq: 0 },
    ];
    for (const s of cases) {
      const text = encodeSnapshot(s);
      expect(typeof text).toBe('string');
      expect(text.startsWith('{')).toBe(true); // JSON 文本，非图片/PNG 二进制
      const res = decodeSnapshot(text);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.snapshot).toEqual(s);
    }
  });

  it('硬大小：合法形状最坏编码远低于 4 KiB；键序固定无空白', () => {
    const worst = encodeSnapshot({ ...BASE, board: fullBoard(), score: 999_999_999, seq: 999_999 });
    expect(utf8ByteLength(worst)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(utf8ByteLength(worst)).toBeLessThan(600); // 24×10 字符棋盘 + 少量数字
    expect(worst).toContain('"seq":');
    expect(worst).not.toContain(' ');
  });

  it('解码接受合法出界坐标（出生区/踢墙），不静默改值', () => {
    const s = { ...BASE, active: { t: 'I' as const, r: 0 as const, x: -2, y: -1 } };
    const res = decodeSnapshot(encodeSnapshot(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.snapshot.active).toEqual(s.active);
  });
});

describe('N23 快照校验反向（立即拒绝）', () => {
  function mutate(patch: Record<string, unknown>): unknown {
    return { ...BASE, ...patch };
  }

  it('异常行数：23/25 行、非数组 → BAD_BOARD_ROWS', () => {
    expect(validateSnapshot(mutate({ board: emptyBoard().slice(0, 23) })).ok).toBe(false);
    expect((validateSnapshot(mutate({ board: emptyBoard().slice(0, 23) })) as { error: string }).error).toBe('BAD_BOARD_ROWS');
    expect((validateSnapshot(mutate({ board: [...emptyBoard(), '..........'] })) as { error: string }).error).toBe('BAD_BOARD_ROWS');
    expect((validateSnapshot(mutate({ board: 'not-array' })) as { error: string }).error).toBe('BAD_BOARD_ROWS');
  });

  it('异常行宽与非法格值 → BAD_BOARD_ROW', () => {
    const rows9 = emptyBoard(); rows9[0] = '.........';
    const rows11 = emptyBoard(); rows11[5] = '...........' ;
    const badChar = emptyBoard(); badChar[12] = '....X.....';
    const lower = emptyBoard(); lower[3] = '....i.....';
    const space = emptyBoard(); space[1] = '.... .....';
    for (const board of [rows9, rows11, badChar, lower, space]) {
      const res = validateSnapshot(mutate({ board }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('BAD_BOARD_ROW');
    }
  });

  it('active 非法：未知类型/旋转 4/越界坐标/多余字段 → BAD_ACTIVE', () => {
    const bads: unknown[] = [
      { t: 'Q', r: 0, x: 4, y: 2 },
      { t: 'T', r: 4, x: 4, y: 2 },
      { t: 'T', r: -1, x: 4, y: 2 },
      { t: 'T', r: 1, x: 99, y: 2 },
      { t: 'T', r: 1, x: 4, y: 2, extra: 1 },
      { t: 't', r: 1, x: 4, y: 2 },
      'active-string',
    ];
    for (const active of bads) {
      const res = validateSnapshot(mutate({ active }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('BAD_ACTIVE');
    }
  });

  it('标量非法：seq/score/lines/level 负数或小数、status 未知 → 对应错误码', () => {
    expect((validateSnapshot(mutate({ seq: -1 })) as { error: string }).error).toBe('BAD_SEQ');
    expect((validateSnapshot(mutate({ seq: 1.5 })) as { error: string }).error).toBe('BAD_SEQ');
    expect((validateSnapshot(mutate({ score: -5 })) as { error: string }).error).toBe('BAD_SCORE');
    expect((validateSnapshot(mutate({ lines: 2.5 })) as { error: string }).error).toBe('BAD_LINES');
    expect((validateSnapshot(mutate({ level: Number.NaN })) as { error: string }).error).toBe('BAD_LEVEL');
    expect((validateSnapshot(mutate({ status: 'paused' })) as { error: string }).error).toBe('BAD_STATUS');
  });

  it('形状非法：缺字段/多字段/数组/null → BAD_SHAPE', () => {
    const missing = { ...BASE } as Partial<SnapshotPayload>;
    delete missing.level;
    expect((validateSnapshot(missing) as { error: string }).error).toBe('BAD_SHAPE');
    expect((validateSnapshot({ ...BASE, extra: 1 }) as { error: string }).error).toBe('BAD_SHAPE');
    expect((validateSnapshot([]) as { error: string }).error).toBe('BAD_SHAPE');
    expect((validateSnapshot(null) as { error: string }).error).toBe('BAD_SHAPE');
  });

  it('解码：非法 JSON → BAD_JSON；>4 KiB 大包先于解析拒绝 → TOO_LARGE', () => {
    expect((decodeSnapshot('{oops') as { error: string }).error).toBe('BAD_JSON');
    expect((decodeSnapshot('null') as { error: string }).error).toBe('BAD_SHAPE');
    const huge = '{"seq":1,"pad":"' + 'x'.repeat(SNAPSHOT_MAX_BYTES) + '"}';
    expect(utf8ByteLength(huge)).toBeGreaterThan(SNAPSHOT_MAX_BYTES);
    expect((decodeSnapshot(huge) as { error: string }).error).toBe('TOO_LARGE');
  });

  it('边界探针：恰 4096B 过闸；坐标 x=13 收 / x=14 拒；多字节行拒绝', () => {
    // 恰好等于硬上限的合法 JSON（补齐到 4096B 后形状非法但大小过闸 → BAD_SHAPE）
    const padTarget = SNAPSHOT_MAX_BYTES;
    let pad = 0;
    let text = '';
    for (pad = 0; pad < 8192; pad += 1) {
      text = `{"seq":1,"pad":"${'y'.repeat(pad)}"}`;
      if (utf8ByteLength(text) === padTarget) break;
    }
    expect(utf8ByteLength(text)).toBe(padTarget);
    expect((decodeSnapshot(text) as { error: string }).error).toBe('BAD_SHAPE'); // 非 TOO_LARGE：恰 4096B 过大小闸
    // 坐标宽松超集边界：x=13（=W+3）收，x=14 拒
    expect(
      validateSnapshot(mutate({ active: { t: 'I', r: 0, x: BOARD_WIDTH + 3, y: 0 } })).ok,
    ).toBe(true);
    expect(
      (validateSnapshot(mutate({ active: { t: 'I', r: 0, x: BOARD_WIDTH + 4, y: 0 } })) as { error: string }).error,
    ).toBe('BAD_ACTIVE');
    // 多字节字符行：长度按 UTF-16 单元仍为 10 也会被格值白名单拒绝
    const cjk = emptyBoard();
    cjk[0] = '中.........';
    expect((validateSnapshot(mutate({ board: cjk })) as { error: string }).error).toBe('BAD_BOARD_ROW');
    const surrogate = emptyBoard();
    surrogate[1] = '\uD83D.........'; // 代理对首单元 + 9 个 '.'，长度 10
    expect((validateSnapshot(mutate({ board: surrogate })) as { error: string }).error).toBe('BAD_BOARD_ROW');
  });

  it('编码非法输入抛 SnapshotError（客户端边界防御）', () => {
    const broken = { ...BASE, board: emptyBoard().slice(0, 23) } as unknown as SnapshotPayload;
    expect(() => encodeSnapshot(broken)).toThrow(SnapshotError);
    try {
      encodeSnapshot(broken);
    } catch (e) {
      expect((e as SnapshotError).code).toBe('BAD_BOARD_ROWS');
    }
  });
});
