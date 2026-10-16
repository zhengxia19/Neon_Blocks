// T022：GameEngine 初始 ready 状态测试（规格 S03.2,S03.3）。
import { describe, expect, it } from 'vitest';
import { createEmptyBoard } from '../../src/game/board';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../src/game/constants';
import { GameEngine } from '../../src/game/engine';

describe('GameEngine 初始状态（T022，S03.2/S03.3）', () => {
  it('默认构造：status=ready、active=null、队列/袋/Hold 空、分数 0、等级 1、计时器 0、无事件', () => {
    const s = new GameEngine().getState();
    expect(s.status).toBe('ready');
    expect(s.active).toBeNull();
    expect(s.nextQueue).toEqual([]);
    expect(s.bag).toEqual([]);
    expect(s.heldType).toBeNull();
    expect(s.holdUsedThisPiece).toBe(false);
    expect(s.score).toBe(0);
    expect(s.lines).toBe(0);
    expect(s.level).toBe(1);
    expect(s.gravityElapsedMs).toBe(0);
    expect(s.lockElapsedMs).toBe(0);
    expect(s.lockResetCount).toBe(0);
    expect(s.lastEvent).toBeNull();
  });

  it('默认棋盘为 24×10 全 null（与 createEmptyBoard 深相等）', () => {
    const s = new GameEngine().getState();
    expect(s.board).toHaveLength(BOARD_HEIGHT);
    for (const row of s.board) {
      expect(row).toHaveLength(BOARD_WIDTH);
      for (const cell of row) {
        expect(cell).toBeNull();
      }
    }
    expect(s.board).toEqual(createEmptyBoard());
  });

  it('initialBoard 注入：深相等且构造时深复制（源棋盘后续修改不影响引擎）', () => {
    const src = createEmptyBoard();
    src[23][0] = 'T';
    src[22][9] = 'I';
    const engine = new GameEngine(Math.random, src);
    expect(engine.getState().board).toEqual(src);
    src[23][0] = 'Z'; // 构造后改源
    src.push([]); // 源外层数组也改形
    const s = engine.getState();
    expect(s.board[23][0]).toBe('T'); // 引擎内不受源修改影响
    expect(s.board).toHaveLength(BOARD_HEIGHT);
    expect(s.board[0]).not.toBe(src[0]); // 行引用独立
  });

  it('两个引擎实例状态互相独立（board 与行引用均不共享）', () => {
    const a = new GameEngine();
    const b = new GameEngine();
    expect(a.getState().board).not.toBe(b.getState().board);
    expect(a.getState().board[0]).not.toBe(b.getState().board[0]);
    expect(a.getState().board).toEqual(b.getState().board);
  });

  it('rng 可注入：确定性函数被接受，初态与默认构造一致', () => {
    const s = new GameEngine(() => 0.42).getState();
    expect(s.status).toBe('ready');
    expect(s.board).toEqual(createEmptyBoard());
  });

  it('非法 rng 注入显式拒绝：非函数抛 TypeError（TS 类型无法约束 JS 调用方）', () => {
    for (const bad of ['nope', 42, null] as unknown as [() => number, () => number, () => number]) {
      expect(() => new GameEngine(bad)).toThrow(TypeError);
      expect(() => new GameEngine(bad)).toThrow(/rng 必须为函数/);
    }
  });

  it('getState 重复调用内容一致（同一引擎的稳定快照）', () => {
    const engine = new GameEngine();
    expect(engine.getState()).toEqual(engine.getState());
  });

  it('只读视图：嵌套数组与顶层属性在类型层面不可修改（编译期断言，运行时行为不受影响）', () => {
    const s = new GameEngine().getState();
    expect(s.status).toBe('ready');
    // 以下赋值/调用在 GameStateView 类型下均为编译错误（@ts-expect-error 若失效则 typecheck 失败）：
    // @ts-expect-error status 为 readonly 属性
    s.status = 'running';
    // @ts-expect-error board 为 readonly 数组，无 push
    s.board.push(createEmptyBoard()[0]);
    // @ts-expect-error 行数组同为 readonly
    s.board[23].push('T');
    // @ts-expect-error nextQueue 为 readonly 数组
    s.nextQueue.push('T');
    // @ts-expect-error bag 为 readonly 数组
    s.bag.push('I');
  });
});
