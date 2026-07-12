import { createGame, fetchPlayers } from './api.js';
import { addLineupRow, collectLineup } from './lineup-editor.js';

const lineupRowsElm = document.getElementById('lineup-rows');
const addRowBtn = document.getElementById('add-lineup-row');
const form = document.getElementById('new-game-form');
const errorElm = document.getElementById('error-message');

let players = [];

async function init() {
  try {
    players = await fetchPlayers();
  } catch (e) {
    players = [];
  }
  for (let i = 1; i <= 9; i++) addLineupRow(lineupRowsElm, i, players);
  addRowBtn.addEventListener('click', () => {
    const nextOrder = lineupRowsElm.querySelectorAll('[data-role="batter"]').length + 1;
    addLineupRow(lineupRowsElm, nextOrder, players);
  });
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorElm.textContent = '';

  const opponentName = document.getElementById('opponent-name').value.trim();
  const gameDate = document.getElementById('game-date').value;
  const ourHalf = document.getElementById('our-half').value;
  const trackPitching = document.getElementById('track-pitching-checkbox').checked;
  const gameId = gameDate.replace(/-/g, '');

  const lineup = collectLineup(lineupRowsElm);

  try {
    const accessToken = await createGame({ gameId, opponentName, gameDate, ourHalf, lineup, trackPitching });
    localStorage.setItem(`kusayakyu:${gameId}:token`, accessToken);
    window.location.href = `./game.html#game=${encodeURIComponent(gameId)}&token=${encodeURIComponent(accessToken)}`;
  } catch (e) {
    if (e.code === '23505') {
      errorElm.textContent = `この日付(${gameDate})の試合は既に作成されています。同じ日に2試合ある場合は今のところ非対応です。`;
    } else {
      errorElm.textContent = `試合を作成できませんでした: ${e.message || e}`;
    }
  }
});

init();
