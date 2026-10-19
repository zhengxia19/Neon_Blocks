/**
 * N23：棋盘快照紧凑编码/解码（前端与 Worker 共用语义；本文件仅依赖 shared 协议）。
 *
 * 设计：
 * - 紧凑 JSON 文本（固定键序、无空白），禁止图片/Canvas PNG 传输；
 * - 严格包含且仅包含：`seq`、`board`（24 行 × 每行 10 字符）、`active`、
 *   `score`、`lines`、`level`、`status`——缺字段、多字段一律拒绝；
 * - 硬大小：序列化后 UTF-8 字节 ≤ `SNAPSHOT_MAX_BYTES`（4 KiB）。合法形状
 *   的最大编码约 0.5 KiB，硬上限对**解码输入**生效（先于 JSON 解析拒绝大包）；
 * - 异常行数、行宽、非法格值、非法旋转/坐标立即拒绝（不静默修正）。
 */
import {
  BOARD_CELL_CHARS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  SNAPSHOT_MAX_BYTES,
  type ActivePieceSnapshot,
  type SnapshotPayload,
  type SnapshotStatus,
} from '../../shared/protocol';

export type SnapshotErrorCode =
  | 'BAD_JSON'
  | 'BAD_SHAPE'
  | 'BAD_SEQ'
  | 'BAD_BOARD_ROWS'
  | 'BAD_BOARD_ROW'
  | 'BAD_ACTIVE'
  | 'BAD_SCORE'
  | 'BAD_LINES'
  | 'BAD_LEVEL'
  | 'BAD_STATUS'
  | 'TOO_LARGE';

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode) {
    super(code);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

export type SnapshotDecodeResult =
  | { ok: true; snapshot: SnapshotPayload }
  | { ok: false; error: SnapshotErrorCode };

const SNAPSHOT_KEYS: readonly (keyof SnapshotPayload)[] = [
  'seq',
  'board',
  'active',
  'score',
  'lines',
  'level',
  'status',
];
const ACTIVE_KEYS: readonly (keyof ActivePieceSnapshot)[] = ['t', 'r', 'x', 'y'];
const CELL_CHARS = new Set<string>(BOARD_CELL_CHARS);
const PIECE_CHARS = new Set<string>(BOARD_CELL_CHARS.filter((c) => c !== '.'));
const STATUSES = new Set<string>(['running', 'gameover']);

const textEncoder = new TextEncoder();

/** UTF-8 字节长度（大小硬门槛用；浏览器/Node/workerd 均可用）。 */
export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** 严格结构校验：任何偏差立即拒绝（错误码定位问题面）。 */
export function validateSnapshot(value: unknown): SnapshotDecodeResult {
  if (!isPlainObject(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    return { ok: false, error: 'BAD_SHAPE' };
  }
  if (!isUint(value.seq)) return { ok: false, error: 'BAD_SEQ' };
  const board = value.board;
  if (!Array.isArray(board) || board.length !== BOARD_HEIGHT) {
    return { ok: false, error: 'BAD_BOARD_ROWS' };
  }
  for (const row of board) {
    if (typeof row !== 'string' || row.length !== BOARD_WIDTH) {
      return { ok: false, error: 'BAD_BOARD_ROW' };
    }
    for (const ch of row) {
      if (!CELL_CHARS.has(ch)) return { ok: false, error: 'BAD_BOARD_ROW' };
    }
  }
  const active = value.active;
  let activeOut: ActivePieceSnapshot | null = null;
  if (active !== null) {
    if (!isPlainObject(active) || !hasExactKeys(active, ACTIVE_KEYS)) {
      return { ok: false, error: 'BAD_ACTIVE' };
    }
    if (typeof active.t !== 'string' || !PIECE_CHARS.has(active.t)) {
      return { ok: false, error: 'BAD_ACTIVE' };
    }
    if (!isIntInRange(active.r, 0, 3)) return { ok: false, error: 'BAD_ACTIVE' };
    // 坐标校验域是引擎可达锚点域（⊂[-3,9]×[-3,23]，见 src/game/board.ts
    // canPlace 钳制）的有意宽松超集：不拒任何合法状态，同时挡住异常大值。
    if (!isIntInRange(active.x, -4, BOARD_WIDTH + 3)) return { ok: false, error: 'BAD_ACTIVE' };
    if (!isIntInRange(active.y, -4, BOARD_HEIGHT + 3)) return { ok: false, error: 'BAD_ACTIVE' };
    activeOut = {
      t: active.t as ActivePieceSnapshot['t'],
      r: active.r as ActivePieceSnapshot['r'],
      x: active.x,
      y: active.y,
    };
  }
  if (!isUint(value.score)) return { ok: false, error: 'BAD_SCORE' };
  if (!isUint(value.lines)) return { ok: false, error: 'BAD_LINES' };
  if (!isUint(value.level)) return { ok: false, error: 'BAD_LEVEL' };
  if (typeof value.status !== 'string' || !STATUSES.has(value.status)) {
    return { ok: false, error: 'BAD_STATUS' };
  }
  return {
    ok: true,
    snapshot: {
      seq: value.seq,
      board: [...board] as string[],
      active: activeOut,
      score: value.score,
      lines: value.lines,
      level: value.level,
      status: value.status as SnapshotStatus,
    },
  };
}

/**
 * 编码为紧凑 JSON（固定键序）。运行时再校验一次（客户端边界防御）；
 * 非法输入抛 `SnapshotError`。合法形状编码恒 ≤4 KiB（结构性保证），
 * 仍保留硬门槛以显式兑现验收。
 */
export function encodeSnapshot(snapshot: SnapshotPayload): string {
  const checked = validateSnapshot(snapshot);
  if (!checked.ok) throw new SnapshotError(checked.error);
  const s = checked.snapshot;
  const active =
    s.active === null
      ? 'null'
      : `{"t":"${s.active.t}","r":${s.active.r},"x":${s.active.x},"y":${s.active.y}}`;
  const text =
    `{"seq":${s.seq},"board":[${s.board.map((r) => JSON.stringify(r)).join(',')}]` +
    `,"active":${active},"score":${s.score},"lines":${s.lines},"level":${s.level}` +
    `,"status":"${s.status}"}`;
  if (utf8ByteLength(text) > SNAPSHOT_MAX_BYTES) throw new SnapshotError('TOO_LARGE');
  return text;
}

/** 解码并严格校验；先按字节硬门槛拒绝大包，再解析。永不抛异常。 */
export function decodeSnapshot(raw: string): SnapshotDecodeResult {
  if (utf8ByteLength(raw) > SNAPSHOT_MAX_BYTES) return { ok: false, error: 'TOO_LARGE' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'BAD_JSON' };
  }
  return validateSnapshot(parsed);
}
