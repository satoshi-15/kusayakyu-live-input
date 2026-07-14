// DOM描画。ユーザー入力(相手打者名・入力者名等)はtextContent経由でのみ挿入し、XSSを避ける。
import { aliveAtbats, aliveEvents } from './derive.js';

const RESULT_LABELS = {
  groundout: 'ゴロ', flyout: 'フライ', strikeout: '三振', walk: '四球', hbp: '死球',
  single: '単打', double: '二塁打', triple: '三塁打', home_run: '本塁打',
  sac_bunt: '犠打', sac_fly: '犠飛', fielders_choice: '野選', reached_on_error: '失策出塁',
  strikeout_reached: '振り逃げ',
};

const EVENT_LABELS = {
  stolen_base: '盗塁', caught_stealing: '盗塁死', runner_out_advancing: '走塁死',
  runner_advance: '進塁', wild_pitch: '暴投', balk: 'ボーク', passed_ball: 'パスボール',
};

const BASE_LABELS = { first: '一塁', second: '二塁', third: '三塁', home: '本塁' };

function clear(elm) {
  while (elm.firstChild) elm.removeChild(elm.firstChild);
}

export function renderConnectionStatus(elm, status) {
  const map = {
    SUBSCRIBED: { text: '同期済み', cls: 'status-ok' },
    CHANNEL_ERROR: { text: '再接続中', cls: 'status-warn' },
    TIMED_OUT: { text: '再接続中', cls: 'status-warn' },
    CLOSED: { text: 'オフライン', cls: 'status-error' },
    connecting: { text: '接続中', cls: 'status-warn' },
  };
  const info = map[status] || { text: status, cls: 'status-warn' };
  elm.textContent = `● ${info.text}`;
  elm.className = info.cls;
}

// アウトカウントの直後に付ける短い塁状況表記(「一塁」「一三塁」「満塁」「走者なし」等)。
function formatBaseState(runners) {
  const bases = new Set(runners.map((r) => r.base));
  if (bases.size === 3) return '満塁';
  if (bases.size === 0) return '走者なし';
  const parts = [];
  if (bases.has('first')) parts.push('一');
  if (bases.has('second')) parts.push('二');
  if (bases.has('third')) parts.push('三');
  return parts.join('') + '塁';
}

function baseDiamondSvg(runners) {
  const occupied = new Set((runners || []).map((r) => r.base));
  const cls = (base) => `base base-${base}${occupied.has(base) ? ' occupied' : ''}`;
  return `
    <svg class="base-diamond" viewBox="0 0 100 100" width="32" height="32">
      <polygon points="50,12 88,50 50,88 12,50" fill="none" stroke="var(--border)" stroke-width="4" />
      <circle class="${cls('second')}" cx="50" cy="12" r="13" />
      <circle class="${cls('first')}" cx="88" cy="50" r="13" />
      <circle class="${cls('third')}" cx="12" cy="50" r="13" />
    </svg>`;
}

export function renderPointer(elm, pointer, playersById, score, runners) {
  clear(elm);
  elm.classList.toggle('pointer-offense', pointer.side === 'offense');
  elm.classList.toggle('pointer-defense', pointer.side === 'defense');

  const title = document.createElement('div');
  title.className = 'pointer-title';
  title.innerHTML = baseDiamondSvg(runners);
  const titleText = document.createElement('span');
  titleText.textContent = `${pointer.inning}回${pointer.half === 'top' ? '表' : '裏'} ${pointer.outs}アウト ${formatBaseState(runners)}`;
  title.appendChild(titleText);
  elm.appendChild(title);

  const runnersLine = document.createElement('div');
  runnersLine.className = 'pointer-runners';
  runnersLine.textContent = runners.length
    ? 'ランナー: ' + runners.map((r) => `${BASE_LABELS[r.base] || r.base}${r.name}`).join(' / ')
    : 'ランナーなし';
  elm.appendChild(runnersLine);

  if (score) {
    const scoreLine = document.createElement('div');
    scoreLine.className = 'pointer-score';
    scoreLine.textContent = `自チーム ${score.ours} - ${score.opponent} 相手`;
    elm.appendChild(scoreLine);
    const scoreNote = document.createElement('div');
    scoreNote.className = 'pointer-score-note';
    scoreNote.textContent = '(参考、公式記録は別途手動確認)';
    elm.appendChild(scoreNote);
  }

  const sub = document.createElement('div');
  sub.className = 'pointer-sub';
  if (pointer.side === 'offense') {
    const b = pointer.nextBatterId ? (playersById.get(pointer.nextBatterId)?.display_name || pointer.nextBatterId) : '未定';
    sub.textContent = `攻撃中 / 次: ${pointer.nextOrderNo ?? '-'}番 ${b}`;
  } else {
    const p = pointer.currentPitcherId ? (playersById.get(pointer.currentPitcherId)?.display_name || pointer.currentPitcherId) : '(投手未選択)';
    sub.textContent = `守備中 / 投手: ${p}`;
  }
  elm.appendChild(sub);
}

export function renderRecentList(elm, atbats, events, playersById, handlers) {
  clear(elm);
  const alive = aliveAtbats(atbats).slice(-10).reverse();
  const aliveEv = aliveEvents(events).slice(-5).reverse();

  for (const a of alive) {
    const row = document.createElement('div');
    row.className = 'recent-row';

    const label = document.createElement('span');
    const batterName = a.batter_id === 'opponent'
      ? (a.opponent_batter_name || '相手打者')
      : (playersById.get(a.batter_id)?.display_name || a.batter_id);
    label.textContent = `${a.inning}回${a.half === 'top' ? '表' : '裏'} ${batterName} ${RESULT_LABELS[a.result] || a.result}`;
    row.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.textContent = '編集';
    editBtn.className = 'btn-small';
    editBtn.addEventListener('click', () => handlers.onEditAtbat(a));
    row.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '取消';
    delBtn.className = 'btn-small btn-danger';
    delBtn.addEventListener('click', () => handlers.onDeleteAtbat(a));
    row.appendChild(delBtn);

    elm.appendChild(row);
  }

  for (const e of aliveEv) {
    const row = document.createElement('div');
    row.className = 'recent-row recent-row-event';
    const label = document.createElement('span');
    const runnerName = e.runner_id ? (playersById.get(e.runner_id)?.display_name || e.runner_id) : '';
    const toBaseSuffix = e.type === 'runner_advance' && e.to_base ? `(${BASE_LABELS[e.to_base] || e.to_base}へ)` : '';
    label.textContent = `${e.inning}回${e.half === 'top' ? '表' : '裏'} ${EVENT_LABELS[e.type] || e.type}${runnerName ? ' ' + runnerName : ''}${toBaseSuffix}`;
    row.appendChild(label);
    const delBtn = document.createElement('button');
    delBtn.textContent = '取消';
    delBtn.className = 'btn-small btn-danger';
    delBtn.addEventListener('click', () => handlers.onDeleteEvent(e));
    row.appendChild(delBtn);
    elm.appendChild(row);
  }
}

// 現在この試合を開いている(入力フォームを表示している)人の名前一覧を表示する。
// 名前未入力の参加者は数に含めない(表示しても誰か分からないため)。
export function renderPresence(elm, names) {
  const uniqueNames = [...new Set(names.filter(Boolean))];
  if (uniqueNames.length === 0) {
    elm.classList.add('hidden');
    return;
  }
  elm.textContent = `入力中: ${uniqueNames.join(', ')}`;
  elm.classList.remove('hidden');
}

export function renderPendingBadge(elm, pending) {
  const sending = [...pending.values()].filter((p) => p.status === 'sending').length;
  const failed = [...pending.values()].filter((p) => p.status === 'error');
  if (sending === 0 && failed.length === 0) {
    elm.textContent = '送信済み';
    elm.className = 'pending-badge pending-ok';
    return;
  }
  if (failed.length > 0) {
    elm.textContent = `送信失敗 ${failed.length}件(再試行してください)`;
    elm.className = 'pending-badge pending-error';
  } else {
    elm.textContent = '送信中...';
    elm.className = 'pending-badge pending-sending';
  }
}
