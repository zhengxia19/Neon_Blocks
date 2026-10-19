// Neon Blocks — 静态页面骨架（规格 S04.3，任务 T035）。
// 布局仅在启动时由 mountLayout() 构建一次；后续渲染循环（T053 起）只更新文本与
// Canvas，绝不重建 DOM。暴露的元素引用供 hud.ts(T042/T043)、overlays.ts(T044)、
// touch.ts(T047)、main.ts 装配(T053)挂载使用。

/** 一次性构建后的全部可变区域元素引用（后续任务按此挂载，不再 querySelector 猜测）。 */
export interface LayoutRefs {
  /** 顶部品牌标题（移动端仍可见，文本可缩短）。 */
  brand: HTMLElement;
  /** 主棋盘 Canvas：名义 CSS 300×600（单元格 30px），高清内部分辨率由 T038 重设。 */
  boardCanvas: HTMLCanvasElement;
  /** HOLD 预览挂载点（T042 填充 4×4 CSS 小格或空槽占位）。 */
  holdPreview: HTMLElement;
  /** NEXT 三枚预览槽（桌面 3 枚；移动端 CSS 隐藏第 3 枚，逻辑仍预存 5 块）。 */
  nextSlots: HTMLElement[];
  /** 状态读数（T043 仅在数值变化时更新 textContent）。 */
  scoreValue: HTMLElement;
  bestValue: HTMLElement;
  levelValue: HTMLElement;
  linesValue: HTMLElement;
  /** 移动端 <768px 顶栏压缩读数（与侧栏同源数值，CSS 切换显示）。 */
  miniScore: HTMLElement;
  miniLevel: HTMLElement;
  /** 顶部操作按钮（均为 type=button 且带 aria-label，S04.3 无障碍要求）。 */
  pauseButton: HTMLButtonElement;
  soundButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  /** 棋盘面板内的覆盖层挂载点：READY/PAUSED/GAMEOVER/设置为 role=dialog（T044/T048）。 */
  overlayRoot: HTMLElement;
  /** 移动端虚拟按钮容器（T047 渲染 7 按键；桌面 CSS 隐藏）。 */
  touchControls: HTMLElement;
}

interface BuildOptions {
  id?: string;
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  parent?: HTMLElement;
}

/** 创建元素的统一小助手：一次构建、属性即刻完整，避免后续补挂造成的布局抖动。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  { id, className, text, attrs, parent }: BuildOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (id !== undefined) node.id = id;
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs !== undefined) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  if (parent !== undefined) parent.appendChild(node);
  return node;
}

/** 侧栏统计块：小节标题 + 读数容器（T043 写入数值）。 */
function statBlock(parent: HTMLElement, title: string, valueId: string, initial: string): HTMLElement {
  const section = el('div', { className: 'stat-block', parent });
  el('h2', { className: 'stat-title', text: title, parent: section });
  return el('div', { className: 'stat-value', id: valueId, text: initial, parent: section, attrs: { 'aria-live': 'off' } });
}

/**
 * 在 root 内构建语义化骨架：header（品牌+模式+操作按钮）/ main（三栏：HOLD+分数｜
 * 棋盘 Canvas｜NEXT+等级+行数）/ footer（键盘说明）/ 移动虚拟键容器。
 * 返回值供后续模块挂载；重复调用会清空 root 以保证幂等（仅测试/热更新场景）。
 */
export function mountLayout(root: HTMLElement): LayoutRefs {
  root.textContent = '';

  // ── 顶部：品牌、模式描述、暂停/声音/设置 ────────────────────────────────
  const header = el('header', { className: 'site-header', parent: root });
  const brand = el('h1', { className: 'brand', id: 'brand-title', parent: header });
  el('span', { className: 'brand-glyph', text: '◇', attrs: { 'aria-hidden': 'true' }, parent: brand });
  el('span', { className: 'brand-text', text: '霓虹方块', parent: brand });
  
  el('p', { className: 'mode-caption', text: '无尽马拉松', parent: header });
  const miniBar = el('div', { className: 'mini-status', attrs: { 'aria-label': '当前分数与等级' }, parent: header });
  const miniScore = el('span', { className: 'mini-stat', id: 'mini-score', text: '得分 000000', parent: miniBar });
  const miniLevel = el('span', { className: 'mini-stat', id: 'mini-level', text: '等级 1', parent: miniBar });
  void miniBar;
  const actions = el('div', {
    className: 'header-actions', parent: header,
    attrs: { role: 'toolbar', 'aria-label': '游戏控制' },
  });
  const pauseButton = el('button', {
    className: 'icon-button', id: 'btn-pause', text: 'Ⅱ', parent: actions,
    attrs: { type: 'button', 'aria-label': '暂停 / 继续游戏' },
  });
  const soundButton = el('button', {
    className: 'icon-button', id: 'btn-sound', text: '♪', parent: actions,
    attrs: { type: 'button', 'aria-label': '声音开关' },
  });
  const settingsButton = el('button', {
    className: 'icon-button', id: 'btn-settings', text: '⚙', parent: actions,
    attrs: { type: 'button', 'aria-label': '打开设置' },
  });

  // ── 中部三栏：左 HOLD/分数/最高 · 中棋盘 Canvas · 右 NEXT/等级/行数 ──────
  const main = el('main', { className: 'playfield', attrs: { 'aria-label': '游戏区域' }, parent: root });

  const leftPanel = el('aside', { className: 'panel panel-left', attrs: { 'aria-label': '暂存与统计' }, parent: main });
  el('h2', { className: 'panel-title', text: '暂存', parent: leftPanel });
  const holdPreview = el('div', { className: 'preview-box hold-box', id: 'hold-preview', attrs: { 'aria-label': '暂存方块预览' }, parent: leftPanel });
  const scoreValue = statBlock(leftPanel, '得分', 'score-value', '000000');
  const bestValue = statBlock(leftPanel, '最高分', 'best-value', '000000');

  const boardPanel = el('section', { className: 'panel panel-board', attrs: { 'aria-label': '游戏棋盘' }, parent: main });
  const boardCanvas = el('canvas', {
    className: 'board-canvas', id: 'board-canvas', parent: boardPanel,
    attrs: { width: '300', height: '600', 'aria-label': '游戏棋盘，10 列 20 行', role: 'img' },
  });
  // 覆盖层挂载点（S04.3：READY/PAUSED/GAMEOVER/设置为真实 HTML 对话框，覆盖棋盘）
  const overlayRoot = el('div', { className: 'overlay-root', id: 'overlay-root', attrs: { 'aria-live': 'polite' }, parent: boardPanel });

  const rightPanel = el('aside', { className: 'panel panel-right', attrs: { 'aria-label': '预览与进度' }, parent: main });
  el('h2', { className: 'panel-title', text: '下一个', parent: rightPanel });
  const nextWrap = el('div', { className: 'preview-column next-column', id: 'next-preview', attrs: { 'aria-label': '接下来方块预览' }, parent: rightPanel });
  const nextSlots: HTMLElement[] = [];
  for (let i = 0; i < 3; i += 1) {
    nextSlots.push(el('div', { className: 'preview-box next-slot', attrs: { 'aria-hidden': 'true' }, parent: nextWrap }));
  }
  const levelValue = statBlock(rightPanel, '等级', 'level-value', '01');
  const linesValue = statBlock(rightPanel, '消除行数', 'lines-value', '0');

  // ── 底部：键盘说明 + 移动端虚拟按钮容器（T047 填充） ────────────────────
  el('footer', { className: 'key-guide', text: '← / →：单次移动一格　↓：按住连续软降　↑ / X：顺时针旋转　Z：逆时针旋转　空格：硬降　C：暂存　P：暂停', parent: root });
  const touchControls = el('div', { className: 'touch-controls', id: 'touch-controls', attrs: { 'aria-label': '触屏操作按键' }, parent: root });

  return {
    brand, boardCanvas, holdPreview, nextSlots,
    scoreValue, bestValue, levelValue, linesValue,
    miniScore, miniLevel,
    pauseButton, soundButton, settingsButton,
    overlayRoot, touchControls,
  };
}
