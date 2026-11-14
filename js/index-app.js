import { createGame, fetchPlayers, listOpenGames } from './api.js';
import { addLineupRow, collectLineup } from './lineup-editor.js';

const lineupRowsElm = document.getElementById('lineup-rows');
const addRowBtn = document.getElementById('add-lineup-row');
const form = document.getElementById('new-game-form');
const errorElm = document.getElementById('error-message');
const openGamesBox = document.getElementById('open-games-box');
const openGamesList = document.getElementById('open-games-list');

let players = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function renderOpenGames() {
  let games = [];
  try {
    games = await listOpenGames();
  } catch (e) {
    games = [];
  }
  if (!games.length) {
    openGamesBox.classList.add('hidden');
    return;
  }
  openGamesList.innerHTML = games.map((g) => `
    <div class="open-game-row">
      <span>${escapeHtml(g.opponent_name || '(対戦相手未設定)')} <span class="field-hint">(${escapeHtml(g.game_date || '')})</span></span>
      <a class="btn-primary open-game-join" href="./game.html#game=${encodeURIComponent(g.game_id)}&token=${encodeURIComponent(g.access_token)}">入室する</a>
    </div>
  `).join('');
  openGamesBox.classList.remove('hidden');
}

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
  renderOpenGames();
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorElm.textContent = '';

  const opponentName = document.getElementById('opponent-name').value.trim();
  const gameDate = document.getElementById('game-date').value;
  const ourHalf = document.getElementById('our-half').value;
  const trackPitching = document.getElementById('track-pitching-checkbox').checked;
  const gameType = document.getElementById('game-type').value;
  const baseId = gameDate.replace(/-/g, '');

  const lineup = collectLineup(lineupRowsElm);

  // 同じ日の2試合目以降(ダブルヘッダー)は 20261114_2, 20261114_3 ... のIDで作成する。
  for (let n = 1; n <= 5; n++) {
    const gameId = n === 1 ? baseId : `${baseId}_${n}`;
    try {
      const accessToken = await createGame({ gameId, opponentName, gameDate, ourHalf, lineup, trackPitching, gameType });
      localStorage.setItem(`kusayakyu:${gameId}:token`, accessToken);
      window.location.href = `./game.html#game=${encodeURIComponent(gameId)}&token=${encodeURIComponent(accessToken)}`;
      return;
    } catch (e) {
      if (e.code === '23505') continue;
      errorElm.textContent = `試合を作成できませんでした: ${e.message || e}`;
      return;
    }
  }
  errorElm.textContent = `この日付(${gameDate})の試合は既に5試合作成されています。`;
});

init();
