// N29：自动观战目标纯函数测试（验收：两人、六人、全同分、并列最高、淘汰者、
// 高低分轮换 ≥10 组；全部确定性断言，永不选本人）。
import { describe, expect, it } from 'vitest';
import { pickWatchTarget, type WatchCandidate } from '../src/watch-target';

function cand(playerId: string, score: number, lines: number, joinOrder: number): WatchCandidate {
  return { playerId, score, lines, joinOrder };
}

describe('N29 自动观战目标纯函数', () => {
  it('方案 §6.2 六人例：A/D→B（刚好更高）、E→C（最高选最低）、C→F', () => {
    // A=900、B=1400、C=300、D=900、E=2000、F=500（join 依字母序）。
    const roster = [
      cand('A', 900, 9, 1),
      cand('B', 1400, 14, 2),
      cand('C', 300, 3, 3),
      cand('D', 900, 9, 4),
      cand('E', 2000, 20, 5),
      cand('F', 500, 5, 6),
    ];
    expect(pickWatchTarget('A', roster)).toBe('B'); // 严格更高={B,E}→最低 B
    expect(pickWatchTarget('D', roster)).toBe('B'); // 同分 A 的目标一致（按分数非榜位）
    expect(pickWatchTarget('E', roster)).toBe('C'); // 最高 → 其他最低
    expect(pickWatchTarget('C', roster)).toBe('F'); // 刚好更高 = 500
    expect(pickWatchTarget('B', roster)).toBe('E'); // 唯一更高
    expect(pickWatchTarget('F', roster)).toBe('A'); // 更高={A,D(900 同分)}→消行同→join 升序 A
  });

  it('两人：高者看低者、低者看高者（互为目标）', () => {
    const roster = [cand('P', 100, 2, 1), cand('Q', 50, 1, 2)];
    expect(pickWatchTarget('P', roster)).toBe('Q');
    expect(pickWatchTarget('Q', roster)).toBe('P');
  });

  it('两人同分：并列最高 → 选其他最低（即对方），永不选自己', () => {
    const roster = [cand('P', 80, 1, 1), cand('Q', 80, 1, 2)];
    expect(pickWatchTarget('P', roster)).toBe('Q');
    expect(pickWatchTarget('Q', roster)).toBe('P');
  });

  it('六人全同分：各人选消行数最少者（并列 join 升序），无人选自己', () => {
    const roster = [
      cand('A', 700, 7, 1),
      cand('B', 700, 7, 2),
      cand('C', 700, 5, 3), // 全场最少消行
      cand('D', 700, 7, 4),
      cand('E', 700, 7, 5),
      cand('F', 700, 7, 6),
    ];
    for (const c of roster) {
      if (c.playerId === 'C') continue;
      const t = pickWatchTarget(c.playerId, roster);
      expect(t).toBe('C'); // 非 C 者都选消行最少的 C
      expect(t).not.toBe(c.playerId);
    }
    expect(pickWatchTarget('C', roster)).toBe('A'); // C 自己：消行并列 7 → join 升序 A
  });

  it('并列最高：最高分两人各选其他玩家最低分者', () => {
    const roster = [
      cand('X', 1000, 10, 1),
      cand('Y', 1000, 10, 2),
      cand('Z', 300, 3, 3),
      cand('W', 300, 3, 4),
    ];
    expect(pickWatchTarget('X', roster)).toBe('Z'); // 最低分并列→消行同→join 升序 Z
    expect(pickWatchTarget('Y', roster)).toBe('Z');
    expect(pickWatchTarget('Z', roster)).toBe('X'); // 更高={X,Y}→消行同→join 升序 X
  });

  it('淘汰者参与选择：淘汰高分者仍是目标；淘汰最低分者仍被最高者选中', () => {
    // 淘汰不改分数：dead(1500) 已淘汰但仍是「刚好更高」候选。
    const roster = [cand('me', 1000, 10, 1), cand('dead', 1500, 15, 2), cand('low', 200, 2, 3)];
    expect(pickWatchTarget('me', roster)).toBe('dead');
    expect(pickWatchTarget('low', roster)).toBe('me');
    expect(pickWatchTarget('dead', roster)).toBe('low'); // 淘汰者作观看者：选最低
  });

  it('刚好更高同分：消行数降序优先；消行同则 join 升序', () => {
    const roster = [
      cand('me', 500, 5, 1),
      cand('X', 900, 10, 2), // 消行多 → 胜
      cand('Y', 900, 12, 3), // 消行最多 → 最终胜
    ];
    expect(pickWatchTarget('me', roster)).toBe('Y');
    const roster2 = [cand('me', 500, 5, 1), cand('X', 900, 10, 3), cand('Y', 900, 10, 2)];
    expect(pickWatchTarget('me', roster2)).toBe('Y'); // 消行同 → join 升序（Y=2）
  });

  it('最低分并列（本人最高）：消行数升序优先；消行同则 join 升序', () => {
    const roster = [
      cand('me', 2000, 20, 1),
      cand('P', 300, 5, 2),
      cand('Q', 300, 4, 3), // 消行更少 → 胜
    ];
    expect(pickWatchTarget('me', roster)).toBe('Q');
    const roster2 = [cand('me', 2000, 20, 1), cand('P', 300, 4, 2), cand('Q', 300, 4, 3)];
    expect(pickWatchTarget('me', roster2)).toBe('P'); // 消行同 → join 升序
  });

  it('高低分轮换 12 组：分数逐刻变化，目标按规则即时重算且不为本人', () => {
    const ids = ['a', 'b', 'c', 'd'];
    // 每刻四人的 (score,lines)：join 固定 1..4。
    const timeline: [number, number][][] = [
      [[0, 0], [0, 0], [0, 0], [0, 0]], // 全 0：并列最高→消行同→join 升序（非己最小）
      [[100, 1], [0, 0], [0, 0], [0, 0]], // a 领先→看最低(join 升序 b)；b/c/d→看 a
      [[100, 1], [200, 2], [0, 0], [0, 0]], // a→b；b→最低 c；c/d→a(刚好更高 100)
      [[100, 1], [200, 2], [300, 3], [0, 0]], // c 最高→最低 d；a→b；b→c；d→a
      [[100, 1], [200, 2], [300, 3], [400, 4]], // d 最高→最低 a；c→d；b→c；a→b
      [[500, 5], [200, 2], [300, 3], [400, 4]], // a 最高→最低 b；b→c；c→d；d→a
      [[500, 5], [500, 5], [300, 3], [400, 4]], // a/b 并列最高→最低 c；c→刚好更高=d(400)；d→更高 a/b 同分消行同 join 升序 a
      [[500, 5], [500, 6], [300, 3], [400, 4]], // a/b 并列最高→最低 c；c→刚好更高=d(400)；d→更高={a,b} 同分消行降序→b
      [[500, 5], [500, 6], [500, 4], [400, 4]], // a/b/c 无更高→最低 d；d→更高同 500 消行降序 b
      [[600, 6], [500, 6], [500, 4], [400, 4]], // a 无更高→最低 d；b→更高={a}→a；c→更高={a}→a；d→更高最低 500 同分消行降序 b
      [[600, 6], [600, 6], [500, 4], [400, 4]], // a/b 并列最高→最低 d；c→更高 a/b 同分消行同 join 升序 a；d→c
      [[600, 6], [600, 6], [600, 6], [400, 4]], // a/b/c 并列最高→最低 d；d→更高同 600 消行同 join 升序 a
    ];
    const expectTable: string[][] = [
      ['b', 'a', 'a', 'a'],
      ['b', 'a', 'a', 'a'],
      ['b', 'c', 'a', 'a'],
      ['b', 'c', 'd', 'a'],
      ['b', 'c', 'd', 'a'],
      ['b', 'c', 'd', 'a'],
      ['c', 'c', 'd', 'a'],
      ['c', 'c', 'd', 'b'],
      ['d', 'd', 'd', 'b'],
      ['d', 'a', 'a', 'b'],
      ['d', 'd', 'a', 'c'],
      ['d', 'd', 'd', 'a'],
    ];
    expect(timeline.length).toBeGreaterThanOrEqual(10);
    timeline.forEach((snap, step) => {
      const roster = snap.map(([score, lines], i) => cand(ids[i], score, lines, i + 1));
      ids.forEach((id, i) => {
        const t = pickWatchTarget(id, roster);
        expect(t, `step ${step} viewer ${id}`).toBe(expectTable[step][i]);
        expect(t).not.toBe(id); // 恒不变式：永不选本人
      });
    });
  });

  it('输入顺序无关：任意乱序恒得同一目标；输入数组不被修改（纯函数）', () => {
    const roster = [
      cand('A', 900, 9, 1),
      cand('B', 1400, 14, 2),
      cand('C', 300, 3, 3),
      cand('D', 900, 9, 4),
    ];
    const snapshot = structuredClone(roster);
    const shuffled = [roster[2], roster[3], roster[0], roster[1]];
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(pickWatchTarget(id, shuffled)).toBe(pickWatchTarget(id, roster));
    }
    expect(roster).toEqual(snapshot); // 无副作用
  });

  it('负向：观看者不在名单/仅本人/空名单 → null；同分不算「更高」', () => {
    expect(pickWatchTarget('ghost', [cand('A', 1, 1, 1)])).toBeNull();
    expect(pickWatchTarget('A', [cand('A', 1, 1, 1)])).toBeNull();
    expect(pickWatchTarget('A', [])).toBeNull();
    // 同分不算更高：A=900 与 B=900，A 的「更高」集合为空 → 走最低分支仍选 B。
    const roster = [cand('A', 900, 9, 1), cand('B', 900, 9, 2)];
    expect(pickWatchTarget('A', roster)).toBe('B');
  });
});
