// 打席・イベント一覧から「現在の入力対象」を都度導出する純粋関数群。
// サーバー側にポインタ状態を持たない設計(実装計画フェーズ2参照)。

// interference_out=守備妨害(打者アウト)。
export const OUT_RESULTS = new Set(['groundout', 'flyout', 'strikeout', 'sac_bunt', 'sac_fly', 'interference_out']);
// 守備側の失策が記録される結果(スコアボードのE列)。打撃妨害・走塁妨害は公認野球規則上、
// 妨害した野手に失策が記録される。
export const ERROR_RESULTS = new Set(['reached_on_error', 'catcher_interference', 'obstruction']);
// fielders_choiceは、打者自身の結果だけでは自動的にアウトとしない(自チーム・相手チーム共通)。
// 併殺(打者もアウト)か野選(打者はセーフ、走者のみアウト)かでアウト数が変わるため、
// 走者への明示的なアウトマーキング(runner_out_advancingイベント)からのみアウトを数える。
// 走者が単独でアウトになるイベントもアウトカウントに加える(盗塁死・走塁死)。
// 例: 「右前ヒットで2塁を狙って走塁死」→打席自体はヒットだが、このイベントでアウトが1つ増える。
export const OUT_EVENT_TYPES = new Set(['caught_stealing', 'runner_out_advancing']);

// scripts/aggregate.py の AB_RESULTS と同じ(rules/集計ルール.md ルール2)。
export const AB_RESULTS = new Set([
  'groundout', 'flyout', 'strikeout', 'single', 'double', 'triple', 'home_run',
  'fielders_choice', 'reached_on_error', 'strikeout_reached', 'interference_out',
]);
// 打撃妨害(catcher_interference)・走塁妨害(obstruction)で一塁を与えられた打席は打数に数えない。

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
  strikeout_reached: 'first', catcher_interference: 'first', obstruction: 'first',
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

// deriveRunnersOnBaseと同じロジックだが、「現在」ではなく指定した打席(targetAtbatId)が
// 行われる直前の時点の走者状態を再現する(打席編集フォームで、その打席当時の走者一覧を
// 表示するために使う)。deriveRunnersOnBaseがscored=trueの打席を無条件にスキップするのは
// 「現在」の走者一覧としては正しいが、それだけでは「いつ生還したか」が分からないため、
// ここではtargetAtbatId自身が現れる直前でタイムラインの走査を打ち切ることで対応する
// (targetAtbatIdより後の情報は一切見ない)。
export function deriveRunnersOnBaseBefore(game, atbats, events, targetAtbatId) {
  const target = aliveAtbats(atbats).find((a) => a.id === targetAtbatId);
  if (!target) return [];
  const { inning, half } = target;

  const onBase = new Map();
  for (const item of mergeTimeline(atbats, events)) {
    if (item.kind === 'atbat' && item.ref.id === targetAtbatId) break;
    if (item.ref.inning !== inning || item.ref.half !== half) continue;

    if (item.kind === 'atbat') {
      const a = item.ref;
      if (a.scored) continue;
      const base = BASE_ON_HIT[a.result];
      if (!base) continue;
      onBase.set(a.id, {
        atbatId: a.id, batterId: a.batter_id, orderNo: a.order_no, base,
        opponentBatterName: a.batter_id === 'opponent' ? (a.opponent_batter_name || null) : null,
      });
    } else {
      const e = item.ref;
      if (e.runner_atbat_id == null) continue;
      if (e.type === 'caught_stealing' || e.type === 'runner_out_advancing') {
        onBase.delete(e.runner_atbat_id);
      } else if (e.type === 'stolen_base') {
        const r = onBase.get(e.runner_atbat_id);
        if (r && NEXT_BASE[r.base]) r.base = NEXT_BASE[r.base];
      } else if (e.type === 'runner_advance') {
        if (e.to_base === 'home') {
          onBase.delete(e.runner_atbat_id);
        } else {
          const r = onBase.get(e.runner_atbat_id);
          if (r && e.to_base) r.base = e.to_base;
        }
      }
    }
  }

  return [...onBase.values()];
}

// 送信しようとしている内容で、塁状況に矛盾が起きないかを検査する(試合20261114で、野選の際に
// 三塁走者が「そのまま」のまま二塁走者を三塁へ進め、三塁に2人いる状態で記録されて得点が1点
// 抜けた・アウトの打者に「生還した」が付いて得点が1点多くなった、という入力ミスの再発防止)。
// runners: 現在の塁上の走者 [{atbatId, base, label}]
// moves: Map(atbatId -> 'none' | 'scored' | 'out' | 'advance:<base>')(無い走者は'none'扱い)
// batter: 打者走者 {result, scored, advanceTo, label}(クイックイベント時はnull)
// 戻り値: エラー説明文の配列(空なら問題なし)。
const BASE_NAMES = { first: '一塁', second: '二塁', third: '三塁' };
const BASE_ORDER = { first: 1, second: 2, third: 3 };
export function findBaseConflicts({ runners, moves, batter }) {
  const errors = [];
  const occupants = { first: [], second: [], third: [] };
  // 元から同じ塁に重なっていた走者(過去データの不整合)が「そのまま」なのは、今回の送信の責任では
  // ないためエラーにしない(その場合も送信できなくなって試合が止まるのを避ける)。
  const preexisting = new Set();
  const countByBase = {};
  for (const r of runners) countByBase[r.base] = (countByBase[r.base] || 0) + 1;

  for (const r of runners) {
    const mv = moves.get(r.atbatId) || 'none';
    if (mv === 'scored' || mv === 'out') continue;
    const to = mv.startsWith('advance:') ? mv.slice('advance:'.length) : r.base;
    if (to === 'home') continue;
    if (BASE_ORDER[to] < BASE_ORDER[r.base]) {
      errors.push(`${r.label}が${BASE_NAMES[r.base]}から${BASE_NAMES[to]}へ戻ることになっています。`);
    }
    if (mv === 'none' && countByBase[r.base] > 1) preexisting.add(r.atbatId);
    if (occupants[to]) occupants[to].push({ label: r.label, atbatId: r.atbatId });
  }

  if (batter) {
    const isOut = OUT_RESULTS.has(batter.result);
    if (isOut && batter.scored) {
      errors.push(`打者(${batter.label})はアウトの結果なので「生還した」は付けられません。生還したのは塁上の走者のはずなので、走者の欄で「生還」を選んでください。`);
    } else if (!isOut && !batter.scored && batter.result !== 'home_run') {
      const to = batter.advanceTo && batter.advanceTo !== 'none' ? batter.advanceTo : BASE_ON_HIT[batter.result];
      if (to && to !== 'home' && occupants[to]) occupants[to].push({ label: `打者(${batter.label})`, atbatId: null });
    }
  }

  for (const base of ['first', 'second', 'third']) {
    const list = occupants[base];
    if (list.length < 2) continue;
    if (list.every((o) => o.atbatId != null && preexisting.has(o.atbatId))) continue;
    errors.push(`${list.map((o) => o.label).join('と')}が同時に${BASE_NAMES[base]}にいることになります。前の走者を進塁・生還・アウトのどれかにしてください(例: 野選でホームセーフなら三塁走者は「生還」)。`);
  }
  return errors;
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

// 試合結果画面用: イニングごとの得点(スコアボード)と自チームの個人打撃成績を導出する。
// 得点はderiveScoreと同じくscoredフラグの数(投手成績OFFの簡易入力区間も含む)。
const HIT_RESULTS = new Set(['single', 'double', 'triple', 'home_run']);

export function deriveGameSummary(game, atbats) {
  const alive = aliveAtbats(atbats);
  const ourHalf = game.our_half || 'bottom';
  const lastInning = alive.reduce((m, a) => Math.max(m, a.inning || 0), 0);
  const innings = Math.max(lastInning, 1);
  const rows = { top: Array(innings).fill(0), bottom: Array(innings).fill(0) };
  const played = { top: new Set(), bottom: new Set() };
  // H=その半の攻撃側の安打数、E=その半の守備側の失策数(=攻撃側の失策出塁・妨害出塁の数)。
  // スコアボードの行は攻撃側チームなので、E列はもう一方の半(相手攻撃中)の数を表示する。
  const hits = { top: 0, bottom: 0 };
  const errorsWhileBatting = { top: 0, bottom: 0 };
  // 投手成績OFFの簡易入力(相手打席でpitcher_idなし)は安打・失策の区別が無いため、含まれる半は不明扱い。
  const unknown = { top: false, bottom: false };
  for (const a of alive) {
    played[a.half].add(a.inning);
    if (a.scored) rows[a.half][a.inning - 1] += 1;
    if (HIT_RESULTS.has(a.result)) hits[a.half] += 1;
    if (ERROR_RESULTS.has(a.result)) errorsWhileBatting[a.half] += 1;
    if (a.batter_id === 'opponent' && !a.pitcher_id) unknown[a.half] = true;
  }
  const other = (h) => (h === 'top' ? 'bottom' : 'top');
  const hitsByHalf = {
    top: unknown.top ? null : hits.top,
    bottom: unknown.bottom ? null : hits.bottom,
  };
  const errorsByHalf = {
    top: unknown[other('top')] ? null : errorsWhileBatting[other('top')],
    bottom: unknown[other('bottom')] ? null : errorsWhileBatting[other('bottom')],
  };
  const ourHits = hits[ourHalf];
  // 攻撃が無かった半イニング(後攻のサヨナラ・最終回裏不要など)は「X」/空欄で表示するためnullにする。
  for (const half of ['top', 'bottom']) {
    for (let i = 0; i < innings; i++) {
      if (!played[half].has(i + 1)) rows[half][i] = null;
    }
  }
  const total = (h) => rows[h].reduce((s, v) => s + (v || 0), 0);
  const ours = total(ourHalf);
  const opponent = total(ourHalf === 'top' ? 'bottom' : 'top');

  const batting = new Map();
  for (const a of alive) {
    if (a.half !== ourHalf || a.batter_id === 'opponent') continue;
    if (!batting.has(a.batter_id)) {
      batting.set(a.batter_id, { batterId: a.batter_id, orderNo: a.order_no, ab: 0, hits: 0, rbi: 0, runs: 0, results: [] });
    }
    const b = batting.get(a.batter_id);
    if (a.ab ?? isAtBat(a.result)) b.ab += 1;
    if (HIT_RESULTS.has(a.result)) b.hits += 1;
    b.rbi += a.rbi || 0;
    if (a.scored) b.runs += 1;
    b.results.push({ result: a.result, detail: a.detail || null });
  }
  const lineupOrder = new Map((game.lineup || []).map((r) => [r.batter_id, r.order_no]));
  const battingList = [...batting.values()].sort(
    (x, y) => (lineupOrder.get(x.batterId) ?? x.orderNo ?? 99) - (lineupOrder.get(y.batterId) ?? y.orderNo ?? 99)
  );

  return { innings, rows, ourHalf, ours, opponent, ourHits, hitsByHalf, errorsByHalf, batting: battingList };
}

// 送信前の楽観的整合性チェック: フォームを開いた時点のポインタと、実際の最新状態を突き合わせる。
// 一致しなければ「他の人が入力した」とみなして送信をブロックする(UI/UXレビュー反映)。
export function pointerMatchesExpected(expectedLastAliveKey, atbats, events) {
  const alive = aliveAtbats(atbats);
  const aliveEv = aliveEvents(events);
  const actualKey = `${alive.length ? `a${alive[alive.length - 1].id}` : ''}|${aliveEv.length ? `e${aliveEv[aliveEv.length - 1].id}` : ''}`;
  return actualKey === expectedLastAliveKey;
}
