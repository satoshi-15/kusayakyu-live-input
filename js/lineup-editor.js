// 打順(選手+守備位置)の行を描画・収集するロジック。新規試合作成画面(index-app.js)と
// 試合中のオーダー編集(app.js)の両方で使う共有モジュール。
import { addGuestPlayer } from './api.js';

// scripts/field_maps/skytree_map.json の syubi_dropdown_options と揃える(先頭の"-"を除く)。
export const POSITIONS = ['投', '捕', '一', '二', '三', '遊', '左', '中', '右', 'DH'];

// containerElmに1行追加する。prefillを渡すと既存の選択状態を復元する(オーダー編集時に使用)。
// playersは呼び出し元(index-app.js/app.js)が保持する配列を直接渡す。助っ人をその場登録した際は
// この配列にも追加する(同じ配列を全行で共有しているため、以降に描画される行の選択肢にも載る)。
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
        <option value="__other__"${selectedBatter === '__other__' ? ' selected' : ''}>その他(助っ人をその場で登録)</option>
      </select>
    </label>
    <label>守備位置
      <select data-role="position" data-order="${orderNo}">
        <option value="">選択</option>
        ${POSITIONS.map((p) => `<option value="${p}"${p === selectedPosition ? ' selected' : ''}>${p}</option>`).join('')}
      </select>
    </label>
    <div class="guest-register-box hidden">
      <input type="text" class="guest-name-input" placeholder="表示名(例: 大倉)" />
      <button type="button" class="btn-small guest-register-btn">登録して選択</button>
    </div>
  `;
  containerElm.appendChild(row);

  const batterSelect = row.querySelector('[data-role="batter"]');
  const guestBox = row.querySelector('.guest-register-box');
  const guestNameInput = row.querySelector('.guest-name-input');
  const guestRegisterBtn = row.querySelector('.guest-register-btn');

  batterSelect.addEventListener('change', () => {
    guestBox.classList.toggle('hidden', batterSelect.value !== '__other__');
  });

  guestRegisterBtn.addEventListener('click', async () => {
    const displayName = guestNameInput.value.trim();
    if (!displayName) { alert('表示名を入力してください'); return; }
    guestRegisterBtn.disabled = true;
    try {
      // IDはユーザーに入力させず自動生成する(手入力の負荷・衝突リスクを避けるため)。
      const id = `guest_${crypto.randomUUID().slice(0, 8)}`;
      const player = await addGuestPlayer(id, displayName);
      players.push(player);
      const opt = document.createElement('option');
      opt.value = player.id;
      opt.textContent = player.display_name;
      batterSelect.insertBefore(opt, batterSelect.querySelector('option[value="__other__"]'));
      batterSelect.value = player.id;
      guestBox.classList.add('hidden');
      guestNameInput.value = '';
      batterSelect.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      alert(`助っ人の登録に失敗しました: ${e.message || e}`);
    } finally {
      guestRegisterBtn.disabled = false;
    }
  });
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
