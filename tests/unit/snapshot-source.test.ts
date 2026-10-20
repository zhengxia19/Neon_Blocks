/**
 * N38：引擎状态 → 快照载荷（snapshot-source.ts 纯函数）。
 * 正向：board 编码（null→`.`、类型→首字母）、active 映射、统计照抄、seq 透传、
 * 与真实引擎状态经 encodeSnapshot/decodeSnapshot 往返一致。
 * 反向：ready/paused 一律上报 running（联网禁个人暂停）、gameover 唯一映射、
 * 输出恒过 N23 严格校验（非法形状不存在）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameEngine } from '../../src/game/engine';
import { createSeededRng } from '../../src/game/seeded-rng';
import type { GameStateView } from '../../src/game/engine';
import type { Cell, GameStatus, PieceType } from '../../src/game/types';
import { decodeSnapshot, encodeSnapshot } from '../../src/net/snapshot';
import { snapshotFromState } from '../../src/app/snapshot-source';

const EMPTY: Cell[][] = Array.from({ length: 24 }, () => Array<Cell>(10).fill(null));

function makeView(overrides: Partial<GameStateView> = {}): GameStateView {
  const base = {
    board: EMPTY.map((row) => [...row]),
    active: null,
    nextQueue: [] as PieceType[],
    bag: [] as PieceType[],
    heldType: null,
    holdUsedThisPiece: false,
    status: 'running' as GameStatus,
    score: 0,
    lines: 0,
    level: 1,
    gravityElapsedMs: 0,
    lockElapsedMs: 0,
    lockResetCount: 0,
    lastEvent: null,
  };
  return { ...base, ...overrides } as GameStateView;
}

describe('N38 snapshotFromState 正向', () => {
  it('board 编码：空格为 “.”，方块为类型首字母；24 行 × 10 字符', () => {
    const board = EMPTY.map((row) => [...row]);
    board[23][0] = 'T';
    board[23][1] = 'T';
    board[23][2] = 'T';
    board[22][1] = 'O';
    const snap = snapshotFromState(makeView({ board }), 7);
    expect(snap.board).toHaveLength(24);
    expect(snap.board[23]).toBe('TTT.......');
    expect(snap.board[22]).toBe('.O........');
    expect(snap.board[0]).toBe('..........');
    expect(snap.seq).toBe(7);
  });

  it('active 映射与统计照抄（score/lines/level 原样）', () => {
    const snap = snapshotFromState(
      makeView({
        active: { type: 'I', rotation: 1, x: 3, y: -2 },
        score: 4200,
        lines: 12,
        level: 5,
      }),
      1,
    );
    expect(snap.active).toEqual({ t: 'I', r: 1, x: 3, y: -2 });
    expect(snap.score).toBe(4200);
    expect(snap.lines).toBe(12);
    expect(snap.level).toBe(5);
  });

  it('真实引擎状态往返：encodeSnapshot → decodeSnapshot 与原状态一致', () => {
    const engine = new GameEngine(createSeededRng(42));
    engine.start();
    engine.rotate(1);
    engine.move(-1);
    engine.hardDrop();
    const state = engine.getState();
    const snap = snapshotFromState(state, 3);
    const text = encodeSnapshot(snap); // 不抛 = 通过 N23 严格校验与 4 KiB 硬门槛
    const decoded = decodeSnapshot(text);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.snapshot.seq).toBe(3);
    expect(decoded.snapshot.board).toEqual(state.board.map((row) => row.map((c) => c ?? '.').join('')));
    expect(decoded.snapshot.score).toBe(state.score);
    expect(decoded.snapshot.lines).toBe(state.lines);
    expect(decoded.snapshot.level).toBe(state.level);
    expect(decoded.snapshot.status).toBe('running');
  });
});

describe('N38 snapshotFromState 反向', () => {
  it('status 映射封闭：ready/paused 一律 running，仅 gameover 映射 gameover', () => {
    expect(snapshotFromState(makeView({ status: 'ready' }), 1).status).toBe('running');
    expect(snapshotFromState(makeView({ status: 'paused' }), 1).status).toBe('running');
    expect(snapshotFromState(makeView({ status: 'running' }), 1).status).toBe('running');
    expect(snapshotFromState(makeView({ status: 'gameover' }), 1).status).toBe('gameover');
  });

  it('开局前（active=null）与 gameover 状态照常发布，不产生非法载荷', () => {
    const before = snapshotFromState(makeView({ status: 'ready', active: null }), 1);
    expect(before.active).toBeNull();
    expect(decodeSnapshot(encodeSnapshot(before)).ok).toBe(true);
    const over = snapshotFromState(makeView({ status: 'gameover', score: 999 }), 2);
    expect(decodeSnapshot(encodeSnapshot(over)).ok).toBe(true);
  });

  it('纯函数边界：无网络/DOM/时钟源码', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'app', 'snapshot-source.ts'), 'utf8');
    expect(src).not.toMatch(/fetch\(|WebSocket|NetClient|SnapshotPublisher/);
    expect(src).not.toMatch(/document\.|window\.|Date\.now|Math\.random/);
  });
});
