/**
 * N33：等待大厅（纯 DOM，无网络依赖）。
 * 房主设置（人数 2–6 / 随机 S1–S3 / 自定义种子 / 起始等级 1–10）、席位列表、
 * 准备、6 位房间码复制、房主退出转交确认。权限与门槛的最终裁决在服务端
 * （worker/src/room.ts），本文件的纯助手只做同参数的本地预校验。
 */
import {
  CUSTOM_SEED_PATTERN,
  MAX_PLAYERS,
  MAX_START_LEVEL,
  MIN_PLAYERS,
  MIN_START_LEVEL,
  type PlayerView,
  type RandomMode,
  type RoomCode,
  type RoomPhase,
  type RoomStateMsg,
} from '../../shared/protocol';

// ---------------------------------------------------------------- 纯助手（单测钉死）

/** 只有房主、且房间处于 LOBBY 阶段时可修改设置（开局后参数锁定）。 */
export function canEditRoom(isHost: boolean, phase: RoomPhase): boolean {
  return isHost && phase === 'LOBBY';
}

/** 开局门槛：房主 + LOBBY + 至少 MIN_PLAYERS 人且全员准备（服务端同规则再裁决）。 */
export function canStartMatch(isHost: boolean, phase: RoomPhase, players: readonly PlayerView[]): boolean {
  return (
    isHost &&
    phase === 'LOBBY' &&
    players.length >= MIN_PLAYERS &&
    players.every((p) => p.ready)
  );
}

export interface SettingsForm {
  capacity: number;
  randomMode: RandomMode;
  customSeed: string;
  startLevel: number;
}

export type SettingsFormCheck =
  | { ok: true; value: { capacity: number; randomMode: RandomMode; startLevel: number; customSeed?: string } }
  | { ok: false; field: 'capacity' | 'randomMode' | 'customSeed' | 'startLevel'; message: string };

/** 与 shared/protocol 边界常量同源的本地预校验（服务端为最终权威）。 */
export function validateSettingsForm(form: SettingsForm): SettingsFormCheck {
  const { capacity, randomMode, customSeed, startLevel } = form;
  if (!Number.isInteger(capacity) || capacity < MIN_PLAYERS || capacity > MAX_PLAYERS) {
    return { ok: false, field: 'capacity', message: '房间人数需为 2–6 人。' };
  }
  if (randomMode !== 'S1' && randomMode !== 'S2' && randomMode !== 'S3') {
    return { ok: false, field: 'randomMode', message: '随机模式需为 S1、S2 或 S3。' };
  }
  if (randomMode === 'S3') {
    if (!CUSTOM_SEED_PATTERN.test(customSeed)) {
      return { ok: false, field: 'customSeed', message: '自定义种子需为 1–32 位英文字母或数字。' };
    }
  }
  if (!Number.isInteger(startLevel) || startLevel < MIN_START_LEVEL || startLevel > MAX_START_LEVEL) {
    return { ok: false, field: 'startLevel', message: '初始等级需为 1–10。' };
  }
  return {
    ok: true,
    value: {
      capacity,
      randomMode,
      startLevel,
      ...(randomMode === 'S3' ? { customSeed } : {}),
    },
  };
}

/** 大厅阶段中文文案（COUNTDOWN 附带剩余秒数）。 */
export function phaseLabel(phase: RoomPhase, startAt: number | null, serverNow: number): string {
  switch (phase) {
    case 'LOBBY':
      return '等待大厅';
    case 'COUNTDOWN': {
      const remain = startAt !== null ? Math.max(0, Math.ceil((startAt - serverNow) / 1000)) : 0;
      return `即将开始（约 ${remain} 秒）`;
    }
    case 'RUNNING':
      return '比赛进行中';
    case 'FINISHED':
      return '本局已结束';
  }
}

// ---------------------------------------------------------------- DOM 渲染

export interface LobbyCallbacks {
  /** 单向准备（服务端无「取消准备」；设置变更会重置全员准备状态）。 */
  onReady(): void;
  onStart(): void;
  onLeave(): void;
  onSettingsUpdate(settings: { capacity: number; randomMode: RandomMode; startLevel: number; customSeed?: string }): void;
}

export interface LobbyController {
  /** 应用服务端 room_state（权威视图，全员一致）。 */
  update(state: RoomStateMsg): void;
  showMessage(kind: 'info' | 'error', text: string): void;
  destroy(): void;
}

const PHASE_LABEL_ZH: Record<RoomPhase, string> = {
  LOBBY: '等待大厅',
  COUNTDOWN: '即将开始',
  RUNNING: '比赛进行中',
  FINISHED: '本局已结束',
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls !== undefined && cls !== null) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 挂载等待大厅。
 * @param root 容器（清空后渲染）
 * @param myPlayerId 本席位 id（准备状态与按钮态依据）
 * @param callbacks 动作回调（由装配层发送对应协议消息）
 */
export function renderLobby(root: HTMLElement, myPlayerId: string, callbacks: LobbyCallbacks): LobbyController {
  const doc = root.ownerDocument;
  root.textContent = '';

  const panel = el(doc, 'section', 'mp-lobby-panel');
  panel.id = 'mp-lobby';

  // 房间码 + 复制
  const codeRow = el(doc, 'div', 'mp-lobby-code');
  const codeLabel = el(doc, 'span', null, '房间码：');
  const codeValue = el(doc, 'strong', 'mp-lobby-code-value');
  codeValue.id = 'mp-room-code-value';
  const copyBtn = el(doc, 'button', 'mp-copy-code');
  copyBtn.id = 'mp-copy-code';
  copyBtn.type = 'button';
  copyBtn.textContent = '复制房间码';
  codeRow.append(codeLabel, codeValue, copyBtn);

  // 阶段与提示
  const phaseNode = el(doc, 'div', 'mp-lobby-phase');
  phaseNode.id = 'mp-phase';
  phaseNode.textContent = PHASE_LABEL_ZH.LOBBY;
  const messageNode = el(doc, 'div', 'mp-lobby-message');
  messageNode.id = 'mp-lobby-message';
  messageNode.setAttribute('role', 'status');

  // 席位列表
  const seatList = el(doc, 'ul', 'mp-seat-list');
  seatList.id = 'mp-seat-list';

  // 房主设置区
  const settings = el(doc, 'div', 'mp-lobby-settings');
  settings.id = 'mp-settings';
  const capacitySelect = el(doc, 'select');
  capacitySelect.id = 'mp-capacity';
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n += 1) {
    const opt = el(doc, 'option');
    opt.value = String(n);
    opt.textContent = `${n} 人`;
    capacitySelect.append(opt);
  }
  const modeSelect = el(doc, 'select');
  modeSelect.id = 'mp-random-mode';
  for (const [value, label] of [
    ['S1', 'S1 完全随机'],
    ['S2', 'S2 同序列随机'],
    ['S3', 'S3 自定义种子'],
  ] as const) {
    const opt = el(doc, 'option');
    opt.value = value;
    opt.textContent = label;
    modeSelect.append(opt);
  }
  const seedInput = el(doc, 'input');
  seedInput.id = 'mp-custom-seed';
  seedInput.type = 'text';
  seedInput.placeholder = '自定义种子（1–32 位字母或数字）';
  seedInput.maxLength = 32;
  const levelSelect = el(doc, 'select');
  levelSelect.id = 'mp-start-level';
  for (let n = MIN_START_LEVEL; n <= MAX_START_LEVEL; n += 1) {
    const opt = el(doc, 'option');
    opt.value = String(n);
    opt.textContent = `等级 ${n}`;
    levelSelect.append(opt);
  }
  const applyBtn = el(doc, 'button', 'mp-apply-settings');
  applyBtn.id = 'mp-apply-settings';
  applyBtn.type = 'button';
  applyBtn.textContent = '应用设置';
  settings.append(
    el(doc, 'label', null, '房间人数'),
    capacitySelect,
    el(doc, 'label', null, '随机模式'),
    modeSelect,
    seedInput,
    el(doc, 'label', null, '初始等级'),
    levelSelect,
    applyBtn,
  );

  // 动作按钮
  const readyBtn = el(doc, 'button', 'mp-ready');
  readyBtn.id = 'mp-ready';
  readyBtn.type = 'button';
  readyBtn.textContent = '准备';
  const startBtn = el(doc, 'button', 'mp-start');
  startBtn.id = 'mp-start';
  startBtn.type = 'button';
  startBtn.textContent = '开始对局';
  const leaveBtn = el(doc, 'button', 'mp-leave');
  leaveBtn.id = 'mp-leave';
  leaveBtn.type = 'button';
  leaveBtn.textContent = '离开房间';

  panel.append(codeRow, phaseNode, messageNode, el(doc, 'h3', null, '玩家席位'), seatList, settings, readyBtn, startBtn, leaveBtn);
  root.append(panel);

  let latest: RoomStateMsg | null = null;

  function showMessage(kind: 'info' | 'error', text: string): void {
    messageNode.textContent = text;
    messageNode.classList.toggle('mp-lobby-error', kind === 'error');
  }

  function renderSeats(players: readonly PlayerView[]): void {
    seatList.textContent = '';
    for (const p of players) {
      const li = el(doc, 'li', 'mp-seat');
      const parts = [`#${p.seatIndex} ${p.nickname}`];
      if (p.isHost) parts.push('房主');
      if (p.playerId === myPlayerId) parts.push('（我）');
      if (p.status === 'disconnected') parts.push('连接中断');
      else parts.push(p.ready ? '已准备' : '未准备');
      li.textContent = parts.join(' · ');
      seatList.append(li);
    }
  }

  function syncControls(state: RoomStateMsg): void {
    const me = state.players.find((p) => p.playerId === myPlayerId);
    const isHost = me?.isHost ?? false;
    const editable = canEditRoom(isHost, state.phase);
    capacitySelect.disabled = !editable;
    modeSelect.disabled = !editable;
    seedInput.disabled = !editable;
    levelSelect.disabled = !editable;
    applyBtn.disabled = !editable;
    seedInput.hidden = modeSelect.value !== 'S3';
    startBtn.hidden = !isHost;
    startBtn.disabled = !canStartMatch(isHost, state.phase, state.players);
    readyBtn.hidden = state.phase !== 'LOBBY';
    readyBtn.disabled = me?.ready === true || state.phase !== 'LOBBY';
    readyBtn.textContent = me?.ready === true ? '已准备' : '准备';
  }

  function update(state: RoomStateMsg): void {
    latest = state;
    codeValue.textContent = state.roomCode;
    phaseNode.textContent = phaseLabel(state.phase, state.startAt, state.serverTime);
    renderSeats(state.players);
    // 表单回填服务端权威值（非房主只读展示；房主仅在未编辑时同步）。
    if (doc.activeElement === null || !settings.contains(doc.activeElement)) {
      capacitySelect.value = String(state.settings.capacity);
      modeSelect.value = state.settings.randomMode;
      levelSelect.value = String(state.settings.startLevel);
      if (state.settings.customSeed !== undefined) seedInput.value = state.settings.customSeed;
    }
    syncControls(state);
  }

  copyBtn.addEventListener('click', () => {
    const code = latest?.roomCode ?? '';
    if (code === '') return;
    const done = (): void => showMessage('info', `房间码 ${code} 已复制，分享给好友加入。`);
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText !== undefined) {
      void clipboard.writeText(code).then(done, () => showMessage('info', `复制失败，请手动记下房间码 ${code}。`));
    } else {
      showMessage('info', `复制不可用，请手动记下房间码 ${code}。`);
    }
  });

  applyBtn.addEventListener('click', () => {
    const check = validateSettingsForm({
      capacity: Number(capacitySelect.value),
      randomMode: modeSelect.value as RandomMode,
      customSeed: seedInput.value.trim(),
      startLevel: Number(levelSelect.value),
    });
    if (!check.ok) {
      showMessage('error', check.message);
      return;
    }
    showMessage('info', '设置已提交，等待服务器确认。');
    callbacks.onSettingsUpdate(check.value);
  });

  modeSelect.addEventListener('change', () => {
    seedInput.hidden = modeSelect.value !== 'S3';
  });

  readyBtn.addEventListener('click', () => {
    callbacks.onReady();
  });

  startBtn.addEventListener('click', () => {
    callbacks.onStart();
  });

  leaveBtn.addEventListener('click', () => {
    const me = latest?.players.find((p) => p.playerId === myPlayerId);
    const text =
      me?.isHost === true
        ? '离开将把房主转交给下一位玩家。确定离开房间？'
        : '确定离开房间？';
    if (window.confirm(text)) callbacks.onLeave();
  });

  return { update, showMessage, destroy(): void { panel.remove(); } };
}

/** 房间码复制文案（装配层错误回显复用，单测钉死）。 */
export function copyCodeMessage(code: RoomCode): string {
  return `房间码 ${code} 已复制，分享给好友加入。`;
}
