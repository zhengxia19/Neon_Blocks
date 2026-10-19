// T022/T023：GameEngine 初始 ready 状态、NEXT 队列补充与出生活动块测试（规格 S03.1,S03.2,S03.3）。
import { describe, expect, it } from 'vitest';
import { canPlace, createEmptyBoard } from '../../src/game/board';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../src/game/constants';
import { GameEngine } from '../../src/game/engine';
import { BAG_TYPES } from '../../src/game/random';

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

describe('GameEngine NEXT 队列与出生活动块（T023，S03.1/S03.2/S03.3）', () => {
  const VALID_TYPES = new Set<string>(BAG_TYPES);

  it('start()：ready→running，第一块在 x=3/y=2/r0 且与棋盘无碰撞', () => {
    const engine = new GameEngine();
    engine.start();
    const s = engine.getState();
    expect(s.status).toBe('running');
    expect(s.active).not.toBeNull();
    expect(s.active?.x).toBe(3);
    expect(s.active?.y).toBe(2);
    expect(s.active?.rotation).toBe(0);
    expect(VALID_TYPES.has(s.active?.type ?? '')).toBe(true);
    expect(canPlace(s.board as never, s.active ?? undefined as never)).toBe(true);
    // 活动块未锁入棋盘：除出生外棋盘保持空
    expect(s.board[23].every((c) => c === null)).toBe(true);
  });

  it('start() 后 nextQueue 始终为 5 且全部为合法方块类型', () => {
    const engine = new GameEngine();
    engine.start();
    const s = engine.getState();
    expect(s.nextQueue).toHaveLength(5);
    for (const t of s.nextQueue) {
      expect(VALID_TYPES.has(t)).toBe(true);
    }
    // 重复 start()（已 running）不改变队列长度
    engine.start();
    expect(engine.getState().nextQueue).toHaveLength(5);
  });

  it('首块确定性：注入 rng=()=>0 时首块/队列/袋与 Fisher–Yates 手工推演完全一致', () => {
    // shuffle(['I','O','T','S','Z','J','L'], ()=>0)：每次 j=0 交换 → ['O','T','S','Z','J','L','I']，
    // 从尾部弹出：I,L,J,Z,S → 队列 ['I','L','J','Z','S']；spawnNext shift I 后补 T → ['L','J','Z','S','T']，袋 ['O']。
    const engine = new GameEngine(() => 0);
    engine.start();
    const s = engine.getState();
    expect(s.active?.type).toBe('I');
    expect([...s.nextQueue]).toEqual(['L', 'J', 'Z', 'S', 'T']);
    expect([...s.bag]).toEqual(['O']);
  });

  it('首块确定性：同 rng 的两引擎首块与队列完全一致；rng=()=>0.5 推演值匹配', () => {
    const a = new GameEngine(() => 0.5);
    const b = new GameEngine(() => 0.5);
    a.start();
    b.start();
    expect(a.getState().active).toEqual(b.getState().active);
    expect([...a.getState().nextQueue]).toEqual([...b.getState().nextQueue]);
    // rng=()=>0.5：shuffle 推演袋 ['I','J','O','Z','T','L','S']，弹出 S,L,T,Z,O → 队列补 J → ['L','T','Z','O','J']，袋 ['I']
    expect(a.getState().active?.type).toBe('S');
    expect([...a.getState().nextQueue]).toEqual(['L', 'T', 'Z', 'O', 'J']);
    expect([...a.getState().bag]).toEqual(['I']);
  });

  it('start() 幂等：running 后再次 start() 不重新出生、不改变任何状态字段', () => {
    const engine = new GameEngine(() => 0);
    engine.start();
    const before = JSON.parse(JSON.stringify(engine.getState()));
    engine.start();
    expect(JSON.parse(JSON.stringify(engine.getState()))).toEqual(before);
  });

  it('出生碰撞：initialBoard 挡住出生格时 status=gameover、active=null', () => {
    // rng=()=>0 首块 I（r0 实体格为第 3 行 x=3..6）；在 board[3][4] 放锁定格制造入场碰撞
    const src = createEmptyBoard();
    src[3][4] = 'T';
    const engine = new GameEngine(() => 0, src);
    engine.start();
    const s = engine.getState();
    expect(s.status).toBe('gameover');
    expect(s.active).toBeNull();
    expect(s.board[3][4]).toBe('T'); // 棋盘未被改动
  });

  it('start() 不改变分数/行数/等级/Hold/事件，且 holdUsedThisPiece 为 false', () => {
    const engine = new GameEngine();
    engine.start();
    const s = engine.getState();
    expect(s.score).toBe(0);
    expect(s.lines).toBe(0);
    expect(s.level).toBe(1);
    expect(s.heldType).toBeNull();
    expect(s.holdUsedThisPiece).toBe(false);
    expect(s.lastEvent).toBeNull();
    expect(s.gravityElapsedMs).toBe(0);
    expect(s.lockElapsedMs).toBe(0);
    expect(s.lockResetCount).toBe(0);
  });
});
