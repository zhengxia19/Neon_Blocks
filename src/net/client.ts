/**
 * N31：联网 API/WS 客户端与生命周期。
 *
 * 边界与铁律：
 * - 仅向 WSS 握手 URL 传**一次性短期票据**（`?ticket=`）；长寿命席位令牌
 *   （seatToken）只出现在 POST 请求体与 sessionStorage，绝不进 URL/日志。
 * - 断线重连采用指数退避（500ms 起倍增、封顶 8s）；累计等待不侵蚀服务器
 *   30 秒断线宽限（`DISCONNECT_GRACE_MS`）——预算耗尽即停止重连并给出
 *   中文提示，由房间状态机裁决继续/淘汰。
 * - 单飞（single-flight）：任何时刻至多一条在途/已开连接；重连等待期间
 *   再次 connect() 不并发第二条连接。
 * - 协议版本不匹配（error(PROTOCOL_VERSION) 或 close 1002）为致命错误：
 *   不重连，中文提示刷新。
 * - 所有失败以 `shared/errors.ts` 目录内错误码 + 中文提示呈现，
 *   不透出内部异常文本。
 * - 单人模式不连接：本模块无自启动副作用，仅显式 connect() 才建立连接。
 */
import {
  DISCONNECT_GRACE_MS,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  VERSION_CLOSE_CODE,
  decodeMessage,
} from '../../shared/protocol';
import type {
  ClientMessage,
  CreateRoomRequest,
  HandshakeTicket,
  RoomCode,
  SeatId,
  SeatToken,
  ServerMessage,
} from '../../shared/protocol';
import { describeError } from '../../shared/errors';

/** 重连退避：起始 500ms、倍增、单次封顶 8s（远小于 30s 宽限，不侵蚀预算）。 */
export const RECONNECT_BASE_MS = 500 as const;
export const RECONNECT_MAX_DELAY_MS = 8_000 as const;

/** sessionStorage 中的席位凭据（刷新/重连恢复用；含机密 seatToken）。 */
export interface SeatCredential {
  code: RoomCode;
  generation: number;
  playerId: SeatId;
  seatToken: SeatToken;
}

export const CREDENTIAL_KEY = 'neon_blocks_mp_seat_v1' as const;

/** 最小 sessionStorage 形状（node 测试注入替身；浏览器默认用全局 sessionStorage）。 */
export interface CredentialStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): CredentialStore | null {
  const s = (globalThis as { sessionStorage?: CredentialStore }).sessionStorage;
  return s ?? null;
}

/** 最小 WebSocket 形状（浏览器 WebSocket 结构兼容；测试注入替身）。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close', cb: (ev: never) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;
const WS_CONNECTING = 0;

/** 联合类型分发式 Omit（ClientMessage 为可判别联合，普通 Omit 会坍缩）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RestOk<T> {
  ok: true;
  data: T;
}
export interface RestFail {
  ok: false;
  code: string;
  message: string;
  status: number;
}
export type RestResult<T> = RestOk<T> | RestFail;

/** create/join 成功后的席位信息（seatToken 仅此一次回显）。 */
export interface SeatInfo {
  code: RoomCode;
  generation: number;
  playerId: SeatId;
  seatToken: SeatToken;
}

export interface FatalInfo {
  code: string;
  message: string;
}

export interface NetClientOptions {
  /** API 根（如 https://xxx.workers.dev 或开发 http://127.0.0.1:8787）。 */
  apiBaseUrl: string;
  credentialStore?: CredentialStore;
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketCtor;
  now?: () => number;
  onMessage?: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: (info: { code: number; willReconnect: boolean }) => void;
  onFatal?: (err: FatalInfo) => void;
}

/** 保存/读取/清除 sessionStorage 席位凭据（JSON；损坏即清除）。 */
export function loadCredential(store: CredentialStore): SeatCredential | null {
  const raw = store.getItem(CREDENTIAL_KEY);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as SeatCredential;
    if (
      typeof v.code === 'string' &&
      typeof v.playerId === 'string' &&
      typeof v.seatToken === 'string' &&
      typeof v.generation === 'number'
    ) {
      return v;
    }
  } catch {
    /* 落盘损坏：按无凭据处理 */
  }
  store.removeItem(CREDENTIAL_KEY);
  return null;
}

export function saveCredential(store: CredentialStore, cred: SeatCredential): void {
  store.setItem(CREDENTIAL_KEY, JSON.stringify(cred));
}

export function clearCredential(store: CredentialStore): void {
  store.removeItem(CREDENTIAL_KEY);
}

export class NetClient {
  readonly #apiBase: string;
  readonly #store: CredentialStore | null;
  readonly #fetch: typeof fetch | null;
  readonly #wsCtor: WebSocketCtor | null;
  readonly #now: () => number;
  readonly #onMessage?: (msg: ServerMessage) => void;
  readonly #onOpen?: () => void;
  readonly #onClose?: (info: { code: number; willReconnect: boolean }) => void;
  readonly #onFatal?: (err: FatalInfo) => void;

  #ws: WebSocketLike | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectPromise: Promise<RestResult<{ connected: boolean }>> | null = null;
  #attempt = 0;
  #disconnectedAt: number | null = null;
  #closedIntentionally = false;
  #fatal: FatalInfo | null = null;
  #seq = 0;

  constructor(options: NetClientOptions) {
    this.#apiBase = options.apiBaseUrl.replace(/\/+$/, '');
    this.#store = options.credentialStore ?? defaultStore();
    this.#fetch = options.fetchImpl ?? (globalThis.fetch ?? null);
    this.#wsCtor = options.webSocketImpl ?? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket ?? null);
    this.#now = options.now ?? Date.now;
    this.#onMessage = options.onMessage;
    this.#onOpen = options.onOpen;
    this.#onClose = options.onClose;
    this.#onFatal = options.onFatal;
  }

  /** 连接态：'closed' | 'connecting' | 'open' | 'reconnecting'。 */
  get state(): 'closed' | 'connecting' | 'open' | 'reconnecting' {
    if (this.#fatal !== null) return 'closed';
    if (this.#ws !== null && this.#ws.readyState === WS_OPEN) return 'open';
    if (this.#ws !== null && this.#ws.readyState === WS_CONNECTING) return 'connecting';
    if (this.#reconnectTimer !== null) return 'reconnecting';
    return 'closed';
  }

  get fatal(): FatalInfo | null {
    return this.#fatal;
  }

  // ------------------------------------------------------------------ REST

  async createRoom(req: CreateRoomRequest): Promise<RestResult<SeatInfo>> {
    const res = await this.#post('/api/rooms', req);
    const fail = await this.#failFrom(res);
    if (fail !== null) return fail;
    const data = (await res.json()) as {
      code: RoomCode;
      generation: number;
      playerId: SeatId;
      seatToken: SeatToken;
    };
    const seat: SeatInfo = {
      code: data.code,
      generation: data.generation,
      playerId: data.playerId,
      seatToken: data.seatToken,
    };
    this.#fatal = null; // 成功取得席位 ⇒ 清除旧致命粘滞（P2-4）
    this.#saveSeat(seat);
    return { ok: true, data: seat };
  }

  async joinRoom(code: RoomCode, nickname: string): Promise<RestResult<SeatInfo>> {
    const res = await this.#post(`/api/rooms/${encodeURIComponent(code)}/join`, { nickname });
    const fail = await this.#failFrom(res);
    if (fail !== null) return fail;
    const data = (await res.json()) as {
      code: RoomCode;
      generation: number;
      playerId: SeatId;
      seatToken: SeatToken;
    };
    const seat: SeatInfo = {
      code: data.code ?? code,
      generation: data.generation,
      playerId: data.playerId,
      seatToken: data.seatToken,
    };
    this.#fatal = null; // 成功取得席位 ⇒ 清除旧致命粘滞（P2-4）
    this.#saveSeat(seat);
    return { ok: true, data: seat };
  }

  /** 主动离开房间：清凭据、清致命粘滞、断开（LeaveMsg 由装配层先行 send）。 */
  leave(): void {
    clearCredential(this.#storeLike());
    this.#fatal = null;
    this.#attempt = 0;
    this.#disconnectedAt = null;
    this.close();
  }

  // ------------------------------------------------------------------ WS 生命周期

  /**
   * 建立（或复用）连接：先 POST 换一次性票据，再 `GET /ws/<码>?ticket=<票据>`。
   * 单飞：已 open/connecting 或重连等待中 ⇒ 不并发第二条连接。
   */
  async connect(): Promise<RestResult<{ connected: boolean }>> {
    if (this.#fatal !== null) {
      return { ok: false, code: this.#fatal.code, message: this.#fatal.message, status: 0 };
    }
    if (this.#ws !== null && (this.#ws.readyState === WS_OPEN || this.#ws.readyState === WS_CONNECTING)) {
      return { ok: true, data: { connected: true } };
    }
    if (this.#reconnectTimer !== null) {
      // 重连等待中：不并发第二条连接（验收：断线/恢复不重入并发连接）。
      return { ok: true, data: { connected: false } };
    }
    this.#closedIntentionally = false;
    return this.#connectNow();
  }

  /** 单飞：并发 connect 复用同一次在途握手，绝不并发两条连接。 */
  #connectNow(): Promise<RestResult<{ connected: boolean }>> {
    if (this.#connectPromise !== null) return this.#connectPromise;
    const p = this.#openWithTicket().finally(() => {
      if (this.#connectPromise === p) this.#connectPromise = null;
    });
    this.#connectPromise = p;
    return p;
  }

  /** 主动断开（不再自动重连）。 */
  close(): void {
    this.#closedIntentionally = true;
    // 有意不清 disconnectedAt：随后再 connect 的退避预算仍从首断起算——
    // 比服务端新宽限更保守（安全方向），防止装配层反复 connect 侵蚀宽限。
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws !== null) {
      try {
        this.#ws.close(1000, 'client leave');
      } catch {
        /* 已关闭 */
      }
      this.#ws = null;
    }
  }

  /** 发送客户端消息：自动补连接内单调 seq；未 open 返回 false（调用方决定丢弃/排队）。 */
  send(msg: DistributiveOmit<ClientMessage, 'seq'> & { seq?: number }): boolean {
    if (this.#ws === null || this.#ws.readyState !== WS_OPEN) return false;
    const seq = msg.seq ?? ++this.#seq;
    if (msg.seq === undefined) {
      this.#seq = Math.max(this.#seq, seq);
    }
    this.#ws.send(JSON.stringify({ ...msg, seq, v: PROTOCOL_VERSION }));
    return true;
  }

  // ------------------------------------------------------------------ 内部

  #storeLike(): CredentialStore {
    if (this.#store === null) {
      throw new Error('无可用凭据存储（sessionStorage 缺失且未注入替身）');
    }
    return this.#store;
  }

  #saveSeat(seat: SeatInfo): void {
    if (this.#store !== null) {
      saveCredential(this.#store, {
        code: seat.code,
        generation: seat.generation,
        playerId: seat.playerId,
        seatToken: seat.seatToken,
      });
    }
  }

  async #post(path: string, body: unknown): Promise<Response> {
    if (this.#fetch === null) throw new Error('无可用 fetch（未注入替身）');
    return this.#fetch(this.#apiBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async #failFrom(res: Response): Promise<RestFail | null> {
    if (res.status >= 200 && res.status < 300) return null;
    let code = 'INTERNAL';
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data.error === 'string') code = data.error;
    } catch {
      /* 非 JSON 错误体：按 INTERNAL 中文回退 */
    }
    return { ok: false, code, message: describeError(code).message, status: res.status };
  }

  async #openWithTicket(): Promise<RestResult<{ connected: boolean }>> {
    const cred = this.#store !== null ? loadCredential(this.#store) : null;
    if (cred === null) {
      return { ok: false, code: 'UNAUTHORIZED', message: describeError('UNAUTHORIZED').message, status: 0 };
    }
    if (this.#wsCtor === null) {
      return { ok: false, code: 'INTERNAL', message: describeError('INTERNAL').message, status: 0 };
    }
    // 一次性短期票据：每次连接（含重连）都重新换取；长令牌 seatToken 只进 POST body。
    const res = await this.#post(`/api/rooms/${encodeURIComponent(cred.code)}/ticket`, {
      playerId: cred.playerId,
      seatToken: cred.seatToken,
    });
    const fail = await this.#failFrom(res);
    if (fail !== null) {
      if (this.#reconnectPending()) {
        // P2-3：重连期票据失败（席位驱逐/GENERATION_STALE/网络故障）⇒ 继续退避，
        // 并通知装配层本次断开（否则只能等预算耗尽见 onFatal）。
        const willReconnect = this.#scheduleReconnect();
        this.#onClose?.({ code: 1006, willReconnect });
      }
      return fail;
    }
    const data = (await res.json()) as { ticket: HandshakeTicket };
    // P2-1：票据 POST 在途期间 close()/leave() ⇒ 放弃构造，杜绝僵尸连接
    // （置于全部 await 之后、new WebSocket 之前，封死最后一段微任务窗口）。
    if (this.#closedIntentionally || this.#fatal !== null) {
      return { ok: true, data: { connected: false } };
    }
    const wsUrl = this.#wsUrl(cred.code, data.ticket);
    const ws = new this.#wsCtor(wsUrl);
    this.#ws = ws;
    ws.addEventListener('open', (() => this.#handleOpen()) as never);
    ws.addEventListener('message', ((ev: { data: unknown }) => this.#handleMessage(ws, ev.data)) as never);
    ws.addEventListener('close', ((ev: { code: number }) => this.#handleClose(ws, ev.code)) as never);
    return { ok: true, data: { connected: false } };
  }

  /** 握手 URL：仅含一次性票据；长寿命 seatToken 绝不出现（验收钉死）。 */
  #wsUrl(code: RoomCode, ticket: HandshakeTicket): string {
    const base = this.#apiBase.startsWith('https')
      ? `wss://${this.#apiBase.slice('https://'.length)}`
      : `ws://${this.#apiBase.replace(/^http:\/\//, '')}`;
    return `${base}/ws/${encodeURIComponent(code)}?ticket=${encodeURIComponent(ticket)}`;
  }

  #reconnectPending(): boolean {
    return this.#disconnectedAt !== null;
  }

  #handleOpen(): void {
    this.#attempt = 0;
    this.#disconnectedAt = null;
    this.#onOpen?.();
  }

  #handleMessage(ws: WebSocketLike, data: unknown): void {
    if (this.#ws !== ws) return; // 陈旧连接的迟到帧
    if (typeof data !== 'string') return;
    const msg = decodeMessage(data);
    if (msg === null) return;
    const candidate = msg as { v?: unknown; type?: unknown; code?: unknown };
    // 协议版本处理：任何 v 不匹配的消息（含 error(PROTOCOL_VERSION)）⇒ 致命，不重连。
    if (candidate.v !== PROTOCOL_VERSION) {
      this.#fatalClose('PROTOCOL_VERSION');
      return;
    }
    // S→C 轻量校验：type 必须在服务端消息白名单内（未知类型静默忽略，连接保持）。
    if (typeof candidate.type !== 'string' || !(SERVER_MESSAGE_TYPES as readonly string[]).includes(candidate.type)) {
      return;
    }
    if (candidate.type === 'error' && candidate.code === 'PROTOCOL_VERSION') {
      this.#fatalClose('PROTOCOL_VERSION');
      return;
    }
    this.#onMessage?.(msg as ServerMessage);
  }

  #handleClose(ws: WebSocketLike, code: number): void {
    if (this.#ws !== ws) return; // 陈旧连接的迟到 close
    this.#ws = null;
    if (this.#closedIntentionally || this.#fatal !== null) {
      this.#onClose?.({ code, willReconnect: false });
      return;
    }
    if (code === VERSION_CLOSE_CODE) {
      // 冻结契约：服务端 error(PROTOCOL_VERSION) 后以 1002 关闭 ⇒ 客户端不重连。
      this.#fatalClose('PROTOCOL_VERSION');
      this.#onClose?.({ code, willReconnect: false });
      return;
    }
    if (this.#disconnectedAt === null) this.#disconnectedAt = this.#now();
    const willReconnect = this.#scheduleReconnect();
    this.#onClose?.({ code, willReconnect });
  }

  /** 指数退避：500ms×2^n 封顶 8s；累计预算超 30s 宽限 ⇒ 放弃并中文提示。 */
  #scheduleReconnect(): boolean {
    if (this.#reconnectTimer !== null || this.#disconnectedAt === null) {
      return this.#reconnectTimer !== null;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempt, RECONNECT_MAX_DELAY_MS);
    this.#attempt += 1;
    if (this.#now() - this.#disconnectedAt + delay > DISCONNECT_GRACE_MS) {
      this.#disconnectedAt = null;
      this.#fatal = { code: 'INTERNAL', message: '连接已断开，重连超时，请重新加入房间。' };
      this.#onFatal?.(this.#fatal);
      return false;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connectNow();
    }, delay);
    return true;
  }

  #fatalClose(code: string): void {
    this.#fatal = { code, message: describeError(code).message };
    this.#onFatal?.(this.#fatal);
    if (this.#ws !== null) {
      try {
        this.#ws.close();
      } catch {
        /* 已关闭 */
      }
      this.#ws = null;
    }
  }
}
