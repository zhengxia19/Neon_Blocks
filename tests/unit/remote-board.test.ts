/**
 * N35：独立远程棋盘——快照解码纯函数、重绘判定语义与装配结构断言。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldDraw, snapshotToView } from '../../src/ui/remote-board';
import type { SnapshotPayload } from '../../shared/protocol';

const SRC = {
  remote: readFileSync(join(process.cwd(), 'src', 'ui', 'remote-board.ts'), 'utf8'),
  renderer: readFileSync(join(process.cwd(), 'src', 'ui', 'renderer.ts'), 'utf8'),
};

function makeSnap(over: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    seq: 1,
    board: [
      ...new Array<string>(23).fill('..........'),
      'IOTTSZJLL.',
    ],
    active: { t: 'T', r: 2, x: 3, y: 5 },
    score: 1234,
    lines: 7,
    level: 2,
    status: 'running',
    ...over,
  };
}

describe('N35 快照解码（纯函数）', () => {
  it('正向：24 行 × 10 列、字母映射类型、. 为 null、活动块字段映射', () => {
    const view = snapshotToView(makeSnap());
    expect(view.board).toHaveLength(24);
    for (const row of view.board) expect(row).toHaveLength(10);
    expect(view.board[23].slice(0, 10)).toEqual([
      'I', 'O', 'T', 'T', 'S', 'Z', 'J', 'L', 'L', null,
    ]);
    expect(view.board[0]).toEqual(new Array(10).fill(null));
    expect(view.active).toEqual({ type: 'T', rotation: 2, x: 3, y: 5 });
    expect(view.score).toBe(1234);
    expect(view.lines).toBe(7);
    expect(view.level).toBe(2);
    expect(view.status).toBe('running');
  });

  it('正向：active=null 与 gameover 状态直通', () => {
    const view = snapshotToView(makeSnap({ active: null, status: 'gameover' }));
    expect(view.active).toBeNull();
    expect(view.status).toBe('gameover');
  });

  it('反向：未知字符按空处理（服务端已先行校验，客户端不炸帧）', () => {
    const view = snapshotToView(makeSnap({ board: [...new Array<string>(23).fill('..........'), 'X?.1#abcde'] }));
    expect(view.board[23][0]).toBeNull(); // X
    expect(view.board[23][2]).toBeNull(); // ?
    expect(view.board[23][4]).toBeNull(); // #
    expect(view.board[23][5]).toBeNull(); // a（小写不是类型首字母）
  });
});

describe('N35 重绘判定语义', () => {
  it('正向：首帧 -1→0 绘制；严格递增才重绘', () => {
    expect(shouldDraw(-1, 0, false)).toBe(true);
    expect(shouldDraw(0, 1, false)).toBe(true);
    expect(shouldDraw(9, 10, false)).toBe(true);
  });

  it('反向：同 seq、乱序旧帧、冻结后一律不重绘', () => {
    expect(shouldDraw(5, 5, false)).toBe(false);
    expect(shouldDraw(5, 4, false)).toBe(false);
    expect(shouldDraw(5, 6, true)).toBe(false);
    expect(shouldDraw(-1, 0, true)).toBe(false);
  });
});

describe('N35 装配结构断言', () => {
  it('正向：复用 BoardRenderer 视觉一致；关闭 Ghost、不接特效层', () => {
    expect(SRC.remote).toContain("import { BoardRenderer } from './renderer'");
    expect(SRC.remote).toContain('ghostEnabled: false');
    expect(SRC.remote).not.toContain('effects');
    expect(SRC.renderer).toContain('overlayNotice(text: string)');
    expect(SRC.remote).toContain("overlayNotice('同步中断')");
  });

  it('正向（复审 P2-1）：resetForTarget 复位水位/解冻/清断线但不重绘（切换目标不闪白）', () => {
    const m = SRC.remote.match(/resetForTarget\(\): void \{([\s\S]*?)\n  \}/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('this.#lastSeq = -1');
    expect(m![1]).toContain('this.#frozen = false');
    expect(m![1]).toContain('this.#disconnected = false');
    expect(m![1]).not.toContain('render('); // 不清 Canvas：旧帧保留至新目标首帧
  });

  it('正向（复审 P2-2）：resize 透传后重绘最后画面并在断线态重贴遮罩', () => {
    const m = SRC.remote.match(/resize\(\): void \{([\s\S]*?)\n  \}/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('this.#renderer.resize()');
    expect(m![1]).toContain('this.#lastView !== null');
    expect(m![1]).toContain("overlayNotice('同步中断')");
    // applySnapshot 缓存最后视图供 resize 重绘
    expect(SRC.remote).toContain('this.#lastView = view;');
  });

  it('反向：无远程引擎/音效/网络/自驱动画循环', () => {
    expect(SRC.remote).not.toContain('GameEngine');
    expect(SRC.remote).not.toContain('SoundManager');
    expect(SRC.remote).not.toMatch(/fetch\(/);
    expect(SRC.remote).not.toContain('WebSocket');
    expect(SRC.remote).not.toContain('requestAnimationFrame');
    expect(SRC.remote).not.toContain('setInterval');
  });
});
