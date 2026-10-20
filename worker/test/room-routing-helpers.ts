// N26/N28 共享测试夹具：Hibernation 假 socket 与时间/棋盘常量。
import type { FakeHibernatableSocket } from './stubs/sqlite-storage';

export interface WsState {
  sent: string[];
  attachment: unknown;
  closed: { code: number; reason: string } | null;
  bufferedAmount: number;
}

export function makeFakeWs(): { ws: WebSocket; state: WsState } {
  const state: WsState = { sent: [], attachment: null, closed: null, bufferedAmount: 0 };
  const ws: FakeHibernatableSocket = {
    send: (m: string) => state.sent.push(m),
    close: (code?: number, reason?: string) => {
      state.closed = { code: code ?? 1005, reason: reason ?? '' };
    },
    serializeAttachment: (a: unknown) => {
      state.attachment = a;
      return JSON.stringify(a);
    },
    deserializeAttachment: () => state.attachment,
    get bufferedAmount() {
      return state.bufferedAmount;
    },
  };
  return { ws: ws as unknown as WebSocket, state };
}

export const T0 = 1_700_000_000_000;
export const EMPTY_BOARD = Array.from({ length: 24 }, () => '..........');
