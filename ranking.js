'use strict';
/* Rangliste für Ranglisten-Räume (Issue #8).
 * Persistiert pro Konto: Wertungspunkte, Spiele, Siege, Punktesumme, Bestwert.
 * Wertung je Spiel: (Punkte - Punkte des Letzten) * Spieleranzahl / 10; der Letzte erhält 0.
 * Zeiträume: ewig (all), laufendes Jahr (year), laufender Monat (month) und laufende Woche (week,
 * ISO-8601, Mo–So). Werte liegen je Konto unter p.years['JJJJ'], p.months['JJJJ-MM'] bzw.
 * p.weeks['JJJJ-Www'] (Serverzeit); Spiele vor Einführung
 * der Zeiträume zählen nur in der ewigen Rangliste.
 * Datei: <dataDir>/ranking.json (atomar per tmp + rename geschrieben). */
const fs = require('fs');
const path = require('path');

const round1 = x => Math.round(x * 10) / 10;
/** Wertungspunkte eines Spielers für ein Spiel. */
function gameRating(score, lastScore, playerCount) {
  return round1((score - lastScore) * playerCount / 10);
}

const PERIODS = ['all', 'year', 'month', 'week'];
const pad2 = n => String(n).padStart(2, '0');
/** Schlüssel des Zeitraums, in den der Zeitpunkt ts fällt (all -> null). */
function periodKey(period, ts = Date.now()) {
  const d = new Date(ts);
  if (period === 'year') return String(d.getFullYear());
  if (period === 'month') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  if (period === 'week') {
    // ISO-8601: Woche mit dem Donnerstag bestimmt das Jahr; Woche 1 enthält den 4. Januar
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
    const y = t.getFullYear();
    const w = 1 + Math.round((t - new Date(y, 0, 4)) / 864e5 / 7 - (3 - ((new Date(y, 0, 4).getDay() + 6) % 7)) / 7);
    return `${y}-W${pad2(w)}`;
  }
  return null;
}
const emptyStats = () => ({ games: 0, wins: 0, points: 0, best: null, rating: 0 });
function addResult(st, score, won, rating) {
  st.games += 1;
  if (won) st.wins += 1;
  st.points += score;
  st.rating = round1((st.rating || 0) + rating);
  st.best = st.best === null || st.best === undefined ? score : Math.max(st.best, score);
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
  const view = (id, username, p) => ({ id, username, rating: p.rating || 0, games: p.games, wins: p.wins, points: p.points, best: p.best,
    avg: p.games ? Math.round((p.points / p.games) * 10) / 10 : 0 });
  /** Werte eines Kontos für einen Zeitraum (null, wenn im Zeitraum nicht gespielt). */
  function statsOf(p, period, key) {
    if (period === 'year') return (p.years && p.years[key]) || null;
    if (period === 'month') return (p.months && p.months[key]) || null;
    if (period === 'week') return (p.weeks && p.weeks[key]) || null;
    return p;
  }
  function sorted(period = 'all', key = periodKey(period)) {
    const out = [];
    for (const [id, p] of Object.entries(db.players)) {
      const st = statsOf(p, period, key);
      if (st && st.games) out.push(view(id, p.username, st));
    }
    return out.sort(cmp);
  }
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
      const won = r.score === top;   // Gleichstand an der Spitze: alle gelten als Sieger
      const rating = gameRating(r.score, last, n);
      addResult(p, r.score, won, rating);
      const y = periodKey('year', now), m = periodKey('month', now), w = periodKey('week', now);
      p.years = p.years || {}; p.months = p.months || {}; p.weeks = p.weeks || {};
      addResult(p.years[y] || (p.years[y] = emptyStats()), r.score, won, rating);
      addResult(p.months[m] || (p.months[m] = emptyStats()), r.score, won, rating);
      addResult(p.weeks[w] || (p.weeks[w] = emptyStats()), r.score, won, rating);
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

  /** Sortiert: Wertung, dann Siege, dann Ø-Punkte, dann Spiele.
   * period: 'all' | 'year' | 'month' | 'week'; key optional (z. B. '2026' / '2026-09' / '2026-W39'), Standard = laufender Zeitraum. */
  function top(limit = 50, period = 'all', key) {
    if (!PERIODS.includes(period)) period = 'all';
    const k = period === 'all' ? null : (key || periodKey(period));
    return sorted(period, k).slice(0, limit).map(({ id, ...p }) => p);
  }

  function removeUser(id) { if (db.players[id]) { delete db.players[id]; save(); } }

  return { recordGame, top, ranks, removeUser, file: FILE };
}

module.exports = { createRanking, gameRating, periodKey, PERIODS };
