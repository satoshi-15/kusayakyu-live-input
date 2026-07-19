// 「結果」欄で打球方向まで含めて1つずつ選択できるようにするための選択肢一覧。
// ラベル文字列(label/detail)はscripts/field_maps/skytree_map.jsonのdetail_to_codeキーと完全一致させる
// (実サイト登録時に位置別コードへ正しく変換できるようにするため)。このため表示上の短縮名は
// 別フィールドshortLabelに持たせ、label自体は変更しない(見た目だけ短くする)。
// value(result)はrules/集計ルール.md・scripts/validate.pyのresult enumと同じ。

const POSITIONS = ['ピッチャー', 'キャッチャー', 'ファースト', 'セカンド', 'サード', 'ショート'];
const OUTFIELD = ['レフト', 'センター', 'ライト'];

// 選択肢一覧での表示を短くするための略称(カタカナが多く見づらいという指摘への対応)。
const POS_SHORT = {
  'ピッチャー': '投', 'キャッチャー': '捕', 'ファースト': '一', 'セカンド': '二',
  'サード': '三', 'ショート': '遊', 'レフト': '左', 'センター': '中', 'ライト': '右',
};

function build() {
  const options = [];

  for (const pos of [...POSITIONS, ...OUTFIELD]) {
    options.push({ label: `${pos}ゴロ`, shortLabel: `${POS_SHORT[pos]}ゴロ`, result: 'groundout', detail: `${pos}ゴロ`, group: 'ゴロアウト' });
  }
  for (const pos of [...POSITIONS, ...OUTFIELD]) {
    options.push({ label: `${pos}フライ`, shortLabel: `${POS_SHORT[pos]}飛`, result: 'flyout', detail: `${pos}フライ`, group: 'フライアウト' });
  }
  for (const pos of [...POSITIONS, ...OUTFIELD]) {
    options.push({ label: `${pos}ライナー`, shortLabel: `${POS_SHORT[pos]}直`, result: 'flyout', detail: `${pos}ライナー`, group: 'ライナーアウト' });
  }
  for (const pos of POSITIONS) {
    options.push({ label: `${pos}内野安打`, shortLabel: `${POS_SHORT[pos]}内野安打`, result: 'single', hitType: 'single', detail: `${pos}内野安打`, group: '内野安打' });
  }
  for (const pos of OUTFIELD) {
    options.push({ label: `${pos}前ヒット`, shortLabel: `${POS_SHORT[pos]}前安打`, result: 'single', hitType: 'single', detail: `${pos}前ヒット`, group: '単打' });
  }
  for (const pos of OUTFIELD) {
    options.push({ label: `${pos}二塁打`, shortLabel: `${POS_SHORT[pos]}二塁打`, result: 'double', hitType: 'double', detail: `${pos}二塁打`, group: '二塁打' });
  }
  for (const pos of OUTFIELD) {
    options.push({ label: `${pos}三塁打`, shortLabel: `${POS_SHORT[pos]}三塁打`, result: 'triple', hitType: 'triple', detail: `${pos}三塁打`, group: '三塁打' });
  }
  // エラーはゴロ/フライを区別する意味が薄いため、どのポジションが失策したかのみを選ぶ形にする
  // (9ポジション全て。以前はゴロ/フライ別の一部組み合わせのみだった)。
  for (const pos of [...POSITIONS, ...OUTFIELD]) {
    options.push({ label: `${pos}エラー`, shortLabel: `${POS_SHORT[pos]}エラー`, result: 'reached_on_error', detail: `${pos}エラー`, group: '失策で出塁' });
  }

  options.push({ label: '本塁打', result: 'home_run', hitType: 'home_run', detail: '本塁打', group: 'その他' });
  options.push({ label: '三振', result: 'strikeout', detail: null, group: 'その他' });
  options.push({ label: '振り逃げ(出塁)', shortLabel: '振り逃げ', result: 'strikeout_reached', detail: '振り逃げ', group: 'その他' });
  options.push({ label: '四球', result: 'walk', detail: null, group: 'その他' });
  options.push({ label: '死球', result: 'hbp', detail: null, group: 'その他' });
  options.push({ label: '犠打', result: 'sac_bunt', detail: null, group: 'その他' });
  options.push({ label: '犠飛', result: 'sac_fly', detail: null, group: 'その他' });
  options.push({ label: '野選(フィルダースチョイス)', result: 'fielders_choice', detail: null, group: 'その他' });

  return options;
}

export const RESULT_OPTIONS = build();

export function findResultOption(label) {
  return RESULT_OPTIONS.find((o) => o.label === label) || null;
}

// 既存のatbatレコード(result/detail)から、結果セレクトで選ぶべき選択肢を逆引きする(打席編集フォームの
// 初期表示に使う)。detailが設定されている結果(打球方向つき)はdetail完全一致で引く。fielders_choice/
// sac_flyは元の打球方向(セカンドゴロ/センターフライ等)がdetailにそのまま残っているため、この経路で
// 正しく元の打球方向の選択肢に戻る(実際のfielders_choice/sac_fly化はbatter-fc-box/sac-fly-boxの
// サブ選択で別途表現する。js/app.jsのhandleEditAtbat参照)。detailが無い結果(三振・四球等)は
// resultの完全一致(かつdetailを持たない選択肢)で引く。
export function findResultOptionForAtbat(atbat) {
  if (atbat.detail) {
    const byDetail = RESULT_OPTIONS.find((o) => o.detail === atbat.detail);
    if (byDetail) return byDetail;
  }
  return RESULT_OPTIONS.find((o) => o.result === atbat.result && !o.detail) || null;
}
