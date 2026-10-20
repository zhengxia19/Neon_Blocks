/**
 * N32：首页模式分流与联网入口面板（纯 DOM，无网络依赖；装配层注入回调）。
 * 全中文界面；无登录/注册流程——仅需昵称（服务端再验证）与房间码。
 * 输入控件为原生 input/button，触控目标 ≥44px（styles/app.css），
 * 不拦截全局按键——移动端输入不卡操作。
 */
import { NICKNAME_PATTERN, ROOM_CODE_MAX, ROOM_CODE_MIN } from '../../shared/protocol';

export interface EntryValidationOk {
  ok: true;
  nickname: string;
  roomCode: string;
}
export interface EntryValidationFail {
  ok: false;
  field: 'nickname' | 'roomCode';
  message: string;
}
export type EntryValidation = EntryValidationOk | EntryValidationFail;

/**
 * 本地预校验（快速反馈）；服务端为最终权威（NICKNAME_PATTERN 同源）。
 * 房间码：6 位数字且在 ROOM_CODE_MIN..ROOM_CODE_MAX。
 */
export function validateEntryInputs(nickname: string, roomCode: string): EntryValidation {
  const nick = nickname.trim();
  if (!NICKNAME_PATTERN.test(nick)) {
    return { ok: false, field: 'nickname', message: '昵称需为 1–16 位英文字母或数字。' };
  }
  const code = roomCode.trim();
  if (!/^\d{6}$/.test(code) || Number(code) < ROOM_CODE_MIN || Number(code) > ROOM_CODE_MAX) {
    return { ok: false, field: 'roomCode', message: '房间码需为 100000–999999 的 6 位数字。' };
  }
  return { ok: true, nickname: nick, roomCode: code };
}

/** 仅校验昵称（创建房间无需房间码）。 */
export function validateNicknameInput(nickname: string): EntryValidationFail | null {
  const nick = nickname.trim();
  if (!NICKNAME_PATTERN.test(nick)) {
    return { ok: false, field: 'nickname', message: '昵称需为 1–16 位英文字母或数字。' };
  }
  return null;
}

/** 顶部分流条：单人/联网两个链接（仅当构建期配置了公开 API 时由装配层渲染）。 */
export function renderModeSwitch(root: HTMLElement, current: 'single' | 'multiplayer'): void {
  const nav = document.createElement('nav');
  nav.className = 'mp-switch';
  nav.setAttribute('aria-label', '游戏模式');
  const path = window.location.pathname;
  const single = document.createElement('a');
  single.href = path;
  single.textContent = '单人模式';
  single.className = 'mp-switch-link';
  const mp = document.createElement('a');
  mp.href = `${path}?mode=multiplayer`;
  mp.textContent = '联网对战';
  mp.className = 'mp-switch-link';
  (current === 'single' ? single : mp).setAttribute('aria-current', 'page');
  nav.append(single, mp);
  root.prepend(nav);
}

export interface EntryHandlers {
  onCreate(nickname: string): void;
  onJoin(nickname: string, roomCode: string): void;
}

export interface EntryController {
  /** 装配层回写错误/状态文案（中文）；busy=true 期间按钮禁用防连点。 */
  showMessage(kind: 'error' | 'info', text: string): void;
  setBusy(busy: boolean): void;
  destroy(): void;
}

/** 联网入口面板：昵称 + 房间码 + 创建/加入两个动作 + 返回单人链接。 */
export function renderMultiplayerEntry(root: HTMLElement, handlers: EntryHandlers): EntryController {
  const panel = document.createElement('section');
  panel.className = 'mp-entry-panel';
  panel.setAttribute('aria-label', '联网对战');

  const title = document.createElement('h2');
  title.textContent = '联网对战';
  const hint = document.createElement('p');
  hint.className = 'mp-hint';
  hint.textContent = '输入昵称后创建房间，或输入 6 位房间码加入。无需登录。';

  const nickLabel = document.createElement('label');
  nickLabel.className = 'mp-field';
  nickLabel.textContent = '昵称';
  const nick = document.createElement('input');
  nick.id = 'mp-nickname';
  nick.maxLength = 16;
  nick.autocomplete = 'off';
  nick.setAttribute('autocapitalize', 'none');
  nick.placeholder = '1–16 位英文字母或数字';
  nickLabel.append(nick);

  const codeLabel = document.createElement('label');
  codeLabel.className = 'mp-field';
  codeLabel.textContent = '房间码';
  const code = document.createElement('input');
  code.id = 'mp-room-code';
  code.maxLength = 6;
  code.inputMode = 'numeric';
  code.autocomplete = 'off';
  code.placeholder = '例如 123456';
  codeLabel.append(code);

  const actions = document.createElement('div');
  actions.className = 'mp-actions';
  const createBtn = document.createElement('button');
  createBtn.id = 'mp-create';
  createBtn.type = 'button';
  createBtn.className = 'mp-btn';
  createBtn.textContent = '创建房间';
  const joinBtn = document.createElement('button');
  joinBtn.id = 'mp-join';
  joinBtn.type = 'button';
  joinBtn.className = 'mp-btn';
  joinBtn.textContent = '加入房间';
  actions.append(createBtn, joinBtn);

  const message = document.createElement('p');
  message.id = 'mp-entry-message';
  message.className = 'mp-message';
  message.setAttribute('role', 'alert');

  const back = document.createElement('a');
  back.className = 'mp-switch-link';
  back.href = `${window.location.pathname}`;
  back.textContent = '返回单人模式';

  panel.append(title, hint, nickLabel, codeLabel, actions, message, back);
  root.append(panel);

  const setBusy = (busy: boolean): void => {
    createBtn.disabled = busy;
    joinBtn.disabled = busy;
  };

  const onCreate = (): void => {
    const bad = validateNicknameInput(nick.value);
    if (bad !== null) {
      message.textContent = bad.message;
      return;
    }
    message.textContent = '';
    handlers.onCreate(nick.value.trim());
  };
  const onJoin = (): void => {
    const v = validateEntryInputs(nick.value, code.value);
    if (!v.ok) {
      message.textContent = v.message;
      return;
    }
    message.textContent = '';
    handlers.onJoin(v.nickname, v.roomCode);
  };
  createBtn.addEventListener('click', onCreate);
  joinBtn.addEventListener('click', onJoin);

  return {
    showMessage(kind, text) {
      message.textContent = text;
      message.classList.toggle('mp-message-error', kind === 'error');
      message.classList.toggle('mp-message-info', kind === 'info');
    },
    setBusy,
    destroy() {
      createBtn.removeEventListener('click', onCreate);
      joinBtn.removeEventListener('click', onJoin);
      panel.remove();
    },
  };
}
