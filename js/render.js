// DOM描画。ユーザー入力(相手打者名・入力者名等)はtextContent経由でのみ挿入し、XSSを避ける。
import { aliveAtbats, aliveEvents } from './derive.js';

const RESULT_LABELS = {
  groundout: 'ゴロ', flyout: 'フライ', strikeout: '三振', walk: '四球', hbp: '死球',
  single: '単打', double: '二塁打', triple: '三塁打', home_run: '本塁打',
  sac_bunt: '犠打', sac_fly: '犠飛', fielders_choice: '野選', reached_on_error: '失策出塁',
};

const EVENT_LABELS = {
  stolen_base: '盗塁', caught_stealing: '盗塁死', wild_pitch: '暴投', balk: 'ボーク',
};

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

export function renderPointer(elm, pointer, playersById, score) {
  clear(elm);
  const title = document.createElement('div');
  title.className = 'pointer-title';
  title.textContent = `${pointer.inning}回${pointer.half === 'top' ? '表' : '裏'} ${pointer.outs}アウト`;
  elm.appendChild(title);

  if (score) {
    const scoreLine = document.createElement('div');
    scoreLine.className = 'pointer-score';
    scoreLine.textContent = `自チーム ${score.ours} - ${score.opponent} 相手(参考、公式記録は別途手動確認)`;
    elm.appendChild(scoreLine);
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

const BASE_LABELS = { first: '一塁', second: '二塁', third: '三塁' };

// 自チーム攻撃中の走者一覧を軽量表示する(進塁は盗塁のみ反映する簡易版のため、参考程度)。
export function renderRunners(elm, runners) {
  clear(elm);
  if (!runners.length) return;
  const line = document.createElement('div');
  line.className = 'runners-line';
  line.textContent = 'ランナー: ' + runners
    .map((r) => `${BASE_LABELS[r.base] || r.base}${r.name}`)
    .join(' / ');
  elm.appendChild(line);
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
    label.textContent = `${e.inning}回${e.half === 'top' ? '表' : '裏'} ${EVENT_LABELS[e.type] || e.type}${runnerName ? ' ' + runnerName : ''}`;
    row.appendChild(label);
    const delBtn = document.createElement('button');
    delBtn.textContent = '取消';
    delBtn.className = 'btn-small btn-danger';
    delBtn.addEventListener('click', () => handlers.onDeleteEvent(e));
    row.appendChild(delBtn);
    elm.appendChild(row);
  }
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
