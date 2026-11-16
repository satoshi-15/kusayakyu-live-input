// 修正モード(v1.8): 試合中・試合後に、過去の記録の間への挿入・取消の復活・走者/得点の直接修正を行う。
// 通常の入力画面(app.js)には手を入れず、専用パネル(#correction-panel)で操作する。
// 操作のたびに全件を取り直し、各打席のアウト数(outs_before)を時刻順に数え直して書き戻す。
import * as api from './api.js';
import {
  fullTimeline, deriveRunnersAt, deriveInningState, recomputeOutsBefore, isAtBat,
} from './derive.js';
import { atbatLabel, eventLabel } from './render.js';
import { RESULT_OPTIONS, findResultOption } from './result-options.js';

const BASE_LABELS = { first: '一塁', second: '二塁', third: '三塁', home: '生還' };
const BASE_ORDER = ['first', 'second', 'third', 'home'];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// created_at(マイクロ秒精度の文字列)をマイクロ秒の数値にする(JSのDateはミリ秒までのため自前で扱う)。
function toMicros(ts) {
  const m = String(ts).match(/^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/);
  if (!m) return new Date(ts).getTime() * 1000;
  const frac = ((m[2] || '') + '000000').slice(0, 6);
  const tz = m[3] || 'Z';
  return Date.parse(`${m[1]}${tz === '' ? 'Z' : tz}`) * 1000 + Number(frac);
}
function fromMicros(us) {
  const ms = Math.floor(us / 1000);
  const iso = new Date(ms).toISOString(); // ...sss Z
  const micro = String(Math.round(us - ms * 1000)).padStart(3, '0');
  return iso.replace('Z', `${micro}Z`);
}
function halfName(inning, half) {
  return `${inning}回${half === 'top' ? '表' : '裏'}`;
}

export function createCorrection(ctx) {
  // ctx: { state, gameId, accessToken, getEnteredBy, onEditAtbat(atbat), onChanged(), els: {modalOverlay, modalMessage, modalConfirm, modalCancel} }
  const { state, gameId, accessToken } = ctx;
  const panel = document.getElementById('correction-panel');
  const timelineBox = document.getElementById('correction-timeline');
  const openBtn = document.getElementById('correction-open-btn');
  const closeBtn = document.getElementById('correction-close-btn');
  const runnersBtn = document.getElementById('correction-runners-btn');
  const statusBox = document.getElementById('correction-status');
  let busy = false;

  const playerName = (id) => state.playersById.get(id)?.display_name || id;
  const runnerName = (r) => (r.batterId !== 'opponent' ? playerName(r.batterId) : (r.opponentBatterName || '相手走者'));
  const runnerIdFor = (r) => (r.batterId === 'opponent' ? (r.opponentBatterName || null) : r.batterId);
  const enteredBy = () => ctx.getEnteredBy() || '(修正モード)';

  function isOpen() { return !panel.classList.contains('hidden'); }

  function modal(html, confirmLabel = '実行') {
    const { modalOverlay, modalMessage, modalConfirm, modalCancel } = ctx.els;
    return new Promise((resolve) => {
      modalMessage.innerHTML = html;
      const orig = modalConfirm.textContent;
      modalConfirm.textContent = confirmLabel;
      modalOverlay.classList.remove('hidden');
      const done = (ok) => {
        const values = ok ? collectValues(modalMessage) : null;
        modalOverlay.classList.add('hidden');
        modalConfirm.textContent = orig;
        resolve(values);
      };
      modalConfirm.onclick = () => done(true);
      modalCancel.onclick = () => done(false);
    });
  }
  // モーダル内の入力値を {name: value} で取り出す(checkboxはboolean)。
  function collectValues(root) {
    const v = {};
    for (const elm of root.querySelectorAll('[name]')) {
      if (elm.type === 'checkbox') v[elm.name] = elm.checked;
      else if (elm.type === 'radio') { if (elm.checked) v[elm.name] = elm.value; }
      else v[elm.name] = elm.value;
    }
    return v;
  }

  function setStatus(text) { statusBox.textContent = text || ''; }

  // 全件取り直し→アウト数の再計算・書き戻し→画面更新。
  async function refreshAndRecalc() {
    const [atbats, events] = await Promise.all([api.fetchAllAtbats(gameId), api.fetchAllEvents(gameId)]);
    state.atbats = atbats;
    state.events = events;
    const { updates, overflow } = recomputeOutsBefore(atbats, events);
    if (updates.length) {
      await api.setOutsBefore(gameId, accessToken, updates);
      for (const u of updates) {
        const a = state.atbats.find((x) => x.id === u.id);
        if (a) a.outs_before = u.outs;
      }
    }
    ctx.onChanged();
    if (overflow.length) {
      alert(`${overflow.join('・')}のアウトが4つ以上になっています。取消・挿入した内容を確認してください。`);
    }
    return updates.length;
  }

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    setStatus(`${label}中...`);
    try {
      await fn();
      const n = await refreshAndRecalc();
      setStatus(`${label}しました${n ? `(アウト数を${n}打席分振り直し)` : ''}`);
    } catch (e) {
      setStatus('');
      alert(`${label}に失敗しました: ${e.message || e}`);
    } finally {
      busy = false;
    }
  }

  // ---- 一覧 ----
  function render() {
    if (!isOpen()) return;
    const items = fullTimeline(state.atbats, state.events);
    const atbatById = new Map(state.atbats.map((a) => [a.id, a]));
    timelineBox.innerHTML = '';
    let currentKey = null;
    items.forEach((item) => {
      const r = item.ref;
      const key = `${r.inning}:${r.half}`;
      if (key !== currentKey) {
        currentKey = key;
        const head = document.createElement('div');
        head.className = 'correction-half';
        const side = r.half === state.game.our_half ? '攻撃' : '守備';
        head.innerHTML = `<strong>${halfName(r.inning, r.half)}</strong>(${side}) `;
        const addTop = document.createElement('button');
        addTop.className = 'btn-small';
        addTop.textContent = '＋先頭に追加';
        const { inning, half } = r;
        addTop.addEventListener('click', () => openInsert({ inning, half, atStartOfHalf: true }));
        head.appendChild(addTop);
        timelineBox.appendChild(head);
      }
      const row = document.createElement('div');
      const deleted = !!r.deleted_at;
      const orphan = item.kind === 'event' && !deleted && r.caused_by_atbat_id
        && atbatById.get(r.caused_by_atbat_id)?.deleted_at;
      row.className = `correction-row${item.kind === 'event' ? ' correction-row-event' : ''}${deleted ? ' correction-deleted' : ''}`;
      const label = document.createElement('span');
      const text = item.kind === 'atbat' ? atbatLabel(r, state.playersById) : eventLabel(r, state.playersById);
      label.textContent = `${item.kind === 'event' ? '　└ ' : ''}${text.replace(/^\d+回[表裏] /, '')}`
        + (item.kind === 'atbat' && !deleted ? ` [${r.outs_before ?? '-'}アウトから]` : '')
        + (deleted ? '(取消済み)' : '')
        + (orphan ? '(⚠取消済みの打席に付いた記録)' : '');
      row.appendChild(label);
      const btns = document.createElement('span');
      btns.className = 'correction-btns';
      const addBtn = (text, cls, fn) => {
        const b = document.createElement('button');
        b.className = `btn-small ${cls || ''}`;
        b.textContent = text;
        b.addEventListener('click', fn);
        btns.appendChild(b);
      };
      if (deleted) {
        addBtn('戻す', '', () => run('復活', () => (item.kind === 'atbat'
          ? api.restoreAtbat(r.id, accessToken) : api.restoreEvent(r.id, accessToken))));
      } else {
        if (item.kind === 'atbat') {
          addBtn('編集', '', () => { close(); ctx.onEditAtbat(r); });
        }
        addBtn('取消', 'btn-danger', () => run('取消', () => (item.kind === 'atbat'
          ? api.softDeleteAtbat(r.id, accessToken, enteredBy()) : api.softDeleteEvent(r.id, accessToken, enteredBy()))));
        addBtn('＋後に追加', '', () => openInsert({ inning: r.inning, half: r.half, afterItem: item }));
      }
      row.appendChild(btns);
      timelineBox.appendChild(row);
    });
    if (!items.length) timelineBox.textContent = 'まだ記録がありません。';
  }

  // ---- 挿入位置の時刻 ----
  // afterItemの直後(その打席の付随イベントの後ろ)と、次の行との中間の時刻を返す。
  function insertionTime({ inning, half, afterItem, atStartOfHalf }) {
    const items = fullTimeline(state.atbats, state.events);
    let anchorIdx;
    if (atStartOfHalf) {
      const firstIdx = items.findIndex((x) => x.ref.inning === inning && x.ref.half === half);
      anchorIdx = firstIdx - 1;
    } else {
      anchorIdx = items.findIndex((x) => x.kind === afterItem.kind && x.ref.id === afterItem.ref.id);
      // 打席の場合、その打席と同時に作られた付随イベントの後ろにする。
      if (afterItem.kind === 'atbat') {
        while (anchorIdx + 1 < items.length && items[anchorIdx + 1].kind === 'event'
          && items[anchorIdx + 1].ref.caused_by_atbat_id === afterItem.ref.id) anchorIdx += 1;
      }
    }
    const prev = anchorIdx >= 0 ? toMicros(items[anchorIdx].ref.created_at) : null;
    const next = anchorIdx + 1 < items.length ? toMicros(items[anchorIdx + 1].ref.created_at) : null;
    let t;
    if (prev != null && next != null) {
      if (next - prev < 4) throw new Error('この位置には挿入できません(前後の記録の時刻が近すぎます)。1つ後ろの位置で試してください。');
      t = Math.floor((prev + next) / 2);
    } else if (prev != null) t = prev + 1000000;
    else if (next != null) t = next - 1000000;
    else t = Date.now() * 1000;
    // 打席の付随イベントは打席の時刻+1ms刻みで作られるため、次の行との間にその余裕があるかも返す。
    return { cutoffUs: prev, createdUs: t, nextUs: next };
  }

  function pitcherBefore(inning, half, beforeUs) {
    const cands = state.atbats
      .filter((a) => !a.deleted_at && a.batter_id === 'opponent' && a.pitcher_id && toMicros(a.created_at) <= beforeUs)
      .sort((a, b) => toMicros(a.created_at) - toMicros(b.created_at));
    return cands.length ? cands[cands.length - 1].pitcher_id : null;
  }

  // ---- 挿入 ----
  async function openInsert(pos) {
    let timing;
    try { timing = insertionTime(pos); } catch (e) { alert(e.message); return; }
    const { inning, half } = pos;
    const isOffense = half === state.game.our_half;
    const cutoffTs = timing.cutoffUs != null ? fromMicros(timing.cutoffUs) : null;
    const runners = cutoffTs ? deriveRunnersAt(state.atbats, state.events, inning, half, cutoffTs) : [];

    const typeHtml = `
      <p class="field-hint"><strong>${halfName(inning, half)}</strong>に追加します(${pos.atStartOfHalf ? 'この回の先頭' : '選んだ記録の後ろ'})。</p>
      <label>追加する記録
        <select name="type">
          <option value="atbat">打席</option>
          <option value="stolen_base">盗塁</option>
          <option value="caught_stealing">盗塁死</option>
          <option value="runner_out_advancing">走塁死</option>
          <option value="runner_advance">走者の進塁・生還</option>
          <option value="wild_pitch">暴投</option>
          <option value="passed_ball">パスボール</option>
          <option value="balk">ボーク</option>
        </select>
      </label>`;
    const v = await modal(typeHtml, '次へ');
    if (!v) return;
    if (v.type === 'atbat') await insertAtbat(pos, timing, runners, isOffense);
    else await insertEvent(pos, timing, runners, v.type, isOffense);
  }

  function runnerLabel(r) {
    return `${escapeHtml(runnerName(r))}(${BASE_LABELS[r.base]})${r.laterScored ? ' ※後で生還' : ''}`;
  }

  function destOptions(fromBase, { includeOut, includeStay = true } = {}) {
    const idx = BASE_ORDER.indexOf(fromBase);
    const opts = [];
    if (includeStay) opts.push(`<option value="none">そのまま</option>`);
    for (const b of BASE_ORDER.slice(idx + 1)) opts.push(`<option value="${b}">${b === 'home' ? '生還' : `${BASE_LABELS[b]}へ`}</option>`);
    if (includeOut) opts.push('<option value="out">アウト</option>');
    return opts.join('');
  }

  async function insertAtbat(pos, timing, runners, isOffense) {
    const { inning, half } = pos;
    const lineup = state.game.lineup || [];
    const groups = new Map();
    for (const o of RESULT_OPTIONS) {
      if (!groups.has(o.group)) groups.set(o.group, []);
      groups.get(o.group).push(o);
    }
    const resultSelect = [...groups.entries()]
      .map(([g, opts]) => `<optgroup label="${g}">${opts.map((o) => `<option value="${escapeHtml(o.label)}">${escapeHtml(o.shortLabel || o.label)}</option>`).join('')}</optgroup>`)
      .join('');
    const who = isOffense
      ? `<label>打者 <select name="batter">${lineup.map((r) => `<option value="${escapeHtml(r.batter_id)}">${r.order_no}番 ${escapeHtml(playerName(r.batter_id))}</option>`).join('')}</select></label>`
      : `<label>投手 <select name="pitcher">${state.players.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === pitcherBefore(inning, half, timing.createdUs) ? ' selected' : ''}>${escapeHtml(p.display_name)}</option>`).join('')}</select></label>
         <label>相手打者名(任意) <input type="text" name="oppName" /></label>`;
    const runnerRows = runners.map((r) => `
      <div class="runner-row"><span>${runnerLabel(r)}</span>
        <select name="runner-${r.atbatId}">${destOptions(r.base, { includeOut: true })}</select></div>`).join('');
    const html = `
      <p class="field-hint"><strong>${halfName(inning, half)}</strong>に打席を追加</p>
      ${who}
      <label>結果 <select name="result">${resultSelect}</select></label>
      <p class="field-hint">ゴロで走者アウト・打者セーフは「野選」、外野フライで三塁走者生還は「犠飛」を選んでください。</p>
      <label>打点 <input type="number" name="rbi" min="0" max="4" value="0" /></label>
      <label><input type="checkbox" name="scored" style="display:inline-block;width:auto;" /> 打者自身が生還した</label>
      <label>打者走者のその後(エラー等で追加進塁した場合)
        <select name="batterAdvance"><option value="">そのまま</option><option value="second">二塁へ</option><option value="third">三塁へ</option><option value="home">生還</option></select>
      </label>
      ${runners.length ? `<p class="field-hint">この時点の走者(このプレーでの動き)</p>${runnerRows}` : '<p class="field-hint">この時点で走者はいません</p>'}`;
    const v = await modal(html, '追加する');
    if (!v) return;
    const opt = findResultOption(v.result);
    if (!opt) { alert('結果を選んでください'); return; }
    const batterId = isOffense ? v.batter : 'opponent';
    const scoredRunnerIds = [];
    const outRunnerIds = [];
    const advancedRunnerMoves = [];
    for (const r of runners) {
      const d = v[`runner-${r.atbatId}`];
      if (d === 'home') scoredRunnerIds.push(r.atbatId);
      else if (d === 'out') outRunnerIds.push(r.atbatId);
      else if (d && d !== 'none') advancedRunnerMoves.push({ atbat_id: r.atbatId, to_base: d });
    }
    const consequences = outRunnerIds.length + advancedRunnerMoves.length + (v.batterAdvance ? 1 : 0);
    if (timing.nextUs != null && timing.nextUs - timing.createdUs <= consequences * 1000) {
      alert('この位置は次の記録との時刻が近すぎて、走者の動きを含む打席を挿入できません。1つ後ろの位置で試してください。');
      return;
    }
    const orderNo = isOffense ? (lineup.find((r) => r.batter_id === batterId)?.order_no ?? null) : null;
    await run('打席を追加', () => api.submitAtbat(gameId, accessToken, {
      clientUuid: crypto.randomUUID(),
      inning, half, batterId, orderNo,
      outsBefore: 0, // 追加後に数え直して書き戻す
      result: opt.result,
      ab: isAtBat(opt.result),
      hitType: opt.hitType || null,
      rbi: Number(v.rbi) || 0,
      scored: !!v.scored,
      detail: opt.detail,
      pitcherId: isOffense ? null : v.pitcher,
      opponentBatterName: isOffense ? null : (v.oppName?.trim() || null),
      enteredBy: enteredBy(),
      scoredRunnerIds, outRunnerIds, advancedRunnerMoves,
      batterAdvanceToBase: v.batterAdvance || null,
      createdAt: fromMicros(timing.createdUs),
    }));
  }

  async function insertEvent(pos, timing, runners, type, isOffense) {
    const { inning, half } = pos;
    const needsPitcher = !isOffense && ['wild_pitch', 'passed_ball', 'balk'].includes(type);
    const multi = ['wild_pitch', 'passed_ball', 'balk'].includes(type);
    if (!runners.length) { alert('この時点で塁上に走者がいないため追加できません。'); return; }
    let html = `<p class="field-hint"><strong>${halfName(inning, half)}</strong>に追加</p>`;
    if (multi) {
      html += runners.map((r) => `<div class="runner-row"><span>${runnerLabel(r)}</span>
        <select name="runner-${r.atbatId}">${destOptions(r.base).replace('<option value="none">', '<option value="none">').replace(/<option value="(second|third|home)">/, '<option value="$1" selected>')}</select></div>`).join('');
    } else {
      html += `<label>走者 <select name="runner">${runners.map((r) => `<option value="${r.atbatId}">${runnerLabel(r)}</option>`).join('')}</select></label>`;
      if (type === 'runner_advance') {
        html += `<label>行き先 <select name="to"><option value="second">二塁</option><option value="third">三塁</option><option value="home">生還</option></select></label>`;
      }
    }
    if (needsPitcher) {
      const p0 = pitcherBefore(inning, half, timing.createdUs);
      html += `<label>投手 <select name="pitcher">${state.players.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === p0 ? ' selected' : ''}>${escapeHtml(p.display_name)}</option>`).join('')}</select></label>`;
    }
    html += '<label>メモ(任意) <input type="text" name="note" placeholder="例: 失策:キャッチャー(送球)" /></label>';
    const v = await modal(html, '追加する');
    if (!v) return;

    const rows = [];
    const outPitcher = isOffense ? null : pitcherBefore(inning, half, timing.createdUs);
    if (multi) {
      rows.push({ type, runnerId: null, runnerAtbatId: null, pitcherId: needsPitcher ? v.pitcher : null, note: v.note || null });
      for (const r of runners) {
        const d = v[`runner-${r.atbatId}`];
        if (d && d !== 'none') rows.push({ type: 'runner_advance', runnerId: runnerIdFor(r), runnerAtbatId: r.atbatId, toBase: d });
      }
    } else {
      const r = runners.find((x) => String(x.atbatId) === v.runner);
      const base = { runnerId: runnerIdFor(r), runnerAtbatId: r.atbatId, note: v.note || null };
      if (type === 'runner_advance') rows.push({ ...base, type, toBase: v.to });
      else rows.push({ ...base, type, pitcherId: (type === 'caught_stealing' || type === 'runner_out_advancing') ? outPitcher : null });
    }
    if (timing.nextUs != null && timing.nextUs - timing.createdUs <= rows.length) {
      alert('この位置は次の記録との時刻が近すぎます。1つ後ろの位置で試してください。');
      return;
    }
    await run('記録を追加', async () => {
      // 1マイクロ秒ずつずらして順番を保つ(並行送信しない)。
      for (let i = 0; i < rows.length; i += 1) {
        const x = rows[i];
        await api.submitEvent(gameId, accessToken, {
          clientUuid: crypto.randomUUID(), inning, half, type: x.type,
          runnerId: x.runnerId ?? null, runnerAtbatId: x.runnerAtbatId ?? null, pitcherId: x.pitcherId ?? null,
          runnerNote: x.note ?? null, enteredBy: enteredBy(), toBase: x.toBase ?? null,
          createdAt: fromMicros(timing.createdUs + i),
        });
      }
    });
  }

  // ---- 走者・得点を直す ----
  async function openRunnerFix() {
    const halves = [];
    for (const item of fullTimeline(state.atbats, state.events)) {
      if (item.ref.deleted_at) continue;
      const k = `${item.ref.inning}:${item.ref.half}`;
      if (!halves.includes(k)) halves.push(k);
    }
    const cur = deriveInningState(state.atbats, state.events);
    const curKey = `${cur.inning}:${cur.half}`;
    if (!halves.includes(curKey)) halves.push(curKey);
    const pick = await modal(`
      <label>どの回の走者・得点を直しますか?
        <select name="half">${halves.map((k) => {
    const [i, h] = k.split(':');
    return `<option value="${k}"${k === curKey ? ' selected' : ''}>${halfName(Number(i), h)}${k === curKey ? '(現在)' : ''}</option>`;
  }).join('')}</select></label>`, '次へ');
    if (!pick) return;
    const [inningStr, half] = pick.half.split(':');
    const inning = Number(inningStr);

    // その回の最後の記録の直後に追加する(後の回の途中に入れると「現在の回」の判定が狂うため)。
    const items = fullTimeline(state.atbats, state.events).filter((x) => !x.ref.deleted_at);
    const inHalf = items.filter((x) => x.ref.inning === inning && x.ref.half === half);
    const lastItem = inHalf[inHalf.length - 1] || null;
    let timing = null;
    if (lastItem) {
      try { timing = insertionTime({ inning, half, afterItem: lastItem }); } catch (e) { alert(e.message); return; }
    }
    const runners = deriveRunnersAt(state.atbats, state.events, inning, half, null).filter((r) => !r.laterScored);
    const scored = state.atbats.filter((a) => !a.deleted_at && a.inning === inning && a.half === half && a.scored);
    const isOffense = half === state.game.our_half;

    const runnerRows = runners.map((r) => {
      const opts = ['<option value="none">そのまま</option>']
        .concat(['first', 'second', 'third'].filter((b) => b !== r.base).map((b) => `<option value="${b}">${BASE_LABELS[b]}にする</option>`))
        .concat(['<option value="home">生還にする</option>', '<option value="out">アウトにする</option>', '<option value="removed">消す(記録ミスで塁上にいない)</option>'])
        .join('');
      return `<div class="runner-row"><span>${escapeHtml(runnerName(r))}(今: ${BASE_LABELS[r.base]})</span><select name="runner-${r.atbatId}">${opts}</select></div>`;
    }).join('');
    const scoredRows = scored.map((a) => {
      const name = a.batter_id === 'opponent' ? (a.opponent_batter_name || '相手走者') : playerName(a.batter_id);
      return `<div class="runner-row"><label><input type="checkbox" name="unscore-${a.id}" style="display:inline-block;width:auto;" /> ${escapeHtml(name)}の生還を取り消す</label></div>`;
    }).join('');
    const html = `
      <p class="field-hint"><strong>${halfName(inning, half)}</strong>の塁上の走者と得点を直します(この回の最後に修正として記録します)。</p>
      ${runners.length ? `<p class="field-hint">塁上の走者</p>${runnerRows}` : '<p class="field-hint">塁上に走者はいません</p>'}
      ${scored.length ? `<p class="field-hint">生還済み(${scored.length}点)</p>${scoredRows}` : ''}
      <p class="field-hint">生還を取り消した走者は、取り消し後にもう一度この画面で塁を直せます。</p>`;
    const v = await modal(html, '反映する');
    if (!v) return;

    const rows = [];
    // 本塁に近い走者から順に動かす。
    const sorted = [...runners].sort((a, b) => BASE_ORDER.indexOf(b.base) - BASE_ORDER.indexOf(a.base));
    const pitcher = isOffense ? null : pitcherBefore(inning, half, timing ? timing.createdUs : Date.now() * 1000);
    for (const r of sorted) {
      const d = v[`runner-${r.atbatId}`];
      if (!d || d === 'none') continue;
      const base = { runnerId: runnerIdFor(r), runnerAtbatId: r.atbatId, note: '修正' };
      if (d === 'out') rows.push({ ...base, type: 'runner_out_advancing', pitcherId: pitcher });
      else if (d === 'removed') rows.push({ ...base, type: 'runner_removed' });
      else rows.push({ ...base, type: 'runner_advance', toBase: d });
    }
    const unscoreIds = scored.filter((a) => v[`unscore-${a.id}`]).map((a) => a.id);
    // 修正後に同じ塁に2人いることにならないか確認する。
    const finalBase = new Map();
    for (const r of runners) {
      const d = v[`runner-${r.atbatId}`];
      const b = (!d || d === 'none') ? r.base : d;
      if (['first', 'second', 'third'].includes(b)) {
        if (finalBase.has(b)) { alert(`${runnerName(finalBase.get(b))}と${runnerName(r)}が同時に${BASE_LABELS[b]}にいることになります。`); return; }
        finalBase.set(b, r);
      }
    }
    if (!rows.length && !unscoreIds.length) return;
    if (timing && timing.nextUs != null && timing.nextUs - timing.createdUs <= rows.length) {
      alert('この回の後ろに記録を入れる余裕がありません。');
      return;
    }
    await run('走者・得点を修正', async () => {
      for (const id of unscoreIds) await api.setRunnerScored(id, accessToken, false, enteredBy());
      for (let i = 0; i < rows.length; i += 1) {
        const x = rows[i];
        await api.submitEvent(gameId, accessToken, {
          clientUuid: crypto.randomUUID(), inning, half, type: x.type,
          runnerId: x.runnerId, runnerAtbatId: x.runnerAtbatId, pitcherId: x.pitcherId ?? null,
          runnerNote: x.note, enteredBy: enteredBy(), toBase: x.toBase ?? null,
          ...(timing ? { createdAt: fromMicros(timing.createdUs + i) } : {}),
        });
      }
    });
  }

  function open() {
    panel.classList.remove('hidden');
    document.body.classList.add('correction-open');
    setStatus('');
    render();
  }
  function close() {
    panel.classList.add('hidden');
    document.body.classList.remove('correction-open');
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  runnersBtn.addEventListener('click', openRunnerFix);

  return {
    render,
    // 通常画面での取消・編集の後にも、アウト数の振り直しだけ行う(全件取り直し込み)。
    recalcOuts: async () => {
      try { await refreshAndRecalc(); } catch (e) { console.warn('recalcOuts failed', e); }
    },
  };
}
