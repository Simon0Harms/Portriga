'use strict';
/* Rangliste für Ranglisten-Räume (Issue #8).
 * Persistiert pro Konto: Wertungspunkte, Spiele, Siege, Punktesumme, Bestwert.
 * Wertung je Spiel: (Punkte - Punkte des Letzten) * Spieleranzahl / 10; der Letzte erhält 0.
 * Datei: <dataDir>/ranking.json (atomar per tmp + rename geschrieben). */
const fs = require('fs');
const path = require('path');

const round1 = x => Math.round(x * 10) / 10;
/** Wertungspunkte eines Spielers für ein Spiel. */
function gameRating(score, lastScore, playerCount) {
  return round1((score - lastScore) * playerCount / 10);
}

function createRanking(opts) {
  const o = { dataDir: path.join(__dirname, 'data'), log: (...a) => console.log('[ranking]', ...a), ...opts };
  try { fs.mkdirSync(o.dataDir, { recursive: true, mode: 0o700 }); } catch (_) {}
  const FILE = path.join(o.dataDir, 'ranking.json');
  let db = { players: {} };
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && typeof d.players === 'object') db = d;
  } catch (e) { if (e.code !== 'ENOENT') o.log(`ranking.json unlesbar (${e.message}) – starte leer.`); }

  function save() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }

  /** results: [{accountId, username, score}] – ein abgeschlossenes Spiel. */
  function recordGame(results) {
    const valid = (results || []).filter(r => r && r.accountId);
    if (valid.length < 2) return false;
    const top = Math.max(...valid.map(r => r.score));
    const last = Math.min(...valid.map(r => r.score));
    const n = valid.length;
    const now = Date.now();
    for (const r of valid) {
      const p = db.players[r.accountId] || (db.players[r.accountId] = { username: r.username, games: 0, wins: 0, points: 0, best: null, rating: 0 });
      p.username = r.username;
      p.games += 1;
      if (r.score === top) p.wins += 1;   // Gleichstand an der Spitze: alle gelten als Sieger
      p.points += r.score;
      p.rating = round1((p.rating || 0) + gameRating(r.score, last, n));
      p.best = p.best === null ? r.score : Math.max(p.best, r.score);
      p.lastPlayed = now;
    }
    save();
    return true;
  }

  /** Sortiert: Wertung, dann Siege, dann Ø-Punkte, dann Spiele. */
  function top(limit = 50) {
    return Object.values(db.players)
      .map(p => ({ username: p.username, rating: p.rating || 0, games: p.games, wins: p.wins, points: p.points, best: p.best,
        avg: p.games ? Math.round((p.points / p.games) * 10) / 10 : 0 }))
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins || b.avg - a.avg || b.games - a.games || a.username.localeCompare(b.username))
      .slice(0, limit);
  }

  function removeUser(id) { if (db.players[id]) { delete db.players[id]; save(); } }

  return { recordGame, top, removeUser, file: FILE };
}

module.exports = { createRanking, gameRating };
