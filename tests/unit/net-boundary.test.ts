import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, PROTOCOL_ID, PROTOCOL_VERSION } from '../../shared/protocol';
import * as netEntry from '../../src/net';

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTs(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SRC_ROOT = join(process.cwd(), 'src');
const SHARED_ROOT = join(process.cwd(), 'shared');

describe('N02 网络模块目录与构建边界', () => {
  it('正向：前端可导入 shared 协议常量，src/net 入口复用同一份契约', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_ID).toBe('neon-blocks-mp');
    expect(MAX_MESSAGE_BYTES).toBe(4096);
    expect(netEntry.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
    expect(netEntry.MAX_MESSAGE_BYTES).toBe(MAX_MESSAGE_BYTES);
  });

  it('反向：src/ 内不得引用 worker/ 服务端实现（前端产物不含 Worker 代码）', () => {
    const offenders = listTs(SRC_ROOT)
      .filter((f) => /from\s+['"][^'"]*worker\//.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });

  it('反向：src/game/ 纯逻辑不得依赖 net/ 或 DOM/Worker API', () => {
    const offenders = listTs(join(SRC_ROOT, 'game'))
      .filter((f) => /from\s+['"][^'"]*(net|worker)\//.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });

  it('反向：shared/ 为纯类型与常量，不得出现 Worker/DOM 专有 API', () => {
    const offenders = listTs(SHARED_ROOT)
      .filter((f) => /\b(DurableObject|ExportedHandler|WebSocketServer|document|window)\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
