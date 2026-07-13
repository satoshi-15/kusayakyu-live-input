import * as api from './api.js';
import { subscribeToGame } from './realtime.js';
import { derivePointer, pointerMatchesExpected, isAtBat, deriveScore, deriveRunnersOnBase } from './derive.js';
import { renderConnectionStatus, renderPointer, renderRecentList, renderPendingBadge, renderRunners } from './render.js';
import { RESULT_OPTIONS, findResultOption } from './result-options.js';
import { addLineupRow, collectLineup } from './lineup-editor.js';

const BASE_LABELS = { first: '一塁', second: '二塁', third: '三塁' };
// 走者の現在の塁から見て、まだ進める先の塁一覧(生還は別選択肢のため含まない)。
const ADVANCE_TARGETS = { first: ['second', 'third'], second: ['third'], third: [] };
// 暴投・ボーク・パスボールで走者が進む1つ先の塁(三塁走者は生還=home)。
const IMMEDIATE_NEXT = { first: 'second', second: 'third', third: 'home' };

// innerHTMLへ差し込む文字列をエスケープする(相手打者名・相手投手名は自由入力のためXSS対策必須)。
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
  runnersBox: document.getElementById('runners-box'),
  offenseFields: document.getElementById('offense-fields'),
  defenseFields: document.getElementById('defense-fields'),
  batterSelect: document.getElementById('batter-select'),
  batterOtherLabel: document.getElementById('batter-other-label'),
  batterOtherInput: document.getElementById('batter-other-input'),
  runnersScoredBox: document.getElementById('runners-scored-box'),
  runnersScoredList: document.getElementById('runners-scored-list'),
  batterFcBox: document.getElementById('batter-fc-box'),
  pitcherSelect: document.getElementById('pitcher-select'),
  opponentBatterName: document.getElementById('opponent-batter-name'),
  resultSelect: document.getElementById('result-select'),
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
  pitchingOnlyButtons: document.querySelectorAll('.pitching-only'),
  trackPitchingToggle: document.getElementById('track-pitching-toggle'),
  defenseSimple: document.getElementById('defense-simple'),
  simpleOutBtn: document.getElementById('simple-out-btn'),
  simpleReachBtn: document.getElementById('simple-reach-btn'),
  simpleScoredCheckbox: document.getElementById('simple-scored-checkbox'),
  lineupEditToggleBtn: document.getElementById('lineup-edit-toggle-btn'),
  lineupEditBox: document.getElementById('lineup-edit-box'),
  lineupEditRows: document.getElementById('lineup-edit-rows'),
  lineupEditAddRow: document.getElementById('lineup-edit-add-row'),
  lineupEditCancel: document.getElementById('lineup-edit-cancel'),
  lineupEditSave: document.getElementById('lineup-edit-save'),
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

// 塁に出ている走者が複数いる場合、選手ID手入力の代わりにドロップダウンで選ばせる。
// atbatId(打席id)をvalueにする: 相手走者はbatterIdが全員"opponent"で一意にならないため。
// 選ばれた走者オブジェクト(またはnull)をresolveする。
function selectRunnerModal(runners) {
  return new Promise((resolve) => {
    els.modalMessage.textContent = '走者を選択してください';
    const select = document.createElement('select');
    for (const r of runners) {
      const name = runnerDisplayName(r);
      const opt = document.createElement('option');
      opt.value = String(r.atbatId);
      opt.textContent = `${r.orderNo ?? ''}番 ${name}(${BASE_LABELS[r.base] || ''})`;
      select.appendChild(opt);
    }
    els.modalMessage.appendChild(select);
    els.modalOverlay.classList.remove('hidden');
    const cleanup = (atbatId) => {
      els.modalOverlay.classList.add('hidden');
      select.remove();
      resolve(atbatId ? runners.find((r) => r.atbatId === Number(atbatId)) : null);
    };
    els.modalConfirm.onclick = () => cleanup(select.value);
    els.modalCancel.onclick = () => cleanup(null);
  });
}

// ボークは走者全員が確定で1つ先の塁(三塁走者は生還)へ進むルールのため、個別選択はさせず確認だけ取る。
// runnersが空ならそもそも確認不要([]を返す。投手成績としてのボーク自体は記録する)。
// キャンセル時はnullを返し、呼び出し側で送信全体を中止する。
async function confirmForcedAdvance(runners) {
  if (runners.length === 0) return [];
  const summary = runners
    .map((r) => {
      const to = IMMEDIATE_NEXT[r.base];
      const toText = to === 'home' ? '生還' : `${BASE_LABELS[to]}へ進塁`;
      return `${r.orderNo ?? ''}番 ${runnerDisplayName(r)}(${BASE_LABELS[r.base]}) → ${toText}`;
    })
    .join(' / ');
  const ok = await confirmModal(`走者は全員1つ先の塁へ進むものとして記録します。よろしいですか? ${summary}`);
  if (!ok) return null;
  return runners.map((r) => ({
    atbatId: r.atbatId,
    toBase: IMMEDIATE_NEXT[r.base],
    runnerId: r.batterId === 'opponent' ? (r.opponentBatterName || null) : r.batterId,
  }));
}

// 暴投・パスボールは走者ごとに結果が分かれうる(例: 1・3塁で暴投→1塁走者だけ進塁、3塁走者はそのまま)。
// そのため走者ごとに「そのまま/進塁」を選ばせる(デフォルトは進塁)。runnersが空なら呼ばない前提。
// キャンセル時はnull、走者全員「そのまま」を選んだ場合も呼び出し側で「進塁なし=何も記録しない」と扱う。
function selectAdvanceModal(runners) {
  return new Promise((resolve) => {
    const rowsHtml = runners.map((r) => {
      const to = IMMEDIATE_NEXT[r.base];
      const toText = to === 'home' ? '生還' : `${BASE_LABELS[to]}へ進塁`;
      const name = escapeHtml(runnerDisplayName(r));
      const groupName = `advmodal-${r.atbatId}`;
      return `
        <div class="runner-row">
          <span>${r.orderNo ?? ''}番 ${name}(${BASE_LABELS[r.base]})</span>
          <label><input type="radio" name="${groupName}" value="none" style="display:inline-block;width:auto;" /> そのまま</label>
          <label><input type="radio" name="${groupName}" value="advance" checked style="display:inline-block;width:auto;" /> ${toText}</label>
        </div>`;
    }).join('');
    els.modalMessage.innerHTML = '<p class="field-hint">進塁した走者を選択してください</p>' + rowsHtml;
    els.modalOverlay.classList.remove('hidden');
    const cleanup = (apply) => {
      els.modalOverlay.classList.add('hidden');
      if (!apply) { resolve(null); return; }
      const moves = [];
      for (const r of runners) {
        const checked = els.modalMessage.querySelector(`input[name="advmodal-${r.atbatId}"]:checked`);
        if (checked && checked.value === 'advance') {
          moves.push({
            atbatId: r.atbatId,
            toBase: IMMEDIATE_NEXT[r.base],
            runnerId: r.batterId === 'opponent' ? (r.opponentBatterName || null) : r.batterId,
          });
        }
      }
      resolve(moves);
    };
    els.modalConfirm.onclick = () => cleanup(true);
    els.modalCancel.onclick = () => cleanup(false);
  });
}

function populateSelects() {
  const lineup = state.game.lineup || [];
  els.batterSelect.innerHTML = lineup
    .map((r) => `<option value="${r.batter_id}">${r.order_no}番 ${state.playersById.get(r.batter_id)?.display_name || r.batter_id}${r.position ? '(' + r.position + ')' : ''}</option>`)
    .join('') + '<option value="__other__">その他(自由入力)</option>';

  els.pitcherSelect.innerHTML = state.players
    .map((p) => `<option value="${p.id}">${p.display_name}</option>`)
    .join('');

  const groups = new Map();
  for (const opt of RESULT_OPTIONS) {
    if (!groups.has(opt.group)) groups.set(opt.group, []);
    groups.get(opt.group).push(opt);
  }
  els.resultSelect.innerHTML = [...groups.entries()]
    .map(([group, opts]) => `<optgroup label="${group}">${opts.map((o) => `<option value="${o.label}">${o.shortLabel || o.label}</option>`).join('')}</optgroup>`)
    .join('');
}

els.batterSelect.addEventListener('change', () => {
  els.batterOtherLabel.classList.toggle('hidden', els.batterSelect.value !== '__other__');
  renderRunnersScoredCheckboxes();
});

// 打者の結果が「セカンドゴロ」等(groundout/flyout)で、かつ走者を「アウト」にした場合のみ、
// 「打者はどうなったか(併殺=打者もアウト / 野選=打者はセーフ)」を追加で確認する必要がある。
function isFcEligibleResult(result) {
  return result === 'groundout' || result === 'flyout';
}

function fcApplicable() {
  if (!currentPointer) return false;
  const opt = findResultOption(els.resultSelect.value);
  if (!opt || !isFcEligibleResult(opt.result)) return false;
  return !!els.runnersScoredList.querySelector('input[type="radio"][value="out"]:checked');
}

// 「セーフ(野選)」時はrules/集計ルール.md 5節により打点0固定とし、入力欄も編集不可にする。
function syncBatterFcState() {
  const applicable = fcApplicable();
  els.batterFcBox.classList.toggle('hidden', !applicable);
  if (!applicable) {
    els.rbiInput.disabled = false;
    const outRadio = els.batterFcBox.querySelector('input[value="out"]');
    if (outRadio) outRadio.checked = true;
    return;
  }
  const safe = els.batterFcBox.querySelector('input[name="batter-fc"]:checked')?.value === 'safe';
  els.rbiInput.disabled = safe;
  if (safe) els.rbiInput.value = 0;
}

function runnerDisplayName(r) {
  if (r.batterId !== 'opponent') return state.playersById.get(r.batterId)?.display_name || r.batterId;
  return r.opponentBatterName || '相手打者';
}

// 四球・死球の場合、塁が埋まっていて押し出しになる走者の atbatId -> デフォルト選択値 を返す
// ('advance:second'/'advance:third'/'scored')。最終確定はスコアラーがボタンを押すまで行われない。
function computeForcedDefaults(result, runners) {
  const forced = new Map();
  if (result !== 'walk' && result !== 'hbp') return forced;
  const occupied = new Set(runners.map((r) => r.base));
  for (const r of runners) {
    if (r.base === 'first') {
      forced.set(r.atbatId, 'advance:second');
    } else if (r.base === 'second' && occupied.has('first')) {
      forced.set(r.atbatId, 'advance:third');
    } else if (r.base === 'third' && occupied.has('first') && occupied.has('second')) {
      forced.set(r.atbatId, 'scored');
    }
  }
  return forced;
}

// 現在の打席の打者以外の走者一覧を、走者ごとに「そのまま/進塁(塁ごと)/生還/アウト」で出す
// (例: A選手のヒットで既に塁に出ていたB選手がホームインした場合、両方を同時に記録できる。
// アウトを選んだ場合は走塁死と同じ、進塁を選んだ場合は盗塁と同じ仕組みでlive_eventsに記録される)。
// 攻撃側・守備側どちらでも同じ仕組みで動く(走者は打席idで識別するため相手選手にも使える)。
function renderRunnersScoredCheckboxes() {
  if (!currentPointer || currentPointer.side == null) {
    els.runnersScoredBox.classList.add('hidden');
    els.batterFcBox.classList.add('hidden');
    return;
  }
  const isOffense = currentPointer.side === 'offense';
  let runners = deriveRunnersOnBase(state.game, state.atbats, state.events);
  if (isOffense) runners = runners.filter((r) => r.batterId !== els.batterSelect.value);

  els.runnersScoredBox.classList.toggle('hidden', runners.length === 0);
  const opt = findResultOption(els.resultSelect.value);
  const forcedDefaults = computeForcedDefaults(opt?.result, runners);
  els.runnersScoredList.innerHTML = runners.map((r) => {
    const name = escapeHtml(runnerDisplayName(r));
    const baseLabel = BASE_LABELS[r.base] || '';
    const groupName = `runner-${r.atbatId}`;
    const forcedValue = forcedDefaults.get(r.atbatId);
    const advanceOptions = (ADVANCE_TARGETS[r.base] || [])
      .map((base) => {
        const value = `advance:${base}`;
        const checked = forcedValue === value ? 'checked' : '';
        return `<label><input type="radio" name="${groupName}" value="${value}" ${checked} style="display:inline-block;width:auto;" /> ${BASE_LABELS[base]}へ進塁</label>`;
      })
      .join('');
    return `
      <div class="runner-row">
        <span>${r.orderNo ?? ''}番 ${name}(${baseLabel})</span>
        <label><input type="radio" name="${groupName}" value="none" ${forcedValue ? '' : 'checked'} style="display:inline-block;width:auto;" /> そのまま</label>
        ${advanceOptions}
        <label><input type="radio" name="${groupName}" value="scored" ${forcedValue === 'scored' ? 'checked' : ''} style="display:inline-block;width:auto;" /> 生還</label>
        <label><input type="radio" name="${groupName}" value="out" style="display:inline-block;width:auto;" /> アウト</label>
      </div>`;
  }).join('');
  syncBatterFcState();
}

els.runnersScoredList.addEventListener('change', syncBatterFcState);
els.batterFcBox.addEventListener('change', syncBatterFcState);
// 結果が変わるたびに走者一覧を再構築する(四球・死球での強制進塁デフォルトを再計算するため)。
els.resultSelect.addEventListener('change', renderRunnersScoredCheckboxes);

function updateSubmitDisabled() {
  if (!currentPointer || currentPointer.side !== 'defense') {
    els.submitBtn.disabled = false;
    return;
  }
  els.submitBtn.disabled = !els.pitcherSelect.value;
}
els.pitcherSelect.addEventListener('change', updateSubmitDisabled);

function renderTrackPitchingToggle() {
  const on = state.game.track_pitching;
  els.trackPitchingToggle.textContent = `投手成績記録: ${on ? 'ON' : 'OFF'}`;
  els.trackPitchingToggle.classList.toggle('track-pitching-on', on);
  els.trackPitchingToggle.classList.toggle('track-pitching-off', !on);
  // 暴投・ボーク・パスボールは自チームが攻撃中なら相手投手のミスで自チームの走者が動くだけなので、
  // 投手成績記録の設定に関わらず常に使える(pitcher_idは自チーム投手なので不要=nullで送信)。
  // 隠すのは「投手成績記録OFF、かつ自チームが守備中(責任投手を選べない)」の場合のみ。
  const hidePitchingOnly = !on && currentPointer?.side === 'defense';
  for (const btn of els.pitchingOnlyButtons) btn.classList.toggle('hidden', hidePitchingOnly);
}

function updatePointerAndForm() {
  currentPointer = derivePointer(state.game, state.atbats, state.events);
  els.pointerBox.classList.add('highlight');
  setTimeout(() => els.pointerBox.classList.remove('highlight'), 400);
  const runners = deriveRunnersOnBase(state.game, state.atbats, state.events)
    .map((r) => ({ ...r, name: runnerDisplayName(r) }));
  renderPointer(els.pointerBox, currentPointer, state.playersById, deriveScore(state.atbats), runners);
  renderRunners(els.runnersBox, runners);
  renderTrackPitchingToggle();

  if (state.game.status !== 'open') {
    els.form.classList.add('hidden');
    els.defenseSimple.classList.add('hidden');
    return;
  }

  const isOffense = currentPointer.side === 'offense';
  const useSimpleDefense = !isOffense && !state.game.track_pitching;

  els.form.classList.toggle('hidden', useSimpleDefense);
  els.defenseSimple.classList.toggle('hidden', !useSimpleDefense);
  if (useSimpleDefense) return;

  els.offenseFields.classList.toggle('hidden', !isOffense);
  els.defenseFields.classList.toggle('hidden', isOffense);

  if (isOffense && currentPointer.nextBatterId) {
    els.batterSelect.value = currentPointer.nextBatterId;
  }
  if (!isOffense && currentPointer.currentPitcherId) {
    els.pitcherSelect.value = currentPointer.currentPitcherId;
  }
  renderRunnersScoredCheckboxes();
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
  const newLabel = prompt('新しい結果を入力(例: サードゴロ、レフト前ヒット、三振 等)', atbat.detail || '');
  if (!newLabel) return;
  const opt = findResultOption(newLabel);
  if (!opt) { alert(`「${newLabel}」は選択肢にありません(結果セレクトと同じ表記で入力してください)`); return; }
  const ok = await confirmModal('この打席の内容を編集しますか?');
  if (!ok) return;
  await api.editAtbat(atbat.id, accessToken, {
    batterId: atbat.batter_id, orderNo: atbat.order_no, outsBefore: atbat.outs_before,
    result: opt.result, ab: isAtBat(opt.result), hitType: opt.hitType || null, rbi: atbat.rbi,
    scored: atbat.scored, detail: opt.detail, pitcherId: atbat.pitcher_id,
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
    // 暴投・ボーク・パスボールは自チームが守備中(=自チーム投手が原因)の場合のみ責任投手の選択を必須にする。
    // 攻撃中(相手投手が原因)は自チームにpitcher_idを持つ投手がいないため選択させず、nullで送信する。
    const needsPitcher = (type === 'wild_pitch' || type === 'balk' || type === 'passed_ball')
      && currentPointer?.side === 'defense';
    const needsRunner = type === 'stolen_base' || type === 'caught_stealing' || type === 'runner_out_advancing';
    const needsForcedAdvance = type === 'wild_pitch' || type === 'balk' || type === 'passed_ball';
    const pitcherId = needsPitcher ? (els.pitcherSelect.value || currentPointer?.currentPitcherId) : null;
    if (needsPitcher && !pitcherId) { alert('投手を選択してください'); return; }
    let runnerId = null;
    let runnerAtbatId = null;
    let advanceMoves = [];
    if (needsRunner) {
      const runners = deriveRunnersOnBase(state.game, state.atbats, state.events);
      let picked = null;
      if (runners.length === 1) {
        picked = runners[0];
      } else if (runners.length > 1) {
        picked = await selectRunnerModal(runners);
        if (!picked) return;
      } else {
        // 走者一覧が空(データ不整合等)の場合は手入力にフォールバックする
        const guess = els.batterSelect.value !== '__other__' ? els.batterSelect.value : '';
        runnerId = prompt('走者(players.jsonのid)を入力してください', guess);
        if (!runnerId) return;
      }
      if (picked) {
        runnerId = picked.batterId === 'opponent' ? (picked.opponentBatterName || null) : picked.batterId;
        runnerAtbatId = picked.atbatId;
      }
    }
    if (needsForcedAdvance) {
      const runners = deriveRunnersOnBase(state.game, state.atbats, state.events);
      if (type === 'balk') {
        // ボークは走者全員が確定で進塁するため、確認のみ(個別選択なし)。
        advanceMoves = await confirmForcedAdvance(runners);
      } else {
        // 暴投・パスボールは走者ごとに結果が分かれうるため、個別に選択させる。
        advanceMoves = runners.length === 0 ? [] : await selectAdvanceModal(runners);
      }
      if (advanceMoves === null) return; // キャンセル: 何も記録しない
      if (runners.length > 0 && advanceMoves.length === 0) return; // 進塁した走者が誰もいなければ何も記録しない
    }
    try {
      await api.submitEvent(gameId, accessToken, {
        clientUuid: crypto.randomUUID(),
        inning: currentPointer.inning,
        half: currentPointer.half,
        type,
        runnerId,
        runnerAtbatId,
        pitcherId,
        runnerNote: null,
        enteredBy,
      });
      for (const move of advanceMoves) {
        await api.submitEvent(gameId, accessToken, {
          clientUuid: crypto.randomUUID(),
          inning: currentPointer.inning,
          half: currentPointer.half,
          type: 'runner_advance',
          runnerId: move.runnerId,
          runnerAtbatId: move.atbatId,
          toBase: move.toBase,
          pitcherId: null,
          runnerNote: null,
          enteredBy,
        });
      }
    } catch (e) {
      alert(`記録に失敗しました: ${e.message || e}`);
    }
  });
}

// --- 打席フォーム送信(自動リトライ+指数バックオフ) ---
async function submitWithRetry(clientUuid, buildPayload, onSettle) {
  state.pending.set(clientUuid, { status: 'sending', retries: 0 });
  renderPendingBadge(els.pendingBadge, state.pending);

  const attempt = async (retries) => {
    try {
      await api.submitAtbat(gameId, accessToken, buildPayload());
      state.pending.delete(clientUuid);
      renderPendingBadge(els.pendingBadge, state.pending);
      onSettle?.();
    } catch (e) {
      if (retries < 3) {
        setTimeout(() => attempt(retries + 1), 1000 * 2 ** retries);
      } else {
        state.pending.set(clientUuid, { status: 'error', retries, retryFn: () => attempt(0) });
        renderPendingBadge(els.pendingBadge, state.pending);
        onSettle?.();
      }
    }
  };
  attempt(0);
}

// 送信中の連打(二重記録)を防ぐ。対象ボタン群を無効化し、送信が確定(成功/リトライ尽き)したら戻す。
function withDoubleTapGuard(buttons, fn) {
  for (const b of buttons) b.disabled = true;
  const release = () => { for (const b of buttons) b.disabled = false; };
  try {
    fn(release);
  } catch (e) {
    release();
    throw e;
  }
}

els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const isOffense = currentPointer.side === 'offense';
  const enteredBy = els.enteredByInput.value.trim();
  if (!enteredBy) { alert('入力者名を入力してください'); return; }

  if (!pointerMatchesExpected(currentPointer.lastAliveKey, state.atbats, state.events)) {
    alert('他の人が入力しました。最新の状況を確認してから、もう一度お願いします。');
    return;
  }

  const opt = findResultOption(els.resultSelect.value);
  if (!opt) { alert('結果を選択してください'); return; }

  const clientUuid = crypto.randomUUID();
  const batterId = isOffense
    ? (els.batterSelect.value === '__other__' ? els.batterOtherInput.value.trim() : els.batterSelect.value)
    : 'opponent';

  const checkedRunnerRadios = [...els.runnersScoredList.querySelectorAll('input[type="radio"]:checked')];
  const scoredRunnerIds = checkedRunnerRadios
    .filter((el) => el.value === 'scored')
    .map((el) => Number(el.name.replace('runner-', '')));
  const outRunnerIds = checkedRunnerRadios
    .filter((el) => el.value === 'out')
    .map((el) => Number(el.name.replace('runner-', '')));
  const advancedRunnerMoves = checkedRunnerRadios
    .filter((el) => el.value.startsWith('advance:'))
    .map((el) => ({ atbat_id: Number(el.name.replace('runner-', '')), to_base: el.value.replace('advance:', '') }));

  // 打者が「セカンドゴロ」等を選び、走者をアウトにし、かつ「セーフ(野選)」を選んだ場合、
  // 表示上の結果(detail)は変えずに、送信するresultだけをfielders_choiceへ内部的に切り替える
  // (打者自身はアウトにならないため。rules/集計ルール.md 5節参照)。
  let effectiveResult = opt.result;
  let effectiveRbi = Number(els.rbiInput.value) || 0;
  if (!els.batterFcBox.classList.contains('hidden')) {
    const safe = els.batterFcBox.querySelector('input[name="batter-fc"]:checked')?.value === 'safe';
    if (safe) {
      effectiveResult = 'fielders_choice';
      effectiveRbi = 0;
    }
  }

  const payload = {
    clientUuid,
    inning: currentPointer.inning,
    half: currentPointer.half,
    batterId,
    orderNo: isOffense ? currentPointer.nextOrderNo : null,
    outsBefore: currentPointer.outs,
    result: effectiveResult,
    ab: isAtBat(effectiveResult),
    hitType: opt.hitType || null,
    rbi: effectiveRbi,
    scored: els.scoredCheckbox.checked,
    detail: opt.detail,
    pitcherId: isOffense ? null : els.pitcherSelect.value,
    opponentBatterName: isOffense ? null : (els.opponentBatterName.value.trim() || null),
    enteredBy,
    scoredRunnerIds,
    outRunnerIds,
    advancedRunnerMoves,
  };

  withDoubleTapGuard([els.submitBtn], (release) => {
    lastSubmittedClientUuid = clientUuid;
    lastSubmittedAt = Date.now();
    submitWithRetry(clientUuid, () => payload, release);
  });

  els.rbiInput.value = 0;
  els.rbiInput.disabled = false;
  els.scoredCheckbox.checked = false;
  els.opponentBatterName.value = '';
});

els.trackPitchingToggle.addEventListener('click', async () => {
  const ok = await confirmModal(
    `投手成績記録を${state.game.track_pitching ? 'OFF' : 'ON'}に切り替えますか?入力中のフォームがある場合、内容は失われます。`
  );
  if (!ok) return;
  try {
    await api.setTrackPitching(gameId, accessToken, !state.game.track_pitching);
  } catch (e) {
    alert(`切り替えに失敗しました: ${e.message || e}`);
  }
});

// resultは'groundout'(アウト)/'walk'(出塁)の固定値。投手成績OFF時は打球の種類を区別しない設計のため、
// 「最近の入力」欄には常に「ゴロ」「四球」と表示される(実際の打球内容とは無関係)。
function submitSimpleDefense(result, ab) {
  const enteredBy = els.enteredByInput.value.trim();
  if (!enteredBy) { alert('入力者名を入力してください'); return; }
  if (!pointerMatchesExpected(currentPointer.lastAliveKey, state.atbats, state.events)) {
    alert('他の人が入力しました。最新の状況を確認してから、もう一度お願いします。');
    return;
  }
  const clientUuid = crypto.randomUUID();
  const scored = els.simpleScoredCheckbox.checked;
  const payload = {
    clientUuid,
    inning: currentPointer.inning,
    half: currentPointer.half,
    batterId: 'opponent',
    orderNo: null,
    outsBefore: currentPointer.outs,
    result,
    ab,
    hitType: null,
    rbi: 0,
    scored,
    detail: null,
    pitcherId: null,
    opponentBatterName: null,
    enteredBy,
  };
  withDoubleTapGuard([els.simpleOutBtn, els.simpleReachBtn], (release) => {
    lastSubmittedClientUuid = clientUuid;
    lastSubmittedAt = Date.now();
    submitWithRetry(clientUuid, () => payload, release);
  });
  els.simpleScoredCheckbox.checked = false;
}

els.simpleOutBtn.addEventListener('click', () => submitSimpleDefense('groundout', true));
els.simpleReachBtn.addEventListener('click', () => submitSimpleDefense('walk', false));

// --- オーダー編集 ---
els.lineupEditToggleBtn.addEventListener('click', () => {
  const opening = els.lineupEditBox.classList.contains('hidden');
  if (!opening) {
    els.lineupEditBox.classList.add('hidden');
    return;
  }
  els.lineupEditRows.innerHTML = '';
  const lineup = state.game.lineup || [];
  const rowCount = Math.max(lineup.length, 9);
  for (let i = 1; i <= rowCount; i++) {
    const prefill = lineup.find((r) => r.order_no === i) || null;
    addLineupRow(els.lineupEditRows, i, state.players, prefill);
  }
  els.lineupEditBox.classList.remove('hidden');
});

els.lineupEditAddRow.addEventListener('click', () => {
  const nextOrder = els.lineupEditRows.querySelectorAll('[data-role="batter"]').length + 1;
  addLineupRow(els.lineupEditRows, nextOrder, state.players);
});

els.lineupEditCancel.addEventListener('click', () => {
  els.lineupEditBox.classList.add('hidden');
});

els.lineupEditSave.addEventListener('click', async () => {
  const lineup = collectLineup(els.lineupEditRows);
  const hasOurAtbats = state.atbats.some((a) => !a.deleted_at && a.batter_id !== 'opponent');
  if (hasOurAtbats) {
    const ok = await confirmModal('既に記録された打席があります。オーダーを変更すると、次の打者の表示がズレる可能性があります。保存しますか?');
    if (!ok) return;
  }
  try {
    await api.updateLineup(gameId, accessToken, lineup);
    els.lineupEditBox.classList.add('hidden');
  } catch (e) {
    alert(`オーダーの保存に失敗しました: ${e.message || e}`);
  }
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
    els.defenseSimple.classList.add('hidden');
    els.closeGameBtn.classList.add('hidden');
    els.trackPitchingToggle.classList.add('hidden');
    document.querySelector('.quick-events').classList.add('hidden');
    return;
  }
  if (!game) {
    els.gameInfo.textContent = '試合が見つかりません。URLを確認してください。';
    els.form.classList.add('hidden');
    els.defenseSimple.classList.add('hidden');
    els.closeGameBtn.classList.add('hidden');
    els.trackPitchingToggle.classList.add('hidden');
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
        els.closeGameBtn.classList.add('hidden');
        els.trackPitchingToggle.classList.add('hidden');
        document.querySelector('.quick-events').classList.add('hidden');
        els.gameInfo.textContent = `${state.game.opponent_name || ''} / 試合終了`;
      }
      // オーダー編集(update_lineup)でlineupが変わった場合に打者セレクトへ反映する。
      populateSelects();
      // track_pitching切り替え・攻守表示等をこの1箇所で再計算する(updatePointerAndFormが単一の情報源)。
      renderAll();
    },
  });

  setInterval(() => {
    const canUndo = lastSubmittedClientUuid && (Date.now() - lastSubmittedAt) < 5000;
    els.undoBtn.classList.toggle('hidden', !canUndo);
  }, 500);
}

init();
