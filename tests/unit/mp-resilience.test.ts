/**
 * N40：失焦/断线/刷新语义装配断言——对局期断开遮罩+冻结、重连解冻、
 * 刷新自动重连（席位凭据）、match_start 缓存重建、快照 seq 高水位续起；
 * 单人自动暂停语义不受联网装配影响（main.ts 保持 blur/visibilitychange 暂停）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = {
  overlay: readFileSync(join(process.cwd(), 'src', 'ui', 'conn-overlay.ts'), 'utf8'),
  match: readFileSync(join(process.cwd(), 'src', 'app', 'match.ts'), 'utf8'),
  multiplayer: readFileSync(join(process.cwd(), 'src', 'app', 'multiplayer.ts'), 'utf8'),
  main: readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8'),
  css: readFileSync(join(process.cwd(), 'src', 'styles', 'multiplayer.css'), 'utf8'),
};

describe('N40 连接中断遮罩组件', () => {
  it('正向：role=status、初始 hidden、show/hide/destroy 三态齐备', () => {
    expect(SRC.overlay).toContain("box.id = 'mp-conn-overlay'");
    expect(SRC.overlay).toContain("box.setAttribute('role', 'status')");
    expect(SRC.overlay).toContain('box.hidden = true;');
    expect(SRC.overlay).toContain('box.hidden = false;');
    expect(SRC.overlay).toContain('if (!box.isConnected) {');
    expect(SRC.overlay).toContain('box.remove();');
  });

  it('正向（复审 P2-1）：destroy 后 show 空操作，防 teardown 异步 onClose 复活僵尸遮罩', () => {
    expect(SRC.overlay).toContain('if (destroyed) return;');
    expect(SRC.overlay).toContain('destroyed = true;');
  });

  it('反向：纯 DOM 组件——无网络、无计时器、无墙钟读取', () => {
    for (const forbidden of ['fetch(', 'WebSocket', 'setInterval', 'setTimeout', 'Date.now(']) {
      expect(SRC.overlay).not.toContain(forbidden);
    }
  });

  it('正向：CSS 显式恢复 [hidden] 隐藏语义（display:flex 覆盖 UA 规则教训）', () => {
    expect(SRC.css).toMatch(/#mp-conn-overlay \{[^}]*position: fixed;/);
    expect(SRC.css).toMatch(/#mp-conn-overlay\[hidden\] \{\s*display: none;\s*\}/);
  });
});

describe('N40 对局冻结与终局兜底（match.ts）', () => {
  it('正向：冻结/终局门控步进、节奏与开局判定，触屏动作经 inputLive 门控', () => {
    expect(SRC.match).toContain('if (!frozen && !ended) engine.step(dtMs);');
    expect(SRC.match).toContain('if (!frozen && !ended) {');
    expect(SRC.match).toContain('!started && !ended && !frozen &&');
    expect(SRC.match).toContain('if (inputLive()) engine.hardDrop();');
    expect(SRC.match).toContain('if (inputLive()) engine.hold();');
    expect(SRC.match).toContain('if (inputLive()) engine.rotate(direction);');
  });

  it('正向：setFrozen 冻结即卸载键盘释放长按，恢复即重挂并重置帧时间戳', () => {
    expect(SRC.match).toMatch(
      /setFrozen\(frozenNow: boolean\): void \{[\s\S]*?releaseInputs\(\);\s*keyboard\.dispose\(\);[\s\S]*?keyboard\.attach\(window\);\s*lastFrameMs = performance\.now\(\);/,
    );
  });

  it('正向（复审 P1）：无观察目标时以首帧采纳目标并复位水位（刷新重建自愈）', () => {
    expect(SRC.match).toContain('const adoptWatchTarget = (targetPlayerId: string): void => {');
    expect(SRC.match).toMatch(
      /adoptWatchTarget[\s\S]{0,120}remoteBoard\.resetForTarget\(\);\s*syncOpponentPanel\(\);/,
    );
    expect(SRC.match).toMatch(
      /if \(watchTargetId === null\) \{\s*adoptWatchTarget\(targetPlayerId\);\s*\} else if \(targetPlayerId !== watchTargetId\) \{\s*return false;\s*\}/,
    );
  });

  it('正向：applyRoomFinished（错过 match_end 的 FINISHED 重连）终局展示并释放输入', () => {
    expect(SRC.match).toMatch(
      /applyRoomFinished\(\): void \{[\s\S]*?ended = true;[\s\S]*?releaseInputs\(\);\s*keyboard\.dispose\(\);\s*touch\.dispose\(\);/,
    );
  });

  it('反向：联网对局仍无个人暂停入口（Esc/Enter 空操作、无暂停调用）', () => {
    expect(SRC.match).not.toMatch(/\.togglePause\(/);
    expect(SRC.match).toContain('联网对局禁用个人暂停：Esc 空操作。');
  });
});

describe('N40 断线遮罩与冻结接线（multiplayer.ts）', () => {
  it('正向：对局期 onClose/onFatal ⇒ 冻结+遮罩；onOpen ⇒ 解冻+隐藏遮罩', () => {
    expect(SRC.multiplayer).toMatch(
      /if \(match !== null\) \{[\s\S]*?match\.setFrozen\(true\);\s*connOverlay\.show\(/,
    );
    expect(SRC.multiplayer).toMatch(
      /if \(match !== null\) \{\s*match\.setFrozen\(false\);\s*connOverlay\.hide\(\);\s*\}/,
    );
  });

  it('正向：FINISHED 重连（match 在/不在）都走 applyRoomFinished，LOBBY 拆局隐藏遮罩', () => {
    expect(SRC.multiplayer).toMatch(
      /else if \(match !== null && msg\.phase === 'FINISHED'\) \{[\s\S]*?stopSnapshotPublishing\(\);\s*match\.applyRoomFinished\(\);/,
    );
    expect(SRC.multiplayer).toContain('match.applyRoomFinished();');
  });

  it('正向（复审 P2-2）：RUNNING 但无本人对局缓存 ⇒ 大厅视图 + 中文提示（不静默）', () => {
    expect(SRC.multiplayer).toMatch(
      /lobby\?\.update\(msg\);\s*if \(msg\.phase === 'RUNNING'\) \{\s*lobby\?\.showMessage\('info', '比赛进行中，未能恢复本局棋盘；本局结束后自动返回大厅。'\);/,
    );
  });
});

describe('N40 刷新恢复（multiplayer.ts）', () => {
  it('正向：启动即读席位凭据自动重连，跳过入口面板', () => {
    expect(SRC.multiplayer).toContain('loadCredential(window.sessionStorage)');
    expect(SRC.multiplayer).toContain('void enterLobby(restored.code, restored.playerId);');
  });

  it('正向：match_start 载荷入缓存；RUNNING/FINISHED 重连按 matchId 比对重建对局', () => {
    expect(SRC.multiplayer).toContain('writeCache(MATCH_CACHE_KEY, msg);');
    expect(SRC.multiplayer).toContain('cached.matchId === msg.matchId');
    expect(SRC.multiplayer).toContain('bootMatch(root, cached, clockOffset, myPlayerId, {}, matchUi);');
  });

  it('正向：快照 seq 从 sessionStorage 高水位续起（服务端拒收 seq ≤ 旧值）', () => {
    expect(SRC.multiplayer).toContain('snapCache.matchId === matchId ? snapCache.seq : 0');
    expect(SRC.multiplayer).toContain('writeCache(SNAP_CACHE_KEY, { matchId, seq: snapSeq });');
  });

  it('反向：主动离开清缓存，不再自动重连/重建对局', () => {
    expect(SRC.multiplayer).toMatch(
      /leftIntentionally = false;\s*clearPreCountdown\(\);\s*stopSnapshotPublishing\(\);\s*clearMatchCache\(\);/,
    );
  });
});

describe('N40 单人自动暂停不受影响（main.ts）', () => {
  it('正向：单人 blur/visibilitychange 仍挂自动暂停（suspendGame）', () => {
    expect(SRC.main).toContain('window.addEventListener(\'blur\', onBlur);');
    expect(SRC.main).toContain("document.addEventListener('visibilitychange', onVisibilityChange);");
    expect(SRC.main).toContain('const onBlur = (): void => suspendGame();');
  });

  it('反向：联网装配（multiplayer/match）不引入任何暂停调用', () => {
    expect(SRC.multiplayer).not.toContain('togglePause');
    expect(SRC.multiplayer).not.toContain('suspendGame');
  });
});
