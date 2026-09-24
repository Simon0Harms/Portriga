'use strict';
/* Tests für die Rangliste (Issue #8). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRanking } = require('../ranking');

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
assert.deepStrictEqual(t.map(p => [p.username, p.wins, p.games]), [['Anna', 2, 2], ['Ben', 1, 2]]);
assert.strictEqual(t[0].avg, 30);
assert.strictEqual(t[0].best, 50);

// Persistenz
r = createRanking({ dataDir: dir, log });
assert.strictEqual(r.top().length, 2);
r.removeUser('b');
assert.deepStrictEqual(r.top().map(p => p.username), ['Anna']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('ranking.test.js: OK');
