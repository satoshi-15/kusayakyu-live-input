import * as api from './api.js';
import { subscribeToGame } from './realtime.js';
import { derivePointer, pointerMatchesExpected, isAtBat } from './derive.js';
import { renderConnectionStatus, renderPointer, renderRecentList, renderPendingBadge } from './render.js';

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  return { gameId: params.get('game'), token: params.get('token') };
}

const { gameId, token: tokenFromUrl } = parseHash();
const accessToken = tokenFromUrl || (gameId ? localStorage.getItem(`kusayakyu:${gameId}:token`) : null);
if (gameId && accessToken) localStorage.setItem(`kusayakyu:${gameId}:token`, accessToken);

const els = {
  gameInfo: document.getElementById('game-info'),
  connectionStatus: document.getElementById('connection-status'),
  pointerBox: document.getElementById('pointer-box'),
  offenseFields: document.getElementById('offense-fields'),
  defenseFields: document.getElementById('defense-fields'),
  batterSelect: document.getElementById('batter-select'),
  batterOtherLabel: document.getElementById('batter-other-label'),
  batterOtherInput: document.getElementById('batter-other-input'),
  pitcherSelect: document.getElementById('pitcher-select'),
  opponentBatterName: document.getElementById('opponent-batter-name'),
  resultSelect: document.getElementById('result-select'),
  detailInput: document.getElementById('detail-input'),
  rbiInput: document.getElementById('rbi-input'),
  scoredCheckbox: document.getElementById('scored-checkbox'),
  enteredByInput: document.getElementById('entered-by-input'),
  submitBtn: document.getElementById('submit-btn'),
  form: document.getElementById('atbat-form'),
  pendingBadge: document.getElementById('pending-badge'),
  undoBtn: document.getElementById('undo-btn'),
  recentList: document.getElementById('recent-list'),
  closeGameBtn: document.getElementById('close-game-btn'),
  modalOverlay: document.getElementById('modal-overlay'),
  modalMessage: document.getElementById('modal-message'),
  modalCancel: document.getElementById('modal-cancel'),
  modalConfirm: document.getElementById('modal-confirm'),
  quickEventButtons: document.querySelectorAll('.quick-events button'),
};

if (!gameId || !accessToken) {
  els.gameInfo.textContent = '試合が指定されていません。index.htmlから作成してください。';
  els.form.classList.add('hidden');
  throw new Error('missing game/token');
}

const state = {
  game: null,
  players: [],
  playersById: new Map(),
  atbats: [],
  events: [],
  pending: new Map(), // clientUuid -> {status, submitFn, retries}
};

let currentPointer = null;
let lastSubmittedClientUuid = null;
let lastSubmittedAt = 0;

els.enteredByInput.value = localStorage.getItem('kusayakyu:enteredBy') || '';
els.enteredByInput.addEventListener('change', () => {
  localStorage.setItem('kusayakyu:enteredBy', els.enteredByInput.value);
});

function confirmModal(message) {
  return new Promise((resolve) => {
    els.modalMessage.textContent = message;
    els.modalOverlay.classList.remove('hidden');
    els.modalConfirm.onclick = () => { els.modalOverlay.classList.add('hidden'); resolve(true); };
    els.modalCancel.onclick = () => { els.modalOverlay.classList.add('hidden'); resolve(false); };
  });
}

function populateSelects() {
  const lineup = state.game.lineup || [];
  els.batterSelect.innerHTML = lineup
    .map((r) => `<option value="${r.batter_id}">${r.order_no}番 ${state.playersById.get(r.batter_id)?.display_name || r.batter_id}</option>`)
    .join('') + '<option value="__other__">その他(自由入力)</option>';

  els.pitcherSelect.innerHTML = state.players
    .map((p) => `<option value="${p.id}">${p.display_name}</option>`)
    .join('');
}

els.batterSelect.addEventListener('change', () => {
  els.batterOtherLabel.classList.toggle('hidden', els.batterSelect.value !== '__other__');
});

function updateSubmitDisabled() {
  if (!currentPointer || currentPointer.side !== 'defense') {
    els.submitBtn.disabled = false;
    return;
  }
  els.submitBtn.disabled = !els.pitcherSelect.value;
}
els.pitcherSelect.addEventListener('change', updateSubmitDisabled);

function updatePointerAndForm() {
  currentPointer = derivePointer(state.game, state.atbats);
  els.pointerBox.classList.add('highlight');
  setTimeout(() => els.pointerBox.classList.remove('highlight'), 400);
  renderPointer(els.pointerBox, currentPointer, state.playersById);

  const isOffense = currentPointer.side === 'offense';
  els.offenseFields.classList.toggle('hidden', !isOffense);
  els.defenseFields.classList.toggle('hidden', isOffense);

  if (isOffense && currentPointer.nextBatterId) {
    els.batterSelect.value = currentPointer.nextBatterId;
  }
  if (!isOffense && currentPointer.currentPitcherId) {
    els.pitcherSelect.value = currentPointer.currentPitcherId;
  }
  updateSubmitDisabled();
}

function renderAll() {
  renderRecentList(els.recentList, state.atbats, state.events, state.playersById, {
    onEditAtbat: handleEditAtbat,
    onDeleteAtbat: (a) => handleDeleteAtbat(a, false),
    onDeleteEvent: handleDeleteEvent,
  });
  renderPendingBadge(els.pendingBadge, state.pending);
  updatePointerAndForm();

  const canUndo = lastSubmittedClientUuid && (Date.now() - lastSubmittedAt) < 5000;
  els.undoBtn.classList.toggle('hidden', !canUndo);
}

async function handleDeleteAtbat(atbat, skipConfirm) {
  const isRecent = lastSubmittedClientUuid && atbat.client_uuid === lastSubmittedClientUuid && (Date.now() - lastSubmittedAt) < 5000;
  if (!skipConfirm && !isRecent) {
    const ok = await confirmModal('この打席の記録を取り消しますか?');
    if (!ok) return;
  }
  const deletedBy = els.enteredByInput.value.trim() || '(不明)';
  await api.softDeleteAtbat(atbat.id, accessToken, deletedBy);
}

async function handleEditAtbat(atbat) {
  const newResult = prompt('新しい結果コードを入力(例: single, groundout, strikeout 等)', atbat.result);
  if (!newResult) return;
  const ok = await confirmModal('この打席の内容を編集しますか?');
  if (!ok) return;
  await api.editAtbat(atbat.id, accessToken, {
    batterId: atbat.batter_id, orderNo: atbat.order_no, outsBefore: atbat.outs_before,
    result: newResult, ab: isAtBat(newResult), hitType: atbat.hit_type, rbi: atbat.rbi,
    scored: atbat.scored, detail: atbat.detail, pitcherId: atbat.pitcher_id,
    opponentBatterName: atbat.opponent_batter_name,
  });
}

async function handleDeleteEvent(event) {
  const ok = await confirmModal('このイベントを取り消しますか?');
  if (!ok) return;
  const deletedBy = els.enteredByInput.value.trim() || '(不明)';
  await api.softDeleteEvent(event.id, accessToken, deletedBy);
}

// 送信失敗中はバッジをタップすると手動リトライ(自動リトライが尽きた場合のみ表示される)。
els.pendingBadge.addEventListener('click', () => {
  for (const [clientUuid, info] of state.pending) {
    if (info.status === 'error' && info.retryFn) {
      state.pending.set(clientUuid, { status: 'sending', retries: 0 });
      info.retryFn();
    }
  }
  renderPendingBadge(els.pendingBadge, state.pending);
});

els.undoBtn.addEventListener('click', async () => {
  const deletedBy = els.enteredByInput.value.trim() || '(不明)';
  await api.undoLastAtbat(gameId, accessToken, deletedBy);
  lastSubmittedClientUuid = null;
});

// --- クイックイベント ---
for (const btn of els.quickEventButtons) {
  btn.addEventListener('click', async () => {
    const enteredBy = els.enteredByInput.value.trim();
    if (!enteredBy) { alert('入力者名を入力してください'); return; }
    const type = btn.dataset.event;
    const needsPitcher = type === 'wild_pitch' || type === 'balk';
    const needsRunner = type === 'stolen_base' || type === 'caught_stealing';
    const pitcherId = needsPitcher ? (els.pitcherSelect.value || currentPointer?.currentPitcherId) : null;
    if (needsPitcher && !pitcherId) { alert('投手を選択してください'); return; }
    let runnerId = null;
    if (needsRunner) {
      const guess = els.batterSelect.value !== '__other__' ? els.batterSelect.value : '';
      runnerId = prompt('走者(players.jsonのid)を入力してください', guess);
      if (!runnerId) return;
    }
    try {
      await api.submitEvent(gameId, accessToken, {
        clientUuid: crypto.randomUUID(),
        inning: currentPointer.inning,
        half: currentPointer.half,
        type,
        runnerId,
        pitcherId,
        runnerNote: null,
        enteredBy,
      });
    } catch (e) {
      alert(`記録に失敗しました: ${e.message || e}`);
    }
  });
}

// --- 打席フォーム送信(自動リトライ+指数バックオフ) ---
async function submitWithRetry(clientUuid, buildPayload) {
  state.pending.set(clientUuid, { status: 'sending', retries: 0 });
  renderPendingBadge(els.pendingBadge, state.pending);

  const attempt = async (retries) => {
    try {
      await api.submitAtbat(gameId, accessToken, buildPayload());
      state.pending.delete(clientUuid);
      renderPendingBadge(els.pendingBadge, state.pending);
    } catch (e) {
      if (retries < 3) {
        setTimeout(() => attempt(retries + 1), 1000 * 2 ** retries);
      } else {
        state.pending.set(clientUuid, { status: 'error', retries, retryFn: () => attempt(0) });
        renderPendingBadge(els.pendingBadge, state.pending);
      }
    }
  };
  attempt(0);
}

els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const isOffense = currentPointer.side === 'offense';
  const enteredBy = els.enteredByInput.value.trim();
  if (!enteredBy) { alert('入力者名を入力してください'); return; }

  if (!pointerMatchesExpected(currentPointer.lastAliveId, state.atbats)) {
    alert('他の人が入力しました。最新の状況を確認してから、もう一度お願いします。');
    return;
  }

  const clientUuid = crypto.randomUUID();
  const result = els.resultSelect.value;
  const batterId = isOffense
    ? (els.batterSelect.value === '__other__' ? els.batterOtherInput.value.trim() : els.batterSelect.value)
    : 'opponent';

  const payload = {
    clientUuid,
    inning: currentPointer.inning,
    half: currentPointer.half,
    batterId,
    orderNo: isOffense ? currentPointer.nextOrderNo : null,
    outsBefore: currentPointer.outs,
    result,
    ab: isAtBat(result),
    hitType: ['single', 'double', 'triple', 'home_run'].includes(result) ? result : null,
    rbi: Number(els.rbiInput.value) || 0,
    scored: els.scoredCheckbox.checked,
    detail: els.detailInput.value.trim() || null,
    pitcherId: isOffense ? null : els.pitcherSelect.value,
    opponentBatterName: isOffense ? null : (els.opponentBatterName.value.trim() || null),
    enteredBy,
  };

  lastSubmittedClientUuid = clientUuid;
  lastSubmittedAt = Date.now();
  submitWithRetry(clientUuid, () => payload);

  els.rbiInput.value = 0;
  els.scoredCheckbox.checked = false;
  els.detailInput.value = '';
  els.opponentBatterName.value = '';
});

els.closeGameBtn.addEventListener('click', async () => {
  const ok = await confirmModal('試合を終了します。以降は入力できなくなります。よろしいですか?');
  if (!ok) return;
  await api.closeGame(gameId, accessToken);
});

// --- 初期化 ---
async function init() {
  renderConnectionStatus(els.connectionStatus, 'connecting');
  let game, players, atbats, events;
  try {
    [game, players, atbats, events] = await Promise.all([
      api.fetchGame(gameId),
      api.fetchPlayers(),
      api.fetchAllAtbats(gameId),
      api.fetchAllEvents(gameId),
    ]);
  } catch (e) {
    els.gameInfo.textContent = `読み込みに失敗しました: ${e.message || e}`;
    els.form.classList.add('hidden');
    els.closeGameBtn.classList.add('hidden');
    document.querySelector('.quick-events').classList.add('hidden');
    return;
  }
  if (!game) {
    els.gameInfo.textContent = '試合が見つかりません。URLを確認してください。';
    els.form.classList.add('hidden');
    els.closeGameBtn.classList.add('hidden');
    document.querySelector('.quick-events').classList.add('hidden');
    return;
  }
  state.game = game;
  state.players = players;
  state.playersById = new Map(players.map((p) => [p.id, p]));
  state.atbats = atbats;
  state.events = events;

  els.gameInfo.textContent = `${game.opponent_name || '(相手未設定)'} / ${game.game_date || ''} / ${game.status === 'closed' ? '試合終了' : '試合中'}`;
  if (game.status !== 'open') {
    els.form.classList.add('hidden');
    els.closeGameBtn.classList.add('hidden');
    document.querySelector('.quick-events').classList.add('hidden');
  }

  populateSelects();
  renderAll();

  subscribeToGame(gameId, {
    onStatusChange: (status) => renderConnectionStatus(els.connectionStatus, status),
    onRefetch: ({ atbats: a, events: e }) => {
      state.atbats = a;
      state.events = e;
      renderAll();
    },
    onAtbatsChange: (payload) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      const idx = state.atbats.findIndex((x) => x.id === row.id);
      if (payload.eventType === 'DELETE') {
        if (idx >= 0) state.atbats.splice(idx, 1);
      } else if (idx >= 0) {
        state.atbats[idx] = payload.new;
      } else {
        state.atbats.push(payload.new);
      }
      renderAll();
    },
    onEventsChange: (payload) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      const idx = state.events.findIndex((x) => x.id === row.id);
      if (payload.eventType === 'DELETE') {
        if (idx >= 0) state.events.splice(idx, 1);
      } else if (idx >= 0) {
        state.events[idx] = payload.new;
      } else {
        state.events.push(payload.new);
      }
      renderAll();
    },
    onGameChange: (payload) => {
      state.game = payload.new;
      if (state.game.status !== 'open') {
        els.form.classList.add('hidden');
        els.closeGameBtn.classList.add('hidden');
        document.querySelector('.quick-events').classList.add('hidden');
        els.gameInfo.textContent = `${state.game.opponent_name || ''} / 試合終了`;
      }
    },
  });

  setInterval(() => {
    const canUndo = lastSubmittedClientUuid && (Date.now() - lastSubmittedAt) < 5000;
    els.undoBtn.classList.toggle('hidden', !canUndo);
  }, 500);
}

init();
