// 打席・イベント一覧から「現在の入力対象」を都度導出する純粋関数群。
// サーバー側にポインタ状態を持たない設計(実装計画フェーズ2参照)。

export const OUT_RESULTS = new Set(['groundout', 'flyout', 'strikeout', 'fielders_choice']);
// 走者が単独でアウトになるイベントもアウトカウントに加える(盗塁死・走塁死)。
// 例: 「右前ヒットで2塁を狙って走塁死」→打席自体はヒットだが、このイベントでアウトが1つ増える。
export const OUT_EVENT_TYPES = new Set(['caught_stealing', 'runner_out_advancing']);

// scripts/aggregate.py の AB_RESULTS と同じ(rules/集計ルール.md ルール2)。
export const AB_RESULTS = new Set([
  'groundout', 'flyout', 'strikeout', 'single', 'double', 'triple', 'home_run',
  'fielders_choice', 'reached_on_error',
]);

export function isAtBat(result) {
  return AB_RESULTS.has(result);
}

export function aliveAtbats(atbats) {
  return atbats.filter((a) => !a.deleted_at).sort((a, b) => a.id - b.id);
}

export function aliveEvents(events) {
  return events.filter((e) => !e.deleted_at).sort((a, b) => a.id - b.id);
}

// 打席とイベントを記録時刻順にマージする(打席の結果自体はアウトでなくても、
// その直後の走塁死イベントでアウトが増えるケースを正しく数えるため)。
function mergeTimeline(atbats, events) {
  const a = aliveAtbats(atbats).map((x) => ({ kind: 'atbat', ts: x.created_at, id: x.id, ref: x }));
  const e = aliveEvents(events).map((x) => ({ kind: 'event', ts: x.created_at, id: x.id, ref: x }));
  return [...a, ...e].sort((x, y) => {
    const t = new Date(x.ts) - new Date(y.ts);
    return t !== 0 ? t : x.id - y.id;
  });
}

// 次の打席が何回・表裏・アウト数から始まるかを、直近の非削除レコード(打席+イベント)から計算する。
export function deriveInningState(atbats, events) {
  const timeline = mergeTimeline(atbats, events);
  if (timeline.length === 0) {
    return { inning: 1, half: 'top', outs: 0 };
  }
  const last = timeline[timeline.length - 1];
  const inning = last.ref.inning;
  const half = last.ref.half;

  // この(inning, half)内のアウト数を、打席の結果とアウトイベントの両方から数える。
  const outsInHalf = timeline.filter((item) => {
    if (item.ref.inning !== inning || item.ref.half !== half) return false;
    return item.kind === 'atbat' ? OUT_RESULTS.has(item.ref.result) : OUT_EVENT_TYPES.has(item.ref.type);
  }).length;

  if (outsInHalf >= 3) {
    if (half === 'top') {
      return { inning, half: 'bottom', outs: 0 };
    }
    return { inning: inning + 1, half: 'top', outs: 0 };
  }
  return { inning, half, outs: outsInHalf };
}

// 攻撃側(自チーム打撃)なら次の打者、守備側(相手打撃=投手成績)なら現在の投手を返す。
export function derivePointer(game, atbats, events) {
  const inningState = deriveInningState(atbats, events);
  const isOurHalf = inningState.half === game.our_half;
  const alive = aliveAtbats(atbats);
  const aliveEv = aliveEvents(events);
  const lastAliveKey = `${alive.length ? `a${alive[alive.length - 1].id}` : ''}|${aliveEv.length ? `e${aliveEv[aliveEv.length - 1].id}` : ''}`;

  if (isOurHalf) {
    const lineup = game.lineup || [];
    const ourAtbats = alive.filter((a) => a.half === game.our_half && a.batter_id !== 'opponent');
    const lastOrderNo = ourAtbats.length ? ourAtbats[ourAtbats.length - 1].order_no : 0;
    const nextOrderNo = lineup.length ? (lastOrderNo % lineup.length) + 1 : null;
    const nextBatter = lineup.find((p) => p.order_no === nextOrderNo) || null;
    return {
      ...inningState,
      side: 'offense',
      nextOrderNo,
      nextBatterId: nextBatter ? nextBatter.batter_id : null,
      lastAliveKey,
    };
  }

  const defAtbats = alive.filter((a) => a.half !== game.our_half);
  const currentPitcherId = defAtbats.length ? defAtbats[defAtbats.length - 1].pitcher_id : null;
  return {
    ...inningState,
    side: 'defense',
    currentPitcherId,
    lastAliveKey,
  };
}

// 現在のスコア(自チーム・相手それぞれの生還数)を集計する。
// 投手成績OFF中も相手の得点だけは把握できるようにするための軽量表示用(公式記録への登録は別途手動)。
export function deriveScore(atbats) {
  const alive = aliveAtbats(atbats);
  let ours = 0;
  let opponent = 0;
  for (const a of alive) {
    if (!a.scored) continue;
    if (a.batter_id === 'opponent') opponent += 1;
    else ours += 1;
  }
  return { ours, opponent };
}

// 送信前の楽観的整合性チェック: フォームを開いた時点のポインタと、実際の最新状態を突き合わせる。
// 一致しなければ「他の人が入力した」とみなして送信をブロックする(UI/UXレビュー反映)。
export function pointerMatchesExpected(expectedLastAliveKey, atbats, events) {
  const alive = aliveAtbats(atbats);
  const aliveEv = aliveEvents(events);
  const actualKey = `${alive.length ? `a${alive[alive.length - 1].id}` : ''}|${aliveEv.length ? `e${aliveEv[aliveEv.length - 1].id}` : ''}`;
  return actualKey === expectedLastAliveKey;
}
