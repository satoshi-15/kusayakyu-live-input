import * as api from './api.js';
import { subscribeToGame } from './realtime.js';
import { derivePointer, pointerMatchesExpected, isAtBat, deriveScore, deriveRunnersOnBase, deriveRunnersOnBaseBefore } from './derive.js';
import { renderConnectionStatus, renderPointer, renderRecentList, renderPendingBadge, renderPresence } from './render.js';
import { RESULT_OPTIONS, findResultOption, findResultOptionForAtbat } from './result-options.js';
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

// idで検索し、あれば上書き・無ければ追加する(realtimeのfind-or-pushと、送信成功直後の
// 楽観的ローカル反映の両方で使う共通ヘルパー)。
function upsertLocal(list, row) {
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx >= 0) list[idx] = row; else list.push(row);
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  return { gameId: params.get('game'), token: params.get('token') };
}

const { gameId, token: tokenFromUrl } = parseHash();
const accessToken = tokenFromUrl || (gameId ? localStorage.getItem(`kusayakyu:${gameId}:token`) : null);
if (gameId && accessToken) localStorage.setItem(`kusayakyu:${gameId}:token`, accessToken);

// オフラインキューの永続化: 送信中(sending)または送信失敗中(error)のリクエストをlocalStorageにも
// 保持し、リロードしても再送を再開できるようにする(state.pendingはメモリのみのため消えてしまう)。
// client_uuidによるベキ等リトライが既にあるため、実は成功済みのものを再送しても副作用は二重に
// ならない(submit_atbat/submit_eventのon conflict do nothing + v_is_newガードで安全)。
const QUEUE_KEY = `kusayakyu:${gameId}:queue`;

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
}
function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}
function addToQueue(kind, payload) {
  const queue = loadQueue();
  if (queue.some((q) => q.payload.clientUuid === payload.clientUuid)) return;
  queue.push({ kind, payload });
  saveQueue(queue);
}
function removeFromQueue(clientUuid) {
  saveQueue(loadQueue().filter((q) => q.payload.clientUuid !== clientUuid));
}

const els = {
  gameInfo: document.getElementById('game-info'),
  connectionStatus: document.getElementById('connection-status'),
  presenceBadge: document.getElementById('presence-badge'),
  pointerBox: document.getElementById('pointer-box'),
  offenseFields: document.getElementById('offense-fields'),
  defenseFields: document.getElementById('defense-fields'),
  batterSelect: document.getElementById('batter-select'),
  batterOtherLabel: document.getElementById('batter-other-label'),
  batterOtherInput: document.getElementById('batter-other-input'),
  batterOtherRegisterBtn: document.getElementById('batter-other-register-btn'),
  runnersScoredBox: document.getElementById('runners-scored-box'),
  runnersScoredList: document.getElementById('runners-scored-list'),
  batterAdvanceBox: document.getElementById('batter-advance-box'),
  batterFcBox: document.getElementById('batter-fc-box'),
  sacFlyBox: document.getElementById('sac-fly-box'),
  pitcherSelect: document.getElementById('pitcher-select'),
  opponentBatterName: document.getElementById('opponent-batter-name'),
  resultSelect: document.getElementById('result-select'),
  rbiInput: document.getElementById('rbi-input'),
  scoredCheckbox: document.getElementById('scored-checkbox'),
  scoredCheckboxLabel: document.getElementById('scored-checkbox-label'),
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
  editModeBanner: document.getElementById('edit-mode-banner'),
  editModeCancelBtn: document.getElementById('edit-mode-cancel-btn'),
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
let realtimeHandle = null;
// null=通常の新規入力モード。打席オブジェクトが入っていれば、その打席を編集中
// (この間、updatePointerAndFormはフォームに触れず、pointer-boxの表示更新のみ行う)。
let editingAtbat = null;

els.enteredByInput.value = localStorage.getItem('kusayakyu:enteredBy') || '';
els.enteredByInput.addEventListener('change', () => {
  localStorage.setItem('kusayakyu:enteredBy', els.enteredByInput.value);
  realtimeHandle?.updatePresence({ enteredBy: els.enteredByInput.value.trim() || null });
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
  if (editingAtbat) {
    renderEditRunnersBox(editingAtbat);
    return;
  }
  renderRunnersScoredCheckboxes();
});

// 代打等でその場に居ない選手が打席に入る場合、自由入力の生文字列をそのままbatter_idにせず、
// players.jsonへの正規登録(add_guest_player RPC)を経由する(試合20260719でここが原因の
// データ不整合が発生したため)。登録成功後は打者セレクトに選択肢として追加し、その場で選択状態にする。
els.batterOtherRegisterBtn.addEventListener('click', async () => {
  const displayName = els.batterOtherInput.value.trim();
  if (!displayName) { alert('表示名を入力してください'); return; }
  els.batterOtherRegisterBtn.disabled = true;
  try {
    const id = `guest_${crypto.randomUUID().slice(0, 8)}`;
    const player = await api.addGuestPlayer(id, displayName);
    state.players.push(player);
    state.playersById.set(player.id, player);
    const opt = document.createElement('option');
    opt.value = player.id;
    opt.textContent = player.display_name;
    els.batterSelect.insertBefore(opt, els.batterSelect.querySelector('option[value="__other__"]'));
    els.batterSelect.value = player.id;
    els.batterOtherLabel.classList.add('hidden');
    els.batterOtherInput.value = '';
    if (editingAtbat) renderEditRunnersBox(editingAtbat);
    else renderRunnersScoredCheckboxes();
  } catch (e) {
    alert(`助っ人の登録に失敗しました: ${e.message || e}`);
  } finally {
    els.batterOtherRegisterBtn.disabled = false;
  }
});

// 打者の結果が「セカンドゴロ」等(groundout)で、かつ走者を「アウト」にした場合のみ、
// 「打者はどうなったか(併殺=打者もアウト / 野選=打者はセーフ)」を追加で確認する必要がある。
// 捕球されたフライで打者がセーフになるケースは実在しないため、flyoutはFCの対象にしない
// (捕球されたフライは常に打者アウトが確定しており、野手が「選ぶ」余地が無いため)。
function isFcEligibleResult(result) {
  return result === 'groundout';
}

function fcApplicable() {
  if (!currentPointer) return false;
  const opt = findResultOption(els.resultSelect.value);
  if (!opt || !isFcEligibleResult(opt.result)) return false;
  return !!els.runnersScoredList.querySelector('input[type="radio"][value="out"]:checked');
}

// FC(併殺・野選いずれも)はrules/集計ルール.md 5節により打点0固定とし、入力欄も編集不可にする
// (併殺で打者もアウトになる場合・野選で打者がセーフになる場合のどちらも同じく打点無し)。
function syncBatterFcState() {
  // 編集モード中はenterEditModeが元のresultから直接ボックスの表示を制御するため、
  // fcApplicable()(currentPointerという「今」の状況が前提)による再判定・上書きをしない。
  if (editingAtbat) return;
  const applicable = fcApplicable();
  els.batterFcBox.classList.toggle('hidden', !applicable);
  els.rbiInput.disabled = applicable;
  if (!applicable) {
    const outRadio = els.batterFcBox.querySelector('input[value="out"]');
    if (outRadio) outRadio.checked = true;
    return;
  }
  els.rbiInput.value = 0;
}

// 打点を自動計上しない結果(常に0固定): エラーで出塁(相手の失策では打点を付与しない)、
// 野選(直接選択された場合。groundout+FCボックス経由の場合はsyncBatterFcStateのdisabledで別途0固定済み)、
// 三振・振り逃げ(打者が打撃で走者を還したわけではないため、同時に走者が生還してもRBIは付かない)。
const NO_RBI_RESULTS = new Set(['reached_on_error', 'fielders_choice', 'strikeout', 'strikeout_reached']);

// 生還にチェックが入った走者の数(+本塁打で打者自身が生還した場合の1点)を打点のデフォルト値
// として反映する。あくまでデフォルトであり、送信ボタンを押すまで人間が手動で上書きできる。
// FC(併殺/野選)で打点0固定の場合は何もしない(syncBatterFcStateの判断を尊重する)。
function updateRbiDefault() {
  if (els.rbiInput.disabled) return;
  const opt = findResultOption(els.resultSelect.value);
  if (opt && NO_RBI_RESULTS.has(opt.result)) {
    els.rbiInput.value = 0;
    return;
  }
  const scoredCount = els.runnersScoredList.querySelectorAll('input[type="radio"][value="scored"]:checked').length;
  const batterOwnRbi = (opt?.result === 'home_run' && els.scoredCheckbox.checked) ? 1 : 0;
  els.rbiInput.value = scoredCount + batterOwnRbi;
}

// 犠飛(0/1アウト・外野フライ・三塁走者が同じプレーで生還)かどうかを判定する。
function sacFlyApplicable() {
  if (!currentPointer || currentPointer.outs == null || currentPointer.outs >= 2) return false;
  const opt = findResultOption(els.resultSelect.value);
  if (!opt || opt.result !== 'flyout') return false;
  const scoredAtbatIds = new Set(
    [...els.runnersScoredList.querySelectorAll('input[type="radio"][value="scored"]:checked')]
      .map((el) => Number(el.name.replace('runner-', '')))
  );
  if (scoredAtbatIds.size === 0) return false;
  const runners = deriveRunnersOnBase(state.game, state.atbats, state.events);
  return runners.some((r) => r.base === 'third' && scoredAtbatIds.has(r.atbatId));
}

function syncSacFlyState() {
  // syncBatterFcStateと同じ理由で、編集モード中はenterEditModeの直接制御を尊重する。
  if (editingAtbat) return;
  const applicable = sacFlyApplicable();
  els.sacFlyBox.classList.toggle('hidden', !applicable);
  if (!applicable) {
    const yesRadio = els.sacFlyBox.querySelector('input[value="yes"]');
    if (yesRadio) yesRadio.checked = true; // 次回表示時のためデフォルトに戻しておく
  }
}

function runnerDisplayName(r) {
  if (r.batterId !== 'opponent') return state.playersById.get(r.batterId)?.display_name || r.batterId;
  return r.opponentBatterName || '相手打者';
}

// 三塁打・本塁打は常に全走者が生還する(打球が深く、走者間の衝突が発生しないため)。
const HIT_ADVANCE_DEFAULT = {
  triple: { first: 'scored', second: 'scored', third: 'scored' },
  home_run: { first: 'scored', second: 'scored', third: 'scored' },
};

// 二塁打: 一塁走者は三塁までほぼ確実に進む。二塁走者は、一塁に後続走者がいなければ
// 三塁止まりが妥当なデフォルトだが、一塁も埋まっている(後続の一塁走者も三塁を目指す)
// 場合は三塁で衝突するため二塁走者は生還がデフォルトになる(塁が「詰まっている」場合は
// 打数分確実に進む、という実運用フィードバックを反映)。三塁走者は常に生還。
function doubleAdvanceDefault(base, occupied) {
  if (base === 'first') return 'advance:third';
  if (base === 'third') return 'scored';
  if (base === 'second') return occupied.has('first') ? 'scored' : 'advance:third';
  return null;
}

// 走者ごとのデフォルト選択値('advance:second'/'advance:third'/'scored')を返す。
// 最終確定はスコアラーがボタンを押すまで行われず、あくまで初期選択のデフォルトに過ぎない。
function computeForcedDefaults(result, runners) {
  const forced = new Map();

  // 四球・死球・単打・エラー出塁: 打者が一塁を占有することで、そこに先客がいれば連鎖的に
  // 押し出される(単打等でも「打者が一塁に生きる」こと自体は確定するため、四球と同じ
  // 押し出しロジックがそのまま成り立つ)。野選(fielders_choice)は既存のbatter-fc-box/
  // runnersScoredListの「アウト」選択で個別に扱うため、ここでは対象外にする。
  if (result === 'walk' || result === 'hbp' || result === 'single' || result === 'reached_on_error') {
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

  if (result === 'double') {
    const occupied = new Set(runners.map((r) => r.base));
    for (const r of runners) {
      const value = doubleAdvanceDefault(r.base, occupied);
      if (value) forced.set(r.atbatId, value);
    }
    return forced;
  }

  const hitDefaults = HIT_ADVANCE_DEFAULT[result];
  if (hitDefaults) {
    for (const r of runners) {
      const value = hitDefaults[r.base];
      if (value) forced.set(r.atbatId, value);
    }
  }
  return forced;
}

// 走者1人分の行HTMLを生成する(通常の新規入力・打席編集モードの両方で使う共通部品)。
// selectedValueは初期選択('scored'/'out'/'advance:塁'のいずれか。無指定なら'そのまま')。
function runnerRowHtml(r, selectedValue) {
  const name = escapeHtml(runnerDisplayName(r));
  const baseLabel = BASE_LABELS[r.base] || '';
  const groupName = `runner-${r.atbatId}`;
  const advanceOptions = (ADVANCE_TARGETS[r.base] || [])
    .map((base) => {
      const value = `advance:${base}`;
      const checked = selectedValue === value ? 'checked' : '';
      return `<label><input type="radio" name="${groupName}" value="${value}" ${checked} style="display:inline-block;width:auto;" /> ${BASE_LABELS[base]}へ進塁</label>`;
    })
    .join('');
  return `
    <div class="runner-row">
      <span>${r.orderNo ?? ''}番 ${name}(${baseLabel})</span>
      <label><input type="radio" name="${groupName}" value="none" ${selectedValue ? '' : 'checked'} style="display:inline-block;width:auto;" /> そのまま</label>
      ${advanceOptions}
      <label><input type="radio" name="${groupName}" value="scored" ${selectedValue === 'scored' ? 'checked' : ''} style="display:inline-block;width:auto;" /> 生還</label>
      <label><input type="radio" name="${groupName}" value="out" style="display:inline-block;width:auto;" /> アウト</label>
    </div>`;
}

// 現在の打席の打者以外の走者一覧を、走者ごとに「そのまま/進塁(塁ごと)/生還/アウト」で出す
// (例: A選手のヒットで既に塁に出ていたB選手がホームインした場合、両方を同時に記録できる。
// アウトを選んだ場合は走塁死と同じ、進塁を選んだ場合は盗塁と同じ仕組みでlive_eventsに記録される)。
// 攻撃側・守備側どちらでも同じ仕組みで動く(走者は打席idで識別するため相手選手にも使える)。
function renderRunnersScoredCheckboxes() {
  if (!currentPointer || currentPointer.side == null) {
    els.runnersScoredBox.classList.add('hidden');
    els.batterFcBox.classList.add('hidden');
    els.sacFlyBox.classList.add('hidden');
    return;
  }
  const isOffense = currentPointer.side === 'offense';
  let runners = deriveRunnersOnBase(state.game, state.atbats, state.events);
  if (isOffense) runners = runners.filter((r) => r.batterId !== els.batterSelect.value);

  els.runnersScoredBox.classList.toggle('hidden', runners.length === 0);
  const opt = findResultOption(els.resultSelect.value);
  const forcedDefaults = computeForcedDefaults(opt?.result, runners);
  els.runnersScoredList.innerHTML = runners.map((r) => runnerRowHtml(r, forcedDefaults.get(r.atbatId))).join('');
  syncBatterFcState();
  syncSacFlyState();
  syncScoredCheckboxForHomeRun();
  syncBatterAdvanceBox();
  updateRbiDefault();
}

// 打者走者自身がエラー等でさらに先の塁まで進んだ場合を選べるボックスの表示制御
// (失策出塁・振り逃げ・単打・野選のみ対象。振り逃げ・単打・野選は悪送球が絡む頻度が低いため
// 折りたたみ(<details>のopen=false)にし、失策出塁のみ最初から展開しておく)。
const BATTER_ADVANCE_RESULTS = new Set(['reached_on_error', 'strikeout_reached', 'single', 'fielders_choice']);

function syncBatterAdvanceBox() {
  const opt = findResultOption(els.resultSelect.value);
  const applicable = !!opt && BATTER_ADVANCE_RESULTS.has(opt.result);
  els.batterAdvanceBox.classList.toggle('hidden', !applicable);
  if (!applicable) {
    const noneRadio = els.batterAdvanceBox.querySelector('input[value="none"]');
    if (noneRadio) noneRadio.checked = true;
    els.batterAdvanceBox.open = false;
    return;
  }
  els.batterAdvanceBox.open = opt.result === 'reached_on_error';
}

function syncRunnerDependentState() {
  syncBatterFcState();
  syncSacFlyState();
  updateRbiDefault();
}

// 本塁打は定義上必ず打者が生還するため、「生還した」チェックを自動でON・変更不可にする
// (チェック忘れによるscored漏れの実害が試合20260719で発生したための対策)。
// 攻撃側・守備側どちらでも(相手の本塁打を記録する場合も)成り立つため、isOffenseで分岐しない。
function syncScoredCheckboxForHomeRun() {
  const opt = findResultOption(els.resultSelect.value);
  const isHomeRun = opt?.result === 'home_run';
  els.scoredCheckbox.disabled = isHomeRun;
  if (isHomeRun) els.scoredCheckbox.checked = true;
  els.scoredCheckboxLabel.textContent = isHomeRun ? '生還した(本塁打のため自動)' : '生還した';
}

els.runnersScoredList.addEventListener('change', syncRunnerDependentState);
els.batterFcBox.addEventListener('change', () => { syncBatterFcState(); updateRbiDefault(); });
els.scoredCheckbox.addEventListener('change', updateRbiDefault);
// 結果が変わるたびに走者一覧を再構築する(四球・死球での強制進塁デフォルトを再計算するため)。
// 編集モード中は「今」の走者一覧(renderRunnersScoredCheckboxes)ではなく、対象打席時点の
// 履歴ベースの走者一覧(renderEditRunnersBox)を使い続ける。
els.resultSelect.addEventListener('change', () => {
  if (editingAtbat) {
    renderEditRunnersBox(editingAtbat);
    return;
  }
  renderRunnersScoredCheckboxes();
});

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
  renderTrackPitchingToggle();

  // 打席編集中は、試合終了後(closed)であってもフォームを表示し続ける(事後レビューでの編集が
  // このアプリの主要ユースケースの一つのため)。Realtimeの更新等で「次の入力」向け自動セット処理が
  // 編集中フォームの内容を上書きしてしまわないよう、ここで打ち切る(pointer-box自体は上で更新済み)。
  if (editingAtbat) {
    els.form.classList.remove('hidden');
    els.defenseSimple.classList.add('hidden');
    return;
  }

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

function handleEditAtbat(atbat) {
  enterEditMode(atbat);
}

// 打席編集モードに入る。新規入力と同じフォーム一式(打者/結果/RBI/生還/投手/相手打者名+
// 走者選択+打者走者自身の進塁)を、対象打席の値で埋めて再利用する。
function enterEditMode(atbat) {
  editingAtbat = atbat;
  const isOffenseEdit = atbat.batter_id !== 'opponent';

  els.editModeBanner.classList.remove('hidden');
  document.querySelector('.quick-events').classList.add('hidden');
  els.form.classList.remove('hidden');
  els.defenseSimple.classList.add('hidden');
  els.submitBtn.textContent = '更新する';
  els.submitBtn.disabled = false;

  els.offenseFields.classList.toggle('hidden', !isOffenseEdit);
  els.defenseFields.classList.toggle('hidden', isOffenseEdit);

  if (isOffenseEdit) {
    // オーダーから既に外れた選手(その場登録の助っ人等)の場合、セレクトに一時的な選択肢を足す。
    if (![...els.batterSelect.options].some((o) => o.value === atbat.batter_id)) {
      const opt = document.createElement('option');
      opt.value = atbat.batter_id;
      opt.textContent = state.playersById.get(atbat.batter_id)?.display_name || atbat.batter_id;
      els.batterSelect.insertBefore(opt, els.batterSelect.querySelector('option[value="__other__"]'));
    }
    els.batterSelect.value = atbat.batter_id;
    els.batterOtherLabel.classList.add('hidden');
  } else {
    if (atbat.pitcher_id) els.pitcherSelect.value = atbat.pitcher_id;
    els.opponentBatterName.value = atbat.opponent_batter_name || '';
  }

  const opt = findResultOptionForAtbat(atbat);
  if (opt) els.resultSelect.value = opt.label;

  els.scoredCheckbox.checked = !!atbat.scored;

  // fielders_choice/sac_flyはcurrentPointer(「今」の状況)基準のfcApplicable/sacFlyApplicableでは
  // 過去の打席を正しく判定できないため、保存されているresultから直接復元する
  // (実際の打球方向はfindResultOptionForAtbatが既にdetail経由で正しく復元済み)。
  const wasFc = atbat.result === 'fielders_choice';
  els.batterFcBox.classList.toggle('hidden', !wasFc);
  if (wasFc) {
    const safeRadio = els.batterFcBox.querySelector('input[value="safe"]');
    if (safeRadio) safeRadio.checked = true;
    els.rbiInput.disabled = true;
    els.rbiInput.value = 0;
  } else {
    els.rbiInput.disabled = false;
    els.rbiInput.value = atbat.rbi ?? 0;
  }

  const wasSacFly = atbat.result === 'sac_fly';
  els.sacFlyBox.classList.toggle('hidden', !wasSacFly);
  if (wasSacFly) {
    const yesRadio = els.sacFlyBox.querySelector('input[value="yes"]');
    if (yesRadio) yesRadio.checked = true;
  }

  renderEditRunnersBox(atbat);
  syncScoredCheckboxForHomeRun();
  if (!wasFc) updateRbiDefault();

  els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 編集フォームの「他の走者」欄+「打者走者自身の進塁」欄を、対象打席時点の走者状態
// (deriveRunnersOnBaseBefore)と、この打席が原因で作られた既存イベント(caused_by_atbat_id)の
// 逆引きから復元する。ただし後続打席のrunners-scored-boxで「生還」を直接選んだケース
// (live_atbats.scoredの直接更新、イベント記録なし)は逆引きの手段が無いため復元できない
// (既知の制限。手動で選び直す必要がある)。
function renderEditRunnersBox(atbat) {
  let runners = deriveRunnersOnBaseBefore(state.game, state.atbats, state.events, atbat.id);
  if (atbat.batter_id !== 'opponent') runners = runners.filter((r) => r.batterId !== atbat.batter_id);
  els.runnersScoredBox.classList.toggle('hidden', runners.length === 0);

  const causedEvents = state.events.filter((e) => !e.deleted_at && e.caused_by_atbat_id === atbat.id);
  const initialSelections = new Map();
  let ownAdvanceValue = null;
  for (const e of causedEvents) {
    if (e.runner_atbat_id === atbat.id) {
      if (e.type === 'runner_advance') ownAdvanceValue = e.to_base === 'home' ? 'home' : e.to_base;
      continue;
    }
    if (e.type === 'runner_out_advancing') {
      initialSelections.set(e.runner_atbat_id, 'out');
    } else if (e.type === 'runner_advance') {
      initialSelections.set(e.runner_atbat_id, e.to_base === 'home' ? 'scored' : `advance:${e.to_base}`);
    }
  }

  els.runnersScoredList.innerHTML = runners.map((r) => runnerRowHtml(r, initialSelections.get(r.atbatId))).join('');

  syncBatterAdvanceBox();
  if (ownAdvanceValue) {
    const radio = els.batterAdvanceBox.querySelector(`input[value="${ownAdvanceValue}"]`);
    if (radio) { radio.checked = true; els.batterAdvanceBox.open = true; }
  }
}

// 編集モードを終了し、通常の新規入力モードに戻す(更新成功時・キャンセル時の両方で呼ぶ)。
function exitEditMode() {
  editingAtbat = null;
  els.editModeBanner.classList.add('hidden');
  document.querySelector('.quick-events').classList.remove('hidden');
  els.submitBtn.textContent = 'この打席を記録';
}

els.editModeCancelBtn.addEventListener('click', () => {
  exitEditMode();
  renderAll();
});

// 更新前に旧→新の変更差分を一覧化する(UI/UXレビュー反映: 走者イベントの取消・再作成を伴う
// 破壊的な操作のため、送信前に何が変わるか確認できるようにする)。
function buildEditDiffSummary(atbat, payload, opt) {
  const lines = ['この内容で更新しますか?'];
  const oldLabel = findResultOptionForAtbat(atbat)?.label || atbat.detail || atbat.result;
  if (oldLabel !== opt.label) lines.push(`結果: ${oldLabel} → ${opt.label}`);
  if ((atbat.rbi ?? 0) !== payload.rbi) lines.push(`打点: ${atbat.rbi ?? 0} → ${payload.rbi}`);
  if (!!atbat.scored !== payload.scored) lines.push(`生還: ${atbat.scored ? 'あり' : 'なし'} → ${payload.scored ? 'あり' : 'なし'}`);
  if (atbat.batter_id !== payload.batterId) {
    const oldName = state.playersById.get(atbat.batter_id)?.display_name || atbat.batter_id;
    const newName = state.playersById.get(payload.batterId)?.display_name || payload.batterId;
    lines.push(`打者: ${oldName} → ${newName}`);
  }
  if (lines.length === 1) lines.push('(結果・打点・生還・打者に変更はありません)');
  lines.push('※ この打席が原因の走者の動き(進塁・生還・アウト)は、現在選択されている内容で作り直されます。');
  return lines.join('\n');
}

async function handleEditFormSubmit(enteredBy) {
  const atbat = editingAtbat;
  const isOffenseEdit = atbat.batter_id !== 'opponent';
  const opt = findResultOption(els.resultSelect.value);
  if (!opt) { alert('結果を選択してください'); return; }

  if (isOffenseEdit && els.batterSelect.value === '__other__') {
    alert('打者が未登録です。「登録して選択」を押して助っ人を登録してください');
    return;
  }

  const batterId = isOffenseEdit ? els.batterSelect.value : 'opponent';

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

  let batterAdvanceToBase = null;
  if (!els.batterAdvanceBox.classList.contains('hidden')) {
    const value = els.batterAdvanceBox.querySelector('input[name="batter-advance"]:checked')?.value;
    if (value && value !== 'none') batterAdvanceToBase = value;
  }

  let effectiveResult = opt.result;
  let effectiveRbi = Number(els.rbiInput.value) || 0;
  if (!els.batterFcBox.classList.contains('hidden')) {
    const safe = els.batterFcBox.querySelector('input[name="batter-fc"]:checked')?.value === 'safe';
    if (safe) { effectiveResult = 'fielders_choice'; effectiveRbi = 0; }
  }
  if (!els.sacFlyBox.classList.contains('hidden')) {
    const isSacFly = els.sacFlyBox.querySelector('input[name="sac-fly"]:checked')?.value === 'yes';
    if (isSacFly) effectiveResult = 'sac_fly';
  }

  const payload = {
    clientUuid: crypto.randomUUID(),
    batterId,
    orderNo: atbat.order_no,
    outsBefore: atbat.outs_before,
    result: effectiveResult,
    ab: isAtBat(effectiveResult),
    hitType: opt.hitType || null,
    rbi: effectiveRbi,
    scored: els.scoredCheckbox.checked,
    detail: opt.detail,
    pitcherId: isOffenseEdit ? null : els.pitcherSelect.value,
    opponentBatterName: isOffenseEdit ? null : (els.opponentBatterName.value.trim() || null),
    enteredBy,
    scoredRunnerIds,
    outRunnerIds,
    advancedRunnerMoves,
    batterAdvanceToBase,
  };

  const ok = await confirmModal(buildEditDiffSummary(atbat, payload, opt));
  if (!ok) return;

  els.submitBtn.disabled = true;
  const originalLabel = els.submitBtn.textContent;
  els.submitBtn.textContent = '更新中...';
  try {
    const row = await api.editAtbatFull(atbat.id, accessToken, payload);
    upsertLocal(state.atbats, row);
    exitEditMode(); // ここで「この打席を記録」ラベルへ戻すため、下のfinallyではラベルを触らない
    renderAll();
  } catch (e) {
    alert(`更新に失敗しました: ${e.message || e}`);
    els.submitBtn.textContent = originalLabel; // 編集モード継続中なので「更新する」に戻す
  } finally {
    els.submitBtn.disabled = false;
  }
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
  try {
    await api.undoLastAtbat(gameId, accessToken, deletedBy, lastSubmittedClientUuid);
    lastSubmittedClientUuid = null;
  } catch (e) {
    alert(`取り消しに失敗しました: ${e.message || e}`);
  }
});

// --- クイックイベント ---
for (const btn of els.quickEventButtons) {
  btn.addEventListener('click', () => {
    const enteredBy = els.enteredByInput.value.trim();
    if (!enteredBy) { alert('入力者名を入力してください'); return; }
    if (!pointerMatchesExpected(currentPointer.lastAliveKey, state.atbats, state.events)) {
      alert('他の人が入力しました。最新の状況を確認してから、もう一度お願いします。');
      return;
    }
    const type = btn.dataset.event;
    scrollToTop();

    withDoubleTapGuard(els.quickEventButtons, async (release) => {
      try {
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

        // 主イベント→進塁イベントの順に逐次送信する(created_atの前後関係を保つため並行送信はしない)。
        await submitEventRetryable({
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
          await submitEventRetryable({
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
      } finally {
        release();
      }
    });
  });
}

// --- 送信(自動リトライ+指数バックオフ) ---
// submitFn: 実際にRPCを呼ぶ関数。onSuccess(row): 成功時のみ、返ってきた行でローカル状態を反映する
// コールバック(Realtimeの到達を待たずに即座にstate.atbats/eventsへ反映し、次の送信での
// pointerMatchesExpectedチェックが自分自身の直前の送信を正しく認識できるようにする)。
// onSettle: 成功・リトライ尽き(恒久失敗)のどちらでも呼ばれる(二重タップガード解除用)。
async function submitWithRetry(clientUuid, submitFn, onSuccess, onSettle) {
  state.pending.set(clientUuid, { status: 'sending', retries: 0 });
  renderPendingBadge(els.pendingBadge, state.pending);

  const attempt = async (retries) => {
    try {
      const row = await submitFn();
      state.pending.delete(clientUuid);
      if (row) {
        onSuccess?.(row);
        renderAll();
      }
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

function submitFnFor(kind, payload) {
  return kind === 'atbat'
    ? () => api.submitAtbat(gameId, accessToken, payload)
    : () => api.submitEvent(gameId, accessToken, payload);
}
function targetListFor(kind) {
  return kind === 'atbat' ? state.atbats : state.events;
}

// オフラインキューに載せてから送信する(#9)。成功したらキューから外す。リトライが尽きて
// 失敗表示のままリロードされても、init()側でキューを読み直して再送を再開する。
function queuedSubmit(kind, payload, onSettle) {
  addToQueue(kind, payload);
  submitWithRetry(
    payload.clientUuid,
    submitFnFor(kind, payload),
    (row) => { upsertLocal(targetListFor(kind), row); removeFromQueue(payload.clientUuid); },
    onSettle
  );
}

// クイックイベント用: submitWithRetryをPromiseでラップし、逐次awaitできるようにする
// (created_atの前後関係がimport_from_supabase.pyのafter_seq算出の正本のため、複数イベントを
// 送る場合も並行送信はせず1件ずつ確定させてから次を送る)。
function submitEventRetryable(payloadWithoutUuid) {
  return new Promise((resolve) => {
    const clientUuid = crypto.randomUUID();
    const payload = { ...payloadWithoutUuid, clientUuid };
    queuedSubmit('event', payload, resolve);
  });
}

// 打席編集(取消→再作成)は複数行の変更にまたがるため、Realtimeでは各行の変更が個別のイベントとして
// 届く。1件ごとに即renderAll()すると、他端末では走者が一瞬消えて戻るチラつきが起こりうるため、
// 短時間の連続更新をまとめて1回のrenderAll()に集約する(シニアエンジニアレビュー反映)。
let renderAllDebounceTimer = null;
function debouncedRenderAll() {
  if (renderAllDebounceTimer) clearTimeout(renderAllDebounceTimer);
  renderAllDebounceTimer = setTimeout(() => {
    renderAllDebounceTimer = null;
    renderAll();
  }, 250);
}

// 自分の送信操作の直後にだけ呼ぶ(renderAll/updatePointerAndFormには絶対に紐付けない)。
// Realtimeで他端末からの更新でもrenderAllは呼ばれるため、そちら経由にすると他人の入力の
// たびに全端末の画面が上に飛んでしまう。送信結果を待たずバリデーション通過時点で呼ぶことで、
// 次の入力のためにランナー・スコア表示(pointer-box)が見える位置へ即座に誘導する。
function scrollToTop() {
  document.activeElement?.blur?.();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const enteredBy = els.enteredByInput.value.trim();
  if (!enteredBy) { alert('入力者名を入力してください'); return; }

  if (editingAtbat) {
    await handleEditFormSubmit(enteredBy);
    return;
  }

  const isOffense = currentPointer.side === 'offense';

  if (!pointerMatchesExpected(currentPointer.lastAliveKey, state.atbats, state.events)) {
    alert('他の人が入力しました。最新の状況を確認してから、もう一度お願いします。');
    return;
  }

  const opt = findResultOption(els.resultSelect.value);
  if (!opt) { alert('結果を選択してください'); return; }

  // 「その他」を選んだままその場登録(add_guest_player)を完了していない場合、生の自由入力文字列を
  // batter_idにしてしまうと事後のデータ不整合につながるため送信をブロックする(試合20260719の教訓)。
  if (isOffense && els.batterSelect.value === '__other__') {
    alert('打者が未登録です。「登録して選択」を押して助っ人を登録してください');
    return;
  }

  const clientUuid = crypto.randomUUID();
  const batterId = isOffense ? els.batterSelect.value : 'opponent';

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

  // 打者走者自身の進塁(エラー等でさらに先の塁まで進んだ場合)。ボックス自体が非表示(対象外の結果)なら無視する。
  let batterAdvanceToBase = null;
  if (!els.batterAdvanceBox.classList.contains('hidden')) {
    const value = els.batterAdvanceBox.querySelector('input[name="batter-advance"]:checked')?.value;
    if (value && value !== 'none') batterAdvanceToBase = value;
  }

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
  // 犠飛の確認ボックスが表示されており「はい」が選ばれていれば、表示上のdetail(打球方向)は
  // 変えずにresultだけをsac_flyへ切り替える(打数に含めない。打点はupdateRbiDefaultで既に
  // 生還数を反映済みのためそのまま使う)。isFcEligibleResultをgroundout限定にしたため
  // batter-fc-boxとsac-fly-boxが同時に表示されることは無く、上書きが競合することはない。
  if (!els.sacFlyBox.classList.contains('hidden')) {
    const isSacFly = els.sacFlyBox.querySelector('input[name="sac-fly"]:checked')?.value === 'yes';
    if (isSacFly) {
      effectiveResult = 'sac_fly';
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
    batterAdvanceToBase,
  };

  scrollToTop();
  withDoubleTapGuard([els.submitBtn], (release) => {
    lastSubmittedClientUuid = clientUuid;
    lastSubmittedAt = Date.now();
    const originalLabel = els.submitBtn.textContent;
    els.submitBtn.textContent = '送信中...';
    queuedSubmit('atbat', payload, () => { els.submitBtn.textContent = originalLabel; release(); });
  });

  els.rbiInput.value = 0;
  els.rbiInput.disabled = false;
  els.scoredCheckbox.checked = false;
  els.opponentBatterName.value = '';
  const batterAdvanceNoneRadio = els.batterAdvanceBox.querySelector('input[value="none"]');
  if (batterAdvanceNoneRadio) batterAdvanceNoneRadio.checked = true;
  els.batterAdvanceBox.open = false;
  // resultSelect自体はリセットされないため、本塁打が選ばれたままなら自動チェック状態を復元する。
  syncScoredCheckboxForHomeRun();
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
  scrollToTop();
  withDoubleTapGuard([els.simpleOutBtn, els.simpleReachBtn], (release) => {
    lastSubmittedClientUuid = clientUuid;
    lastSubmittedAt = Date.now();
    queuedSubmit('atbat', payload, release);
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
    // 守備交代ログ(lineup_history)用に、変更が行われた時点のイニング・表裏・入力者名も渡す。
    await api.updateLineup(
      gameId, accessToken, lineup,
      currentPointer?.inning ?? null, currentPointer?.half ?? null,
      els.enteredByInput.value.trim() || null
    );
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

  // リロードで消えずに残っていた送信待ち・送信失敗中のリクエストを再送する(#9)。
  // client_uuidが同じため、既に成功していたものを再送しても副作用は二重にならない。
  for (const { kind, payload } of loadQueue()) {
    queuedSubmit(kind, payload, () => {});
  }

  realtimeHandle = subscribeToGame(gameId, {
    onStatusChange: (status) => renderConnectionStatus(els.connectionStatus, status),
    onPresenceChange: (names) => renderPresence(els.presenceBadge, names),
    initialPresence: { enteredBy: els.enteredByInput.value.trim() || null },
    onRefetch: ({ atbats: a, events: e }) => {
      state.atbats = a;
      state.events = e;
      renderAll();
    },
    onAtbatsChange: (payload) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      if (payload.eventType === 'DELETE') {
        const idx = state.atbats.findIndex((x) => x.id === row.id);
        if (idx >= 0) state.atbats.splice(idx, 1);
      } else {
        upsertLocal(state.atbats, payload.new);
      }
      debouncedRenderAll();
    },
    onEventsChange: (payload) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      if (payload.eventType === 'DELETE') {
        const idx = state.events.findIndex((x) => x.id === row.id);
        if (idx >= 0) state.events.splice(idx, 1);
      } else {
        upsertLocal(state.events, payload.new);
      }
      debouncedRenderAll();
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
