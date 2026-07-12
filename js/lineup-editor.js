// 打順(選手+守備位置)の行を描画・収集するロジック。新規試合作成画面(index-app.js)と
// 試合中のオーダー編集(app.js)の両方で使う共有モジュール。

// scripts/field_maps/skytree_map.json の syubi_dropdown_options と揃える(先頭の"-"を除く)。
export const POSITIONS = ['投', '捕', '一', '二', '三', '遊', '左', '中', '右', 'DH'];

// containerElmに1行追加する。prefillを渡すと既存の選択状態を復元する(オーダー編集時に使用)。
export function addLineupRow(containerElm, orderNo, players, prefill) {
  const row = document.createElement('div');
  row.className = 'lineup-row';
  const selectedBatter = prefill?.batter_id || '';
  const selectedPosition = prefill?.position || '';
  row.innerHTML = `
    <label>${orderNo}番
      <select data-role="batter" data-order="${orderNo}">
        <option value="">選手を選択</option>
        ${players.map((p) => `<option value="${p.id}"${p.id === selectedBatter ? ' selected' : ''}>${p.display_name}</option>`).join('')}
        <option value="__other__"${selectedBatter === '__other__' ? ' selected' : ''}>その他(自由入力)</option>
      </select>
    </label>
    <label>守備位置
      <select data-role="position" data-order="${orderNo}">
        <option value="">選択</option>
        ${POSITIONS.map((p) => `<option value="${p}"${p === selectedPosition ? ' selected' : ''}>${p}</option>`).join('')}
      </select>
    </label>
  `;
  containerElm.appendChild(row);
}

// containerElm内の全行から、RPCにそのまま渡せる形のlineup配列を組み立てる。
export function collectLineup(containerElm) {
  const batterSelects = [...containerElm.querySelectorAll('[data-role="batter"]')];
  return batterSelects
    .map((sel) => {
      const positionSel = containerElm.querySelector(`[data-role="position"][data-order="${sel.dataset.order}"]`);
      return {
        order_no: Number(sel.dataset.order),
        batter_id: sel.value,
        position: positionSel.value || null,
      };
    })
    .filter((r) => r.batter_id && r.batter_id !== '__other__');
}
