'use strict';
/* Tests für die Rangliste (Issue #8). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRanking, gameRating } = require('../ranking');

// Wertungsformel: (Punkte - Letzter) * Spieler / 10
assert.strictEqual(gameRating(120, 50, 8), 56);
assert.strictEqual(gameRating(50, 50, 8), 0);
assert.strictEqual(gameRating(33, 10, 3), 6.9);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-rank-'));
const log = () => {};
let r = createRanking({ dataDir: dir, log });

assert.strictEqual(r.recordGame([{ accountId: 'a', username: 'Anna', score: 50 }]), false, 'Einzelspieler zählt nicht');
assert.strictEqual(r.recordGame([
  { accountId: 'a', username: 'Anna', score: 50 },
  { accountId: 'b', username: 'Ben', score: 20 },
  { accountId: null, username: 'Gast', score: 99 },
]), true);
r.recordGame([
  { accountId: 'a', username: 'Anna', score: 10 },
  { accountId: 'b', username: 'Ben', score: 10 },
]);
let t = r.top();
assert.deepStrictEqual(t.map(p => [p.username, p.wins, p.games, p.rating]), [['Anna', 2, 2, 6], ['Ben', 1, 2, 0]]);
assert.strictEqual(t[0].avg, 30);
assert.strictEqual(t[0].best, 50);

// Persistenz
r = createRanking({ dataDir: dir, log });
assert.strictEqual(r.top().length, 2);
r.removeUser('b');
assert.deepStrictEqual(r.top().map(p => p.username), ['Anna']);

// Wertung hat Vorrang vor Siegen
r.recordGame([
  { accountId: 'c', username: 'Cleo', score: 120 },
  { accountId: 'd', username: 'Dirk', score: 110 },
  { accountId: 'e', username: 'Emil', score: 50 },
]);
assert.deepStrictEqual(r.top().map(p => [p.username, p.rating]), [['Cleo', 21], ['Dirk', 18], ['Anna', 6], ['Emil', 0]]);

// Zeiträume: ewig / Jahr / Monat / Woche
const { periodKey } = require('../ranking');
assert.match(periodKey('year'), /^\d{4}$/);
assert.match(periodKey('month'), /^\d{4}-\d{2}$/);
assert.strictEqual(periodKey('all'), null);
assert.match(periodKey('week'), /^\d{4}-W\d{2}$/);
// ISO-Wochen an Jahresgrenzen
assert.strictEqual(periodKey('week', new Date(2026, 0, 1).getTime()), '2026-W01');
assert.strictEqual(periodKey('week', new Date(2027, 0, 1).getTime()), '2026-W53');
assert.strictEqual(periodKey('week', new Date(2024, 11, 30).getTime()), '2025-W01');
assert.strictEqual(periodKey('week', new Date(2026, 8, 25).getTime()), '2026-W39');
assert.deepStrictEqual(r.top(50, 'week').map(p => p.username), ['Cleo', 'Dirk', 'Anna', 'Emil']);
assert.strictEqual(r.top(50, 'week', '1999-W01').length, 0);
assert.deepStrictEqual(r.top(50, 'month').map(p => p.username), ['Cleo', 'Dirk', 'Anna', 'Emil']);
assert.deepStrictEqual(r.top(50, 'year').map(p => p.username), ['Cleo', 'Dirk', 'Anna', 'Emil']);
assert.strictEqual(r.top(50, 'year', '1999').length, 0);
// Alt-Einträge ohne Zeitraumdaten (vor Einführung) zählen nur ewig
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-rank-'));
  fs.writeFileSync(path.join(d2, 'ranking.json'), JSON.stringify({ players: { x: { username: 'Alt', games: 3, wins: 1, points: 90, best: 40, rating: 5 } } }));
  const r2 = createRanking({ dataDir: d2, log });
  assert.strictEqual(r2.top(50, 'all').length, 1);
  assert.strictEqual(r2.top(50, 'month').length, 0);
  r2.recordGame([{ accountId: 'x', username: 'Alt', score: 30 }, { accountId: 'y', username: 'Neu', score: 10 }]);
  const m = r2.top(50, 'month');
  assert.deepStrictEqual(m.map(p => [p.username, p.games, p.rating]), [['Alt', 1, 4], ['Neu', 1, 0]]);
  assert.strictEqual(r2.top(50, 'all')[0].games, 4);
  fs.rmSync(d2, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('ranking.test.js: OK');
