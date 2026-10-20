/**
 * N38：引擎状态 → 快照载荷（纯函数，无网络代码、无 DOM）。
 * `GameStateView.board` 为 `Cell[][]`（null=空格）；编码约定（N23）是 24 行 ×
 * 每行 10 字符：`.` 空、其余为方块类型首字母。`status` 只有 running/gameover：
 * 联网对局禁用个人暂停，ready/paused 一律上报 running（开局前占位帧照常发布）。
 * 输出恒通过 `encodeSnapshot` 校验（由单测往返钉死）。
 */
import type { GameStateView } from '../game/engine';
import type { SnapshotPayload } from '../../shared/protocol';

export function snapshotFromState(state: GameStateView, seq: number): SnapshotPayload {
  return {
    seq,
    board: state.board.map((row) => row.map((cell) => cell ?? '.').join('')),
    active:
      state.active === null
        ? null
        : { t: state.active.type, r: state.active.rotation, x: state.active.x, y: state.active.y },
    score: state.score,
    lines: state.lines,
    level: state.level,
    status: state.status === 'gameover' ? 'gameover' : 'running',
  };
}
