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
  // onRankChanges([{accountId, username, oldRank, newRank, rating}]) – nach jedem gewerteten Spiel,
  // für alle Konten, deren Platz sich geändert hat (auch Nicht-Teilnehmer, die überholt wurden).
  const o = { dataDir: path.join(__dirname, 'data'), log: (...a) => console.log('[ranking]', ...a), onRankChanges: null, ...opts };
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

  const cmp = (a, b) => b.rating - a.rating || b.wins - a.wins || b.avg - a.avg || b.games - a.games || a.username.localeCompare(b.username);
  const view = (id, p) => ({ id, username: p.username, rating: p.rating || 0, games: p.games, wins: p.wins, points: p.points, best: p.best,
    avg: p.games ? Math.round((p.points / p.games) * 10) / 10 : 0 });
  function sorted() { return Object.entries(db.players).map(([id, p]) => view(id, p)).sort(cmp); }
  /** Platz (1-basiert) je Konto-ID. */
  function ranks() { const m = new Map(); sorted().forEach((p, i) => m.set(p.id, i + 1)); return m; }

  /** results: [{accountId, username, score}] – ein abgeschlossenes Spiel. */
  function recordGame(results) {
    const valid = (results || []).filter(r => r && r.accountId);
    if (valid.length < 2) return false;
    const top = Math.max(...valid.map(r => r.score));
    const last = Math.min(...valid.map(r => r.score));
    const n = valid.length;
    const now = Date.now();
    const before = o.onRankChanges ? ranks() : null;
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
    if (before) {
      const changes = [];
      for (const [id, newRank] of ranks()) {
        const oldRank = before.get(id) || null;
        if (oldRank !== newRank) changes.push({ accountId: id, username: db.players[id].username, oldRank, newRank, rating: db.players[id].rating || 0 });
      }
      if (changes.length) { try { o.onRankChanges(changes); } catch (e) { o.log('onRankChanges-Fehler:', e.message); } }
    }
    return true;
  }

  /** Sortiert: Wertung, dann Siege, dann Ø-Punkte, dann Spiele. */
  function top(limit = 50) {
    return sorted().slice(0, limit).map(({ id, ...p }) => p);
  }

  function removeUser(id) { if (db.players[id]) { delete db.players[id]; save(); } }

  return { recordGame, top, ranks, removeUser, file: FILE };
}

module.exports = { createRanking, gameRating };
