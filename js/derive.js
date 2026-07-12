// 打席・イベント一覧から「現在の入力対象」を都度導出する純粋関数群。
// サーバー側にポインタ状態を持たない設計(実装計画フェーズ2参照)。

export const OUT_RESULTS = new Set(['groundout', 'flyout', 'strikeout', 'sac_bunt', 'sac_fly']);
// fielders_choiceは、打者自身の結果だけでは自動的にアウトとしない(自チーム・相手チーム共通)。
// 併殺(打者もアウト)か野選(打者はセーフ、走者のみアウト)かでアウト数が変わるため、
// 走者への明示的なアウトマーキング(runner_out_advancingイベント)からのみアウトを数える。
// 走者が単独でアウトになるイベントもアウトカウントに加える(盗塁死・走塁死)。
// 例: 「右前ヒットで2塁を狙って走塁死」→打席自体はヒットだが、このイベントでアウトが1つ増える。
export const OUT_EVENT_TYPES = new Set(['caught_stealing', 'runner_out_advancing']);

// scripts/aggregate.py の AB_RESULTS と同じ(rules/集計ルール.md ルール2)。
export const AB_RESULTS = new Set([
  'groundout', 'flyout', 'strikeout', 'single', 'double', 'triple', 'home_run',
  'fielders_choice', 'reached_on_error', 'strikeout_reached',
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
    if (item.kind !== 'atbat') return OUT_EVENT_TYPES.has(item.ref.type);
    return OUT_RESULTS.has(item.ref.result);
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

// 出塁した結果ごとの初期塁。以降の進塁は盗塁イベント・runner_advanceイベントで明示的に反映する。
const BASE_ON_HIT = {
  single: 'first', walk: 'first', hbp: 'first', reached_on_error: 'first', fielders_choice: 'first',
  strikeout_reached: 'first',
  double: 'second', triple: 'third',
};
const NEXT_BASE = { first: 'second', second: 'third' };

// 現在の半イニングで塁に出ていて、まだ生還・アウトになっていない走者一覧を返す(攻撃側・守備側共通)。
// 走者は「出塁した打席のid」で識別する(相手選手には安定した選手idが無いため。自チームは
// 選手id、相手チームはopponent_batter_nameを表示用に持たせる)。
// 進塁は、盗塁イベント(1つ先の塁へ)とrunner_advanceイベント(明示的な進塁先)の両方を反映する。
export function deriveRunnersOnBase(game, atbats, events) {
  const { inning, half } = deriveInningState(atbats, events);

  const onBase = new Map(); // atbatId -> {atbatId, batterId, orderNo, base, opponentBatterName}
  for (const a of aliveAtbats(atbats)) {
    if (a.inning !== inning || a.half !== half) continue;
    if (a.scored) continue;
    const base = BASE_ON_HIT[a.result];
    if (!base) continue;
    onBase.set(a.id, {
      atbatId: a.id, batterId: a.batter_id, orderNo: a.order_no, base,
      opponentBatterName: a.batter_id === 'opponent' ? (a.opponent_batter_name || null) : null,
    });
  }

  for (const item of mergeTimeline(atbats, events)) {
    if (item.kind !== 'event') continue;
    const e = item.ref;
    if (e.inning !== inning || e.half !== half) continue;
    if (e.runner_atbat_id == null) continue;
    if (e.type === 'caught_stealing' || e.type === 'runner_out_advancing') {
      onBase.delete(e.runner_atbat_id);
    } else if (e.type === 'stolen_base') {
      const r = onBase.get(e.runner_atbat_id);
      if (r && NEXT_BASE[r.base]) r.base = NEXT_BASE[r.base];
    } else if (e.type === 'runner_advance') {
      // to_base='home'は生還(暴投・ボーク等、打席を介さない生還)を表す。塁ではないのでonBaseから除く。
      if (e.to_base === 'home') {
        onBase.delete(e.runner_atbat_id);
      } else {
        const r = onBase.get(e.runner_atbat_id);
        if (r && e.to_base) r.base = e.to_base;
      }
    }
  }

  return [...onBase.values()];
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
