// 打席・イベント一覧から「現在の入力対象」を都度導出する純粋関数群。
// サーバー側にポインタ状態を持たない設計(実装計画フェーズ2参照)。

export const OUT_RESULTS = new Set(['groundout', 'flyout', 'strikeout', 'fielders_choice']);

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

// 次の打席が何回・表裏・アウト数から始まるかを、直近の非削除レコードから計算する。
export function deriveInningState(atbats) {
  const alive = aliveAtbats(atbats);
  if (alive.length === 0) {
    return { inning: 1, half: 'top', outs: 0 };
  }
  const last = alive[alive.length - 1];
  const outsAfter = (last.outs_before ?? 0) + (OUT_RESULTS.has(last.result) ? 1 : 0);
  if (outsAfter >= 3) {
    if (last.half === 'top') {
      return { inning: last.inning, half: 'bottom', outs: 0 };
    }
    return { inning: last.inning + 1, half: 'top', outs: 0 };
  }
  return { inning: last.inning, half: last.half, outs: outsAfter };
}

// 攻撃側(自チーム打撃)なら次の打者、守備側(相手打撃=投手成績)なら現在の投手を返す。
export function derivePointer(game, atbats) {
  const inningState = deriveInningState(atbats);
  const isOurHalf = inningState.half === game.our_half;
  const alive = aliveAtbats(atbats);

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
      lastAliveId: alive.length ? alive[alive.length - 1].id : null,
    };
  }

  const defAtbats = alive.filter((a) => a.half !== game.our_half);
  const currentPitcherId = defAtbats.length ? defAtbats[defAtbats.length - 1].pitcher_id : null;
  return {
    ...inningState,
    side: 'defense',
    currentPitcherId,
    lastAliveId: alive.length ? alive[alive.length - 1].id : null,
  };
}

// 送信前の楽観的整合性チェック: フォームを開いた時点のポインタと、実際の最新状態を突き合わせる。
// 一致しなければ「他の人が入力した」とみなして送信をブロックする(UI/UXレビュー反映)。
export function pointerMatchesExpected(expectedLastAliveId, atbats) {
  const alive = aliveAtbats(atbats);
  const actualLastId = alive.length ? alive[alive.length - 1].id : null;
  return actualLastId === expectedLastAliveId;
}
