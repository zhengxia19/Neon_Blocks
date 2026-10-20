/**
 * N36：固定双棋盘响应式布局——结构与样式约束的源码级钉死断言。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = {
  layout: readFileSync(join(process.cwd(), 'src', 'ui', 'multiplayer-layout.ts'), 'utf8'),
  css: readFileSync(join(process.cwd(), 'src', 'styles', 'multiplayer.css'), 'utf8'),
  match: readFileSync(join(process.cwd(), 'src', 'app', 'match.ts'), 'utf8'),
  main: readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8'),
};

describe('N36 联网布局结构', () => {
  it('正向：复用 mountLayout + mp-mode 类 + 恰好新增 1 个 Canvas 与排行榜槽', () => {
    expect(SRC.layout).toContain('mountLayout(root)');
    expect(SRC.layout).toContain("root.classList.add('mp-mode')");
    // 只新增一个 canvas 元素（全页 = 单人 1 + 对手 1 = 严格 2）。
    expect(SRC.layout.split("el('canvas'").length - 1).toBe(1);
    expect(SRC.layout).toContain("id: 'opponent-canvas'");
    expect(SRC.layout).toContain("id: 'leaderboard-slot'");
    expect(SRC.layout).toContain("id: 'opponent-name'");
    expect(SRC.layout).toContain("id: 'opponent-score'");
    // 排行榜用原生 details：可折叠但一键展开全部玩家；手机断点默认折叠。
    expect(SRC.layout).toContain("el('details'");
    expect(SRC.layout).toContain("el('summary'");
    expect(SRC.layout).toContain("window.matchMedia('(max-width: 767.98px)')");
    expect(SRC.layout).toContain("details.removeAttribute('open')");
  });

  it('反向：不查询/不重建单人骨架、无网络代码', () => {
    expect(SRC.layout).not.toMatch(/fetch\(/);
    expect(SRC.layout).not.toContain('WebSocket');
    expect(SRC.layout).not.toContain('RemoteBoard');
    expect(SRC.layout).not.toContain('innerHTML');
  });
});

describe('N36 双棋盘样式约束', () => {
  it('正向：仅 .mp-mode 作用域；对手棋盘 180×360（本人 300×600 的 60%）', () => {
    expect(SRC.css).toContain('.mp-mode .playfield');
    expect(SRC.css).toContain('width: 180px');
    expect(SRC.css).toContain('height: 360px');
    // 手机断点：缩略条置顶整行、本人游戏区优先。
    expect(SRC.css).toContain('@media (max-width: 767.98px)');
    expect(SRC.css).toContain('order: -1');
    expect(SRC.css).toContain('grid-column: 1 / -1');
    // 触屏按键优先：mp 手机断点本人棋盘高度为触控区让位（首屏完整可见）。
    expect(SRC.css).toContain('max-height: calc(100vh - 440px)');
  });

  it('反向：单人选择器不受影响（无裸 .playfield 覆盖、无 !important）', () => {
    const bare = SRC.css.split('\n').filter((line) => /^\s*\.playfield\s*\{/.test(line));
    expect(bare).toHaveLength(0);
    expect(SRC.css).not.toContain('!important');
  });
});

describe('N36 装配接线', () => {
  it('正向：bootMatch 用双棋盘布局并接触屏按键与 resize', () => {
    expect(SRC.match).toContain('mountMultiplayerLayout(root)');
    expect(SRC.match).toContain('createTouchControls(refs.touchControls');
    expect(SRC.match).toContain('new RepeatController(');
    expect(SRC.match).toContain("window.addEventListener('resize', onResize)");
    expect(SRC.match).toContain('touch.dispose()');
  });

  it('正向：main.ts 引入 multiplayer.css；反向：单人 boot 仍用 mountLayout', () => {
    expect(SRC.main).toContain("import './styles/multiplayer.css'");
    expect(SRC.main).toContain('mountLayout(rootElement)');
    expect(SRC.main).not.toContain('mountMultiplayerLayout');
  });
});
