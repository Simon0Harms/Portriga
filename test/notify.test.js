'use strict';
/* Ranglisten-Benachrichtigung per Matrix-DM: Platzänderungen erkennen und nur an Konten
 * mit aktivierter Option (und bekanntem DM-Raum) senden. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRanking } = require('../ranking');
const { createAccounts } = require('../accounts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-notify-'));
const log = () => {};
const acc = createAccounts({ dataDir: dir, botMxid: '@bot:example.org', publicUrl: 'https://spiel.example.org/', log });
const db = acc._db();
db.users.push(
  { id: 1, username: 'Anna', mxid: '@anna:ex.org', dmRoomId: '!a:ex.org', notifyRank: true },
  { id: 2, username: 'Ben', mxid: '@ben:ex.org', dmRoomId: '!b:ex.org', notifyRank: false },
  { id: 3, username: 'Cleo', mxid: '@cleo:ex.org', dmRoomId: '!c:ex.org', notifyRank: true },
  { id: 4, username: 'Dirk', mxid: '@dirk:ex.org', dmRoomId: null, notifyRank: true },
);
const OUT = acc.paths.OUTBOX;
const drain = () => fs.readdirSync(OUT).filter(n => n.endsWith('.json')).map(n => { const f = path.join(OUT, n); const j = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return j; });

let changes = [];
const rk = createRanking({ dataDir: dir, log, onRankChanges: c => { changes = c; acc.notifyRankChanges(c); } });

// Spiel 1: Anna vor Ben -> beide neu
rk.recordGame([{ accountId: 1, username: 'Anna', score: 50 }, { accountId: 2, username: 'Ben', score: 20 }]);
assert.deepStrictEqual(changes.map(c => [c.accountId, c.oldRank, c.newRank]), [['1', null, 1], ['2', null, 2]]);
let out = drain();
assert.strictEqual(out.length, 1, 'nur Anna (Option an)');
assert.strictEqual(out[0].roomId, '!a:ex.org'); assert.match(out[0].body, /neu in der Rangliste – Platz 1/);
assert.match(out[0].body, /https:\/\/spiel\.example\.org\//);

// Spiel 2: Cleo überholt Anna und Ben (Ben/Anna spielen nicht mit, rutschen trotzdem ab)
rk.recordGame([{ accountId: 3, username: 'Cleo', score: 200 }, { accountId: 4, username: 'Dirk', score: 0 }]);
out = drain();
const byRoom = Object.fromEntries(out.map(m => [m.roomId, m.body]));
assert.match(byRoom['!a:ex.org'], /abgerutscht: Platz 1 → 2/);
assert.match(byRoom['!c:ex.org'], /neu in der Rangliste – Platz 1/);
assert.ok(!byRoom['!b:ex.org'], 'Ben hat die Option aus');
assert.strictEqual(out.length, 2, 'Dirk hat keinen DM-Raum');

// Spiel 3: keine Platzänderung -> keine Nachricht
changes = [];
rk.recordGame([{ accountId: 3, username: 'Cleo', score: 50 }, { accountId: 4, username: 'Dirk', score: 0 }]);
assert.strictEqual(drain().length, 0);

// Aufstieg
db.users[1].notifyRank = true;
rk.recordGame([{ accountId: 2, username: 'Ben', score: 500 }, { accountId: 4, username: 'Dirk', score: 0 }]);
assert.match(drain().find(m => m.roomId === '!b:ex.org').body, /aufgestiegen: Platz 3 → 1/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('notify.test.js: OK');
