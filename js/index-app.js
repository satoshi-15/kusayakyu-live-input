import { createGame, fetchPlayers } from './api.js';

const lineupRowsElm = document.getElementById('lineup-rows');
const addRowBtn = document.getElementById('add-lineup-row');
const form = document.getElementById('new-game-form');
const errorElm = document.getElementById('error-message');

let players = [];

function addLineupRow(orderNo) {
  const row = document.createElement('div');
  row.className = 'lineup-row';
  row.innerHTML = `
    <label>${orderNo}番
      <select data-order="${orderNo}">
        <option value="">選手を選択</option>
        ${players.map((p) => `<option value="${p.id}">${p.display_name}</option>`).join('')}
        <option value="__other__">その他(自由入力)</option>
      </select>
    </label>
  `;
  lineupRowsElm.appendChild(row);
}

async function init() {
  try {
    players = await fetchPlayers();
  } catch (e) {
    players = [];
  }
  for (let i = 1; i <= 9; i++) addLineupRow(i);
  addRowBtn.addEventListener('click', () => addLineupRow(lineupRowsElm.children.length + 1));
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorElm.textContent = '';

  const opponentName = document.getElementById('opponent-name').value.trim();
  const gameDate = document.getElementById('game-date').value;
  const ourHalf = document.getElementById('our-half').value;
  const gameId = gameDate.replace(/-/g, '');

  const lineup = [...lineupRowsElm.querySelectorAll('select')]
    .map((sel) => ({ order_no: Number(sel.dataset.order), batter_id: sel.value }))
    .filter((r) => r.batter_id && r.batter_id !== '__other__');

  try {
    const accessToken = await createGame({ gameId, opponentName, gameDate, ourHalf, lineup });
    localStorage.setItem(`kusayakyu:${gameId}:token`, accessToken);
    window.location.href = `./game.html#game=${encodeURIComponent(gameId)}&token=${encodeURIComponent(accessToken)}`;
  } catch (e) {
    errorElm.textContent = `試合を作成できませんでした: ${e.message || e}`;
  }
});

init();
