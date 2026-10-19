// T022–T028：GameEngine 初始 ready 状态、NEXT 队列与出生、水平移动、顺逆旋转、软降、硬降锁块、自然重力测试（规格 S03.1–S03.5）。
import { describe, expect, it } from 'vitest';
import { canPlace, createEmptyBoard } from '../../src/game/board';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../src/game/constants';
import { GameEngine } from '../../src/game/engine';
import { BAG_TYPES } from '../../src/game/random';
import { tryRotate } from '../../src/game/srs';
import type { ActivePiece, Board } from '../../src/game/types';

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

/** 深快照：非法动作后逐字段比较完整状态（JSON 克隆，避免引用共享）。 */
function snapshot(engine: GameEngine): unknown {
  return JSON.parse(JSON.stringify(engine.getState()));
}

describe('GameEngine 水平移动（T024，S03.3）', () => {
  // rng=()=>0 确定性首块 I（r0 实体格占 x..x+3 共 4 列，出生 x=3）。
  const newRunning = (): GameEngine => {
    const engine = new GameEngine(() => 0);
    engine.start();
    return engine;
  };

  it('普通移动：move(1)/move(-1) 仅更改 x，type/rotation/y 与分数字段不变', () => {
    const engine = newRunning();
    const before = engine.getState();
    expect(before.active?.x).toBe(3);
    engine.move(1);
    const after = engine.getState();
    expect(after.active?.x).toBe(4);
    expect(after.active?.type).toBe(before.active?.type);
    expect(after.active?.rotation).toBe(before.active?.rotation);
    expect(after.active?.y).toBe(before.active?.y);
    // 移动本身不加分、不动计时器与队列
    expect(after.score).toBe(0);
    expect(after.gravityElapsedMs).toBe(0);
    expect(after.lockElapsedMs).toBe(0);
    expect(after.lastEvent).toBeNull();
    expect(after.nextQueue).toHaveLength(5);
    engine.move(-1);
    expect(engine.getState().active?.x).toBe(3);
  });

  it('贴左墙：I 从 x=3 左移 3 次至 x=0 后，move(-1) 无效且状态快照完全不变', () => {
    const engine = newRunning();
    for (let i = 0; i < 3; i += 1) {
      engine.move(-1);
    }
    expect(engine.getState().active?.x).toBe(0); // 实体列 0..3 贴左墙
    const before = snapshot(engine);
    engine.move(-1);
    expect(snapshot(engine)).toEqual(before); // 原子失败：x/一切字段不变
  });

  it('贴右墙：I 从 x=3 右移 3 次至 x=6（实体列 6..9）后，move(1) 无效且状态不变', () => {
    const engine = newRunning();
    for (let i = 0; i < 3; i += 1) {
      engine.move(1);
    }
    expect(engine.getState().active?.x).toBe(6);
    const before = snapshot(engine);
    engine.move(1);
    expect(snapshot(engine)).toEqual(before);
  });

  it('不可横向穿过锁定块：board[3][7] 预置锁定格挡住 I 右移一格', () => {
    const src = createEmptyBoard();
    src[3][7] = 'T'; // I 出生实体格为第 3 行 x=3..6，右移一格将占用 (7,3)
    const engine = new GameEngine(() => 0, src);
    engine.start();
    expect(engine.getState().status).toBe('running'); // 出生本身仍可放置
    const before = snapshot(engine);
    engine.move(1);
    expect(engine.getState().active?.x).toBe(3);
    expect(snapshot(engine)).toEqual(before);
    engine.move(-1); // 反方向无障碍，验证移动能力本身正常
    expect(engine.getState().active?.x).toBe(2);
  });

  it('ready 状态下 move 无效：状态快照与初态完全一致（active=null）', () => {
    const engine = new GameEngine(() => 0);
    const before = snapshot(engine);
    engine.move(1);
    engine.move(-1);
    expect(snapshot(engine)).toEqual(before);
    expect(engine.getState().active).toBeNull();
    expect(engine.getState().status).toBe('ready');
  });

  it('gameover 状态下 move 无效（active=null 时同样不改变状态）', () => {
    const src = createEmptyBoard();
    src[3][4] = 'T'; // 出生碰撞 → gameover
    const engine = new GameEngine(() => 0, src);
    engine.start();
    expect(engine.getState().status).toBe('gameover');
    const before = snapshot(engine);
    engine.move(1);
    engine.move(-1);
    expect(snapshot(engine)).toEqual(before);
  });
});

describe('GameEngine 顺逆旋转（T025，S03.3/S03.4）', () => {
  const newRunning = (rng: () => number = () => 0, board?: Board): GameEngine => {
    const engine = new GameEngine(rng, board);
    engine.start();
    return engine;
  };

  it('顺时针旋转：空盘中央 I r0 → r1（首偏移 (0,0) 成功，x/y 不变）', () => {
    const engine = newRunning();
    engine.rotate(1);
    const s = engine.getState();
    expect(s.active?.rotation).toBe(1);
    expect(s.active?.x).toBe(3);
    expect(s.active?.y).toBe(2);
    // 旋转本身不加分、不动队列/事件/计时器
    expect(s.score).toBe(0);
    expect(s.nextQueue).toHaveLength(5);
    expect(s.lastEvent).toBeNull();
    expect(s.gravityElapsedMs).toBe(0);
  });

  it('逆时针旋转：I r0 → r3，且连续 4 次旋转恢复 r0（循环 0→3→2→1→0）', () => {
    const engine = newRunning();
    engine.rotate(-1);
    expect(engine.getState().active?.rotation).toBe(3);
    engine.rotate(-1);
    expect(engine.getState().active?.rotation).toBe(2);
    engine.rotate(-1);
    expect(engine.getState().active?.rotation).toBe(1);
    engine.rotate(-1);
    const s = engine.getState();
    expect(s.active?.rotation).toBe(0);
    expect(s.active?.x).toBe(3); // 中央无踢墙位移，回到出生
    expect(s.active?.y).toBe(2);
  });

  it('引擎旋转结果与 srs.tryRotate 完全一致：空盘/墙边/锁定堆多场景逐一对比', () => {
    const scenarios: Array<{ board?: Board; moves: Array<'L' | 'R' | 'CW' | 'CCW'> }> = [
      { moves: ['CW', 'CW', 'CCW'] },
      { moves: ['L', 'L', 'L', 'CW', 'CW', 'R', 'CCW'] }, // 贴左墙 I 竖态 → 踢墙旋转
      { moves: ['R', 'R', 'R', 'CW', 'CCW', 'CW'] }, // 贴右墙场景
    ];
    for (const { board, moves } of scenarios) {
      const a = newRunning(() => 0, board);
      const b = newRunning(() => 0, board);
      for (const mv of moves) {
        // 引擎路径
        if (mv === 'L') a.move(-1);
        else if (mv === 'R') a.move(1);
        else if (mv === 'CW') a.rotate(1);
        else a.rotate(-1);
        // 独立参考路径：直接调 srs.tryRotate（引擎不得有第二套踢墙）
        const bs = b.getState();
        let ref = bs.active as ActivePiece;
        if (mv === 'L' || mv === 'R') {
          const cand: ActivePiece = { ...ref, x: ref.x + (mv === 'L' ? -1 : 1) };
          if (canPlace(bs.board as never, cand as never)) ref = cand;
        } else {
          ref = tryRotate(bs.board as never, ref, mv === 'CW' ? 1 : -1);
        }
        if (mv === 'L') b.move(-1);
        else if (mv === 'R') b.move(1);
        else if (mv === 'CW') b.rotate(1);
        else b.rotate(-1);
        expect(b.getState().active).toEqual(ref);
      }
      // 两引擎经不同调用路径得到完全相同的最终 active
      expect(a.getState().active).toEqual(b.getState().active);
    }
  });

  it('贴左墙踢墙生效：I 竖态 x=-2 逆转 1→0 经偏移 (2,0) 成功，x 变为 0', () => {
    const engine = newRunning();
    // I r1（实体列 x+2）：先在 r1 贴左墙。出生 r0 → 转 r1 → 左移到实体列 0（x=-2）
    engine.rotate(1);
    for (let i = 0; i < 5; i += 1) engine.move(-1);
    expect(engine.getState().active?.x).toBe(-2); // 列 -2+2=0 贴墙，再左移无效
    engine.move(-1);
    expect(engine.getState().active?.x).toBe(-2);
    engine.rotate(-1); // 1→0：偏移 (0,0) 会出界，应命中 (2,0)
    const s = engine.getState();
    expect(s.active?.rotation).toBe(0);
    expect(s.active?.x).toBe(0);
  });

  it('五偏移全失败：锁定块夹死 I 时旋转原子失败，深快照完全不变', () => {
    const src = createEmptyBoard();
    // I r0 出生占第 3 行 x=3..6；预置第 2 行与第 4 行整行锁定 → r1/r3 竖态在任何
    // 候选 y 必穿第 2 或第 4 行，五偏移全部失败
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      src[2][x] = 'O';
      src[4][x] = 'O';
    }
    const engine = newRunning(() => 0, src);
    expect(engine.getState().status).toBe('running'); // 出生行 3 未被占用
    const before = snapshot(engine);
    engine.rotate(1);
    expect(snapshot(engine)).toEqual(before);
    engine.rotate(-1);
    expect(snapshot(engine)).toEqual(before);
  });

  it('ready / gameover 状态下 rotate 无效（快照完全不变）', () => {
    const ready = new GameEngine(() => 0);
    const readyBefore = snapshot(ready);
    ready.rotate(1);
    ready.rotate(-1);
    expect(snapshot(ready)).toEqual(readyBefore);

    const src = createEmptyBoard();
    src[3][4] = 'T'; // 出生碰撞 → gameover（active=null）
    const over = newRunning(() => 0, src);
    expect(over.getState().status).toBe('gameover');
    const overBefore = snapshot(over);
    over.rotate(1);
    over.rotate(-1);
    expect(snapshot(over)).toEqual(overBefore);
  });
});
// ---------------------------------------------------------------------------
// T026：单次软降及每格加分（S03.3/S03.5）
// ---------------------------------------------------------------------------
describe('GameEngine 软降（T026，S03.3/S03.5）', () => {
  // rng=()=>0 确定性首块 I（r0 实体占行 y+3、列 x..x+3，出生 x=3/y=2）。
  const newRunning = (): GameEngine => {
    const engine = new GameEngine(() => 0);
    engine.start();
    return engine;
  };

  it('成功一次：y+1、score+1，其余字段（x/rotation/type/队列/计时器/事件）全部不变', () => {
    const engine = newRunning();
    const before = engine.getState();
    expect(before.active?.y).toBe(2);
    expect(before.score).toBe(0);
    engine.softDrop();
    const after = engine.getState();
    expect(after.active?.y).toBe(3);
    expect(after.score).toBe(1);
    // 仅 y 与 score 变化
    expect(after.active?.x).toBe(before.active?.x);
    expect(after.active?.rotation).toBe(before.active?.rotation);
    expect(after.active?.type).toBe(before.active?.type);
    expect(after.nextQueue).toEqual(before.nextQueue);
    expect(after.gravityElapsedMs).toBe(0);
    expect(after.lockElapsedMs).toBe(0);
    expect(after.lastEvent).toBeNull();
    expect(after.status).toBe('running');
  });

  it('连续软降：每次恰 +1 分 +1 格（软降分独立累计，无双重加分）', () => {
    const engine = newRunning();
    for (let i = 1; i <= 5; i += 1) {
      engine.softDrop();
      const s = engine.getState();
      expect(s.active?.y).toBe(2 + i);
      expect(s.score).toBe(i);
    }
  });

  it('触底：保持位置、分数不变、不锁定——active 仍在、棋盘未写入锁定格、status=running', () => {
    const engine = newRunning();
    // 空盘 I r0（实体行 y+3）贴底时 y=22（T019 getGhostY 已验证）：自 y=2 软降 20 次到 22
    for (let i = 0; i < 20; i += 1) {
      engine.softDrop();
    }
    let s = engine.getState();
    expect(s.active?.y).toBe(22);
    expect(s.score).toBe(20);
    const before = snapshot(engine);
    // 触底后再软降：完全原子失败，零变化（不锁定、不清除 active、不发事件）
    engine.softDrop();
    engine.softDrop();
    expect(snapshot(engine)).toEqual(before);
    s = engine.getState();
    expect(s.active).not.toBeNull();
    expect(s.status).toBe('running');
    for (const row of s.board) {
      for (const cell of row) {
        expect(cell).toBeNull(); // 未锁定：棋盘仍全空
      }
    }
  });

  it('ready 状态软降无效：快照完全不变、不加一分（paused 测试在 T031 补齐）', () => {
    const engine = new GameEngine(() => 0);
    const before = snapshot(engine);
    engine.softDrop();
    engine.softDrop();
    expect(snapshot(engine)).toEqual(before);
    expect(engine.getState().score).toBe(0);
  });

  it('gameover 状态（active=null）软降无效：分数保持、不再生效', () => {
    const src = createEmptyBoard();
    src[3][4] = 'T'; // 出生碰撞 → gameover
    const engine = new GameEngine(() => 0, src);
    engine.start();
    expect(engine.getState().status).toBe('gameover');
    const before = snapshot(engine);
    engine.softDrop();
    expect(snapshot(engine)).toEqual(before);
    expect(engine.getState().score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T027：硬降并立即锁块（S03.3/S03.5）
// ---------------------------------------------------------------------------
describe('GameEngine 硬降与锁块（T027，S03.3/S03.5）', () => {
  // rng=()=>0 确定性：首块 I（r0 实体行 y+1、列 x..x+3，出生 x=3/y=2），
  // 队列 ['L','J','Z','S','T']、袋 ['O']。
  const newRunning = (board?: Board): GameEngine => {
    const engine = new GameEngine(() => 0, board);
    engine.start();
    return engine;
  };

  it('空盘硬降：落差 20 → +40 分、I 立即锁入第 23 行 x=3..6、新块出生、hardDrop 事件 id=1', () => {
    const engine = newRunning();
    engine.hardDrop();
    const s = engine.getState();
    expect(s.score).toBe(40); // 落差 ghostY(22)−y(2)=20，每格 +2
    // 立即锁块：无需等待重力，锁定格已在棋盘
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      for (let y = 0; y < BOARD_HEIGHT - 1; y += 1) {
        expect(s.board[y][x]).toBeNull();
      }
    }
    for (const x of [3, 4, 5, 6]) {
      expect(s.board[23][x]).toBe('I');
    }
    // 旧块已锁、active 为新块（队列首 L 回补出生位置）
    expect(s.active).not.toBeNull();
    expect(s.active?.type).toBe('L');
    expect(s.active?.x).toBe(3);
    expect(s.active?.y).toBe(2);
    expect(s.active?.rotation).toBe(0);
    expect([...s.nextQueue]).toEqual(['J', 'Z', 'S', 'T', 'O']);
    expect(s.nextQueue).toHaveLength(5);
    // hardDrop 事件：id 自增、kind 正确、count=落差
    expect(s.lastEvent).toEqual({ id: 1, kind: 'hardDrop', count: 20 });
    expect(s.status).toBe('running');
    // 清行得分/行数/等级留待 T033 统一结算，本任务不得提前计入
    expect(s.lines).toBe(0);
    expect(s.level).toBe(1);
    // 新块计时基准复位
    expect(s.gravityElapsedMs).toBe(0);
    expect(s.lockElapsedMs).toBe(0);
    expect(s.lockResetCount).toBe(0);
  });

  it('落点即当前位（落差 0）：+0 分、事件 count=0、仍在原地锁定', () => {
    const engine = newRunning();
    // 先软降 20 格贴底（y=22，实体行 23），累计 20 分
    for (let i = 0; i < 20; i += 1) engine.softDrop();
    expect(engine.getState().active?.y).toBe(22);
    expect(engine.getState().score).toBe(20);
    engine.hardDrop();
    const s = engine.getState();
    expect(s.score).toBe(20); // 落差 0 → +0，软硬降分无重叠
    expect(s.lastEvent).toEqual({ id: 1, kind: 'hardDrop', count: 0 });
    for (const x of [3, 4, 5, 6]) {
      expect(s.board[23][x]).toBe('I'); // 原地锁定
    }
    expect(s.active?.type).toBe('L');
  });

  it('硬降清行：第 23 行两侧预填 6 格 + I 补 4 格 → 该行整体清除、棋盘恢复全空、清行分未提前计入', () => {
    const src = createEmptyBoard();
    for (const x of [0, 1, 2, 7, 8, 9]) src[23][x] = 'O';
    const engine = newRunning(src);
    engine.hardDrop();
    const s = engine.getState();
    // 第 23 行满 10 格被一次性清除，顶部补 null → 与空盘深相等
    expect(s.board).toEqual(createEmptyBoard());
    expect(s.score).toBe(40); // 仅硬降落差分；清行 100×level 在 T033 补齐
    expect(s.lines).toBe(0);
    expect(s.lastEvent).toEqual({ id: 1, kind: 'hardDrop', count: 20 });
    expect(s.active?.type).toBe('L');
    expect(s.status).toBe('running');
  });

  it('事件 id 单调递增：连续两次硬降 id 依次为 1、2', () => {
    const engine = newRunning();
    engine.hardDrop();
    expect(engine.getState().lastEvent?.id).toBe(1);
    engine.hardDrop();
    const s = engine.getState();
    expect(s.lastEvent?.id).toBe(2);
    expect(s.lastEvent?.kind).toBe('hardDrop');
  });

  it('ready / gameover 状态硬降无效：快照完全不变、不锁块不发事件', () => {
    const ready = new GameEngine(() => 0);
    const readyBefore = snapshot(ready);
    ready.hardDrop();
    expect(snapshot(ready)).toEqual(readyBefore);

    const src = createEmptyBoard();
    src[3][4] = 'T'; // 出生碰撞 → gameover
    const over = newRunning(src);
    expect(over.getState().status).toBe('gameover');
    const overBefore = snapshot(over);
    over.hardDrop();
    expect(snapshot(over)).toEqual(overBefore);
  });
});

// ---------------------------------------------------------------------------
// T028：基于 dt 的自然重力（S03.3）
// ---------------------------------------------------------------------------
describe('GameEngine 自然重力 step（T028，S03.3）', () => {
  // rng=()=>0：首块 I 出生 y=2；L1 间隔 900ms（与 GRAVITY_MS[0] 一致）。
  const newRunning = (): GameEngine => {
    const engine = new GameEngine(() => 0);
    engine.start();
    return engine;
  };

  it('900ms 首次下降：连续 100ms step，第 9 次前不降、第 9 次降 1 格且自然下落零加分', () => {
    const engine = newRunning();
    for (let i = 1; i <= 8; i += 1) {
      engine.step(100);
      expect(engine.getState().active?.y).toBe(2); // 累积 i×100 < 900 不降
      expect(engine.getState().gravityElapsedMs).toBeCloseTo(i * 100, 10);
    }
    engine.step(100); // 累积恰 900 → 降 1 格，余数清零
    const s = engine.getState();
    expect(s.active?.y).toBe(3);
    expect(s.gravityElapsedMs).toBeCloseTo(0, 10);
    // 自然重力不加分、不发事件、不动锁定计时（软降分与之分离）
    expect(s.score).toBe(0);
    expect(s.lastEvent).toBeNull();
    expect(s.lockElapsedMs).toBe(0);
  });

  it('单次 delta 上限 100ms：step(10000) 与 step(100) 等效，8 次不降第 9 次降', () => {
    const engine = newRunning();
    for (let i = 1; i <= 8; i += 1) {
      engine.step(10000); // 截断为 100
      expect(engine.getState().gravityElapsedMs).toBeCloseTo(i * 100, 10);
      expect(engine.getState().active?.y).toBe(2);
    }
    engine.step(10000);
    expect(engine.getState().active?.y).toBe(3);
  });

  it('非法 delta（NaN/负数/Infinity/非数字）一律按 0：状态完全不变', () => {
    const engine = newRunning();
    const before = snapshot(engine);
    for (const bad of [NaN, -50, Infinity, -Infinity, undefined as unknown as number]) {
      engine.step(bad);
    }
    expect(snapshot(engine)).toEqual(before);
    // 与正常 tick 混合：非法值不吞掉已有累积时间（正常路径照常推进）
    for (let i = 0; i < 9; i += 1) engine.step(100);
    expect(engine.getState().active?.y).toBe(3);
  });

  it('27 次 100ms 精确推进：y=2+3（900/1800/2700 各降 1 格）、score 恒 0', () => {
    const engine = newRunning();
    for (let i = 0; i < 27; i += 1) engine.step(100);
    const s = engine.getState();
    expect(s.active?.y).toBe(5);
    expect(s.gravityElapsedMs).toBeCloseTo(0, 10);
    expect(s.score).toBe(0);
  });

  it('ready 状态 step 不下降、不累积（快照完全不变；paused 测试在 T031 补齐）', () => {
    const engine = new GameEngine(() => 0);
    const before = snapshot(engine);
    for (let i = 0; i < 30; i += 1) engine.step(100);
    expect(snapshot(engine)).toEqual(before);
  });

  it('触底后持续 step：不下降、零加分、不崩溃；T029 锁定计时满 500ms 后锁定', () => {
    const engine = newRunning();
    // 软降至 y=22 贴底（I r0 实体行 23 已满）
    for (let i = 0; i < 20; i += 1) engine.softDrop();
    expect(engine.getState().active?.y).toBe(22);
    const scoreBefore = engine.getState().score;
    // T029 前契约：着地不立即锁定——400ms 时仍为原块且位置保持
    for (let i = 0; i < 4; i += 1) engine.step(100);
    expect(engine.getState().active?.y).toBe(22);
    expect(engine.getState().active?.type).toBe('I');
    expect(engine.getState().lockElapsedMs).toBeCloseTo(400, 10);
    // 累计 ≥500ms 后由 step 锁定（T029 接管锁定），此后不再下降、不加分、不崩溃
    for (let i = 0; i < 26; i += 1) engine.step(100);
    const s = engine.getState();
    expect(s.score).toBe(scoreBefore); // 锁定本身与重力均不加分（清行分留 T033）
    for (const x of [3, 4, 5, 6]) {
      expect(s.board[23][x]).toBe('I'); // 已锁定在棋盘
    }
    expect(s.active).not.toBeNull(); // 新块已生成，后续 step 正常推进
    expect(s.gravityElapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// T029：落地锁定延迟与限次重置（S03.3）
// ---------------------------------------------------------------------------
describe('GameEngine 锁定延迟（T029，S03.3）', () => {
  // rng=()=>0：首块 I（r0 实体行 y+1、列 x..x+3），次块 L、再次 J。
  const newRunning = (board?: Board): GameEngine => {
    const engine = new GameEngine(() => 0, board);
    engine.start();
    return engine;
  };

  /** 软降至贴底（空盘 I r0 → y=22）。 */
  const toBottom = (engine: GameEngine, times: number): void => {
    for (let i = 0; i < times; i += 1) engine.softDrop();
  };

  it('499ms 不锁、满 500ms 锁定：锁入棋盘、发 lock 事件（count=消行数）、生成新块并复位计时', () => {
    const engine = newRunning();
    toBottom(engine, 20);
    expect(engine.getState().active?.y).toBe(22);
    for (let i = 0; i < 4; i += 1) engine.step(100);
    engine.step(99); // 累计 499ms：不锁
    let s = engine.getState();
    expect(s.active?.type).toBe('I');
    expect(s.lockElapsedMs).toBeCloseTo(499, 10);
    engine.step(1); // 恰 500ms：锁定
    s = engine.getState();
    for (const x of [3, 4, 5, 6]) {
      expect(s.board[23][x]).toBe('I');
    }
    expect(s.active?.type).toBe('L'); // 新块出生
    expect(s.active?.y).toBe(2);
    expect(s.lastEvent).toEqual({ id: 1, kind: 'lock', count: 0 });
    expect(s.lockElapsedMs).toBe(0); // 新块计时复位
    expect(s.lockResetCount).toBe(0);
    expect(s.gravityElapsedMs).toBe(0);
    expect(s.score).toBe(20); // 仅软降分保留，锁定不加分
  });

  it('着地成功移动重置计时并消耗配额；失败移动不重置', () => {
    const engine = newRunning();
    toBottom(engine, 20);
    for (let i = 0; i < 4; i += 1) engine.step(100); // 累计 400ms
    expect(engine.getState().lockElapsedMs).toBeCloseTo(400, 10);
    engine.move(1); // x=4 着地成功 → 重置
    let s = engine.getState();
    expect(s.lockElapsedMs).toBe(0);
    expect(s.lockResetCount).toBe(1);
    for (let i = 0; i < 4; i += 1) engine.step(100); // 再累计 400ms
    engine.move(1); // x=5 成功 → 再重置
    s = engine.getState();
    expect(s.lockElapsedMs).toBe(0);
    expect(s.lockResetCount).toBe(2);
    for (let i = 0; i < 4; i += 1) engine.step(100); // 再累计 400ms
    engine.move(1); // x=6（贴右墙前最后一格）着地成功 → 重置、配额 3
    s = engine.getState();
    expect(s.active?.x).toBe(6);
    expect(s.lockElapsedMs).toBe(0);
    expect(s.lockResetCount).toBe(3);
    for (let i = 0; i < 4; i += 1) engine.step(100); // 再累计 400ms
    engine.move(1); // 贴墙失败：不重置、计时原样
    s = engine.getState();
    expect(s.active?.x).toBe(6);
    expect(s.lockElapsedMs).toBeCloseTo(400, 10); // 失败动作后计时原样
    expect(s.lockResetCount).toBe(3); // 仅 3 次成功各计 1
  });

  it('着地成功旋转同样消耗重置配额（L 贴底右转）', () => {
    const engine = newRunning();
    engine.hardDrop(); // I 立即锁定，L 出生（r0 实体最低行 y+2）
    expect(engine.getState().active?.type).toBe('L');
    toBottom(engine, 19); // L r0 贴底 y=21
    expect(engine.getState().active?.y).toBe(21);
    for (let i = 0; i < 3; i += 1) engine.step(100); // 累计 300ms
    engine.rotate(1); // r0→r1：实体行 y..y+1=21..22，可放置
    const s = engine.getState();
    expect(s.active?.rotation).toBe(1); // 旋转成功
    expect(s.lockElapsedMs).toBe(0); // 计时重置
    expect(s.lockResetCount).toBe(1); // 配额消耗 1
  });

  it('重置上限 15 次：第 16 次成功移动不再重置，计时继续累计至 500ms 锁定', () => {
    const engine = newRunning();
    toBottom(engine, 20);
    // 每轮：累计 100ms → 左右交替成功移动 → 重置并消耗配额
    for (let i = 1; i <= 15; i += 1) {
      engine.step(100);
      engine.move(i % 2 === 1 ? 1 : -1); // x 在 3/4 间往返，着地成功
      const s = engine.getState();
      expect(s.lockResetCount).toBe(i);
      expect(s.lockElapsedMs).toBe(0);
    }
    engine.step(100); // 第 16 轮：累计 100ms
    engine.move(1); // 成功但配额已尽：不重置
    let s = engine.getState();
    expect(s.lockResetCount).toBe(15); // 封顶不再增长
    expect(s.lockElapsedMs).toBeCloseTo(100, 10); // 计时保留
    for (let i = 0; i < 4; i += 1) engine.step(100); // 100+400=500ms
    s = engine.getState();
    // 往返后停在 x=4，最后一次成功移动（不重置）到 x=5 → 锁定列 5..8
    for (const x of [5, 6, 7, 8]) {
      expect(s.board[23][x]).toBe('I'); // 终锁定，无无限重置
    }
    expect(s.active?.type).toBe('L');
  });

  it('离地清零计时但保留重置次数；重落地重新计时并在 500ms 后锁定', () => {
    // 第 23 行预填 x=0,1,2,5：I 在 x=3..5 上方受 x=5 支撑停于 y=21；
    // 右移至 x=6 时第 23 行 x=6..9 全空 → 离地（预填 4 格 + I 4 格 = 8 格，不会清行，锁定格可检查）
    const src = createEmptyBoard();
    for (const x of [0, 1, 2, 5]) src[23][x] = 'O';
    const engine = newRunning(src);
    toBottom(engine, 19); // 软降至 y=21（第 23 行 x=5 挡住 y=22）
    expect(engine.getState().active?.y).toBe(21);
    for (let i = 0; i < 4; i += 1) engine.step(100); // 着地累计 400ms
    engine.move(1); // x=4：第 23 行 x=5 仍挡 → 着地，重置消耗 1
    for (let i = 0; i < 3; i += 1) engine.step(100);
    engine.move(1); // x=5：第 23 行 x=5 仍挡 → 着地，重置消耗 2
    for (let i = 0; i < 2; i += 1) engine.step(100);
    engine.move(1); // x=6：第 23 行 x=6..9 全空 → 离地
    let s = engine.getState();
    expect(s.active?.x).toBe(6);
    expect(s.lockElapsedMs).toBe(0); // 离地清零
    expect(s.lockResetCount).toBe(2); // 次数保留
    expect(canPlace(s.board as never, { ...s.active!, y: s.active!.y + 1 } as never)).toBe(true);
    // 重力落入空档至 y=22 后重新计时（本场景 gravityElapsedMs 已有存量，
    // 落地时刻不作精确断言），锁定必发生在重新着地再累计 ≥500ms 之后
    let locked = false;
    for (let i = 0; i < 20 && !locked; i += 1) {
      engine.step(100);
      locked = engine.getState().board[23][6] === 'I';
    }
    s = engine.getState();
    expect(s.board[23][6]).toBe('I'); // 最终锁定在空档
    for (const x of [6, 7, 8, 9]) {
      expect(s.board[23][x]).toBe('I');
    }
    expect(s.lastEvent).toEqual({ id: 1, kind: 'lock', count: 0 }); // 8 格不满行，count=0
    expect(s.active?.type).toBe('L'); // 新块已生成
  });

  it('自然锁定带清行：lock 事件 count=消行数 1，清行分/lines 留 T033 结算', () => {
    const src = createEmptyBoard();
    for (const x of [0, 1, 2, 7, 8, 9]) src[23][x] = 'O'; // 第 23 行留 x=3..6 缺口
    const engine = newRunning(src);
    toBottom(engine, 20); // I 落入缺口 y=22，着地
    for (let i = 0; i < 5; i += 1) engine.step(100); // 恰 500ms 锁定并清行
    const s = engine.getState();
    expect(s.board).toEqual(createEmptyBoard()); // 整行已清除
    expect(s.lastEvent).toEqual({ id: 1, kind: 'lock', count: 1 });
    expect(s.score).toBe(20); // 仅软降分，未提前计清行分
    expect(s.lines).toBe(0);
  });
});
