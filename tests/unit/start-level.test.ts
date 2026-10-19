// N06：可配置起始等级（联网对局 startLevel 1–10；单机默认 1 行为完全不变）。
import { describe, expect, it } from 'vitest';
import { createEmptyBoard } from '../../src/game/board';
import { BOARD_WIDTH } from '../../src/game/constants';
import { GameEngine } from '../../src/game/engine';
import { gravityIntervalMs, levelForLines } from '../../src/game/scoring';
import type { Board } from '../../src/game/types';

/** 从 `fromRow` 起 `count` 行各预填 9/10 格（第 5 列缺口），供 I 竖降清行。 */
const gapRows = (fromRow: number, count: number): Board => {
  const src = createEmptyBoard();
  for (let y = fromRow; y < fromRow + count; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      if (x !== 5) src[y][x] = 'O';
    }
  }
  return src;
};

describe('N06 等级公式与起始等级', () => {
  it('正向：默认起始等级 1 时公式与旧行为完全一致', () => {
    expect([levelForLines(0), levelForLines(9), levelForLines(10), levelForLines(25)]).toEqual([1, 1, 2, 3]);
    const s = new GameEngine().getState();
    expect([s.level, new GameEngine().startLevel]).toEqual([1, 1]);
  });

  it('正向：startLevel=5/10 时 level = startLevel + floor(lines/10)', () => {
    // 5 + floor(25/10) = 7（floor(25/10)=2）
    expect([levelForLines(0, 5), levelForLines(9, 5), levelForLines(10, 5), levelForLines(25, 5)]).toEqual([5, 5, 6, 7]);
    expect([levelForLines(0, 10), levelForLines(20, 10), levelForLines(29, 10)]).toEqual([10, 12, 12]);
    for (const start of [1, 5, 10]) {
      expect(levelForLines(0, start)).toBe(start);
    }
  });

  it('正向：1/5/10 级重力下落表（含 11 级递推与 60ms 底线）', () => {
    expect([gravityIntervalMs(1), gravityIntervalMs(5), gravityIntervalMs(10)]).toEqual([900, 420, 170]);
    expect([gravityIntervalMs(11), gravityIntervalMs(30)]).toEqual([145, 60]);
  });

  it('正向：引擎按 startLevel 初始化并用对应重力表下落', () => {
    const e5 = new GameEngine(() => 0, undefined, 5);
    expect(e5.startLevel).toBe(5);
    e5.start();
    expect(e5.getState().level).toBe(5);
    expect(e5.getState().active?.y).toBe(2);
    // step 单步上限 MAX_STEP_MS=100（T028），须以 ≤100ms 步进累计到 420ms 间隔
    for (let k = 0; k < 4; k += 1) {
      e5.step(100); // 累计 100..400ms < 420ms：不下落
      expect(e5.getState().active?.y).toBe(2);
    }
    e5.step(20); // 累计恰 420ms：下落一行
    expect(e5.getState().active?.y).toBe(3);

    const e10 = new GameEngine(() => 0, undefined, 10);
    e10.start();
    expect(e10.getState().level).toBe(10);
    e10.step(100); // 170ms 间隔：100ms 不下落
    expect(e10.getState().active?.y).toBe(2);
    e10.step(70); // 累计恰 170ms：下落一行
    expect(e10.getState().active?.y).toBe(3);
  });

  it('正向：消行按清行前等级结算并升到 startLevel+1（12 行）', () => {
    // 与 engine.test.ts 同一确定性布局：rng=()=>0 使第 1/8/15 块均为 I，
    // 中间 6 块垃圾左右交替投放不产生消行。
    const engine = new GameEngine(() => 0, gapRows(8, 16), 5);
    engine.start();
    const dirs = [-1, 1, -1, 1, -1, 1];
    const moves = [3, 3, 3, 3, 3, 2];
    const iDrop = (): { delta: number; lines: number; level: number } => {
      const before = engine.getState().score;
      engine.rotate(1);
      engine.hardDrop();
      const t = engine.getState();
      return { delta: t.score - before, lines: t.lines, level: t.level };
    };
    let r = iDrop();
    expect([r.lines, r.level, r.delta]).toEqual([4, 5, 36 + 800 * 5]); // 清行前 level=5
    for (let k = 0; k < 6; k += 1) {
      for (let m = 0; m < moves[k]; m += 1) engine.move(dirs[k]);
      engine.hardDrop();
      expect(engine.getState().level).toBe(5);
    }
    r = iDrop();
    expect([r.lines, r.level, r.delta]).toEqual([8, 5, 36 + 800 * 5]);
    for (let k = 0; k < 6; k += 1) {
      for (let m = 0; m < moves[k]; m += 1) engine.move(dirs[k]);
      engine.hardDrop();
    }
    r = iDrop();
    expect([r.lines, r.level, r.delta]).toEqual([12, 6, 36 + 800 * 5]); // 12 行 → 5+1
  });

  it('正向：restart 保留起始等级（不回到 1）', () => {
    const engine = new GameEngine(() => 0, gapRows(20, 4), 7);
    engine.start();
    engine.rotate(1);
    engine.hardDrop();
    expect([engine.getState().lines, engine.getState().level]).toEqual([4, 7]);
    engine.restart();
    expect([engine.getState().lines, engine.getState().level, engine.getState().score]).toEqual([0, 7, 0]);
  });

  it('反向：非法起始等级显式拒绝（引擎与公式均校验）', () => {
    expect(() => new GameEngine(() => 0, undefined, 0)).toThrow(RangeError);
    expect(() => new GameEngine(() => 0, undefined, -3)).toThrow(RangeError);
    expect(() => new GameEngine(() => 0, undefined, 2.5)).toThrow(RangeError);
    expect(() => new GameEngine(() => 0, undefined, Number.NaN)).toThrow(RangeError);
    expect(() => levelForLines(0, 0)).toThrow(RangeError);
    expect(() => levelForLines(0, 1.5)).toThrow(RangeError);
    expect(() => levelForLines(-1, 5)).toThrow(RangeError);
  });

  it('反向：起始等级不影响旧默认调用签名（两参构造仍为 1 级）', () => {
    const engine = new GameEngine(() => 0, gapRows(20, 4));
    engine.start();
    engine.rotate(1);
    engine.hardDrop();
    const s = engine.getState();
    expect([s.score, s.lines, s.level]).toEqual([836, 4, 1]); // 与旧断言逐字一致
  });
});
