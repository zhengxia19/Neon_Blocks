import { describe, expect, it } from 'vitest';
import { RepeatController } from '../../src/input/repeat';

describe('输入重复行为', () => {
  it('左右每次按下仅移动一格，持续按住也不重复', () => {
    const moved: number[] = [];
    const ctrl = new RepeatController({ move: (d) => moved.push(d), softDrop: () => {} });
    ctrl.pressDirection('left');
    ctrl.update(5000);
    expect(moved).toEqual([-1]);
    ctrl.releaseDirection('left');
    ctrl.pressDirection('right');
    ctrl.update(5000);
    expect(moved).toEqual([-1, 1]);
  });

  it('只有软降可以长按连续触发，松开立即停止', () => {
    let drops = 0;
    const ctrl = new RepeatController({ move: () => {}, softDrop: () => { drops += 1; } });
    ctrl.pressSoft();
    expect(drops).toBe(1);
    ctrl.update(105);
    expect(drops).toBeGreaterThan(1);
    ctrl.releaseSoft();
    const stopped = drops;
    ctrl.update(1000);
    expect(drops).toBe(stopped);
  });

  it('失焦释放软降按住状态', () => {
    let drops = 0;
    const ctrl = new RepeatController({ move: () => {}, softDrop: () => { drops += 1; } });
    ctrl.pressSoft();
    ctrl.releaseAll();
    ctrl.update(1000);
    expect(drops).toBe(1);
  });
});
