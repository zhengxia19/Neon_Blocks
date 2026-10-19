import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, describeError, isErrorCode } from '../../shared/errors';
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../../shared/protocol';
import { validateClientMessage } from '../../shared/validate';
import worker from '../src/index';

describe('N02 前后端共享类型边界', () => {
  it('Worker 侧可导入 shared/protocol 常量（与前端同一份契约）', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_ID).toBe('neon-blocks-mp');
  });

  it('N03 Worker 侧可导入 shared/errors，错误码目录与前端同源', () => {
    expect(isErrorCode('ROOM_FULL')).toBe(true);
    expect(isErrorCode('MYSTERY')).toBe(false);
    expect(describeError('MYSTERY')).toEqual(ERROR_CATALOG.INTERNAL);
    expect(ERROR_CATALOG.PROTOCOL_VERSION.retryable).toBe(false);
  });

  it('N04 Worker 侧可复用 shared/validate 严格校验（禁止字段整条拒绝）', () => {
    const polluted = validateClientMessage({ v: 1, type: 'gameover', seq: 1, playerId: 's_1' });
    expect(polluted.ok).toBe(false);
    if (!polluted.ok) expect(polluted.code).toBe('FORBIDDEN_FIELD');
    const good = validateClientMessage({ v: 1, type: 'ready', seq: 1 });
    expect(good.ok).toBe(true);
  });

  it('正向：/api/health 返回协议版本，不暴露房间或玩家信息', async () => {
    const res = await worker.fetch(new Request('https://example.com/api/health'), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', protocol: PROTOCOL_ID, version: PROTOCOL_VERSION });
    expect(Object.keys(body).sort()).toEqual(['protocol', 'status', 'version']);
  });

  it('反向：未知路径返回 404，不回显请求内容', async () => {
    const res = await worker.fetch(new Request('https://example.com/api/rooms/123'), {});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });
});
