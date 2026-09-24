'use strict';
// Test: Admin-Rolle per CLI vergeben/entziehen und vom Server-Modul erkennen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');
const { createAdmins } = require('../admins');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-admins-'));
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ users: [{ id: 1, username: 'Alice' }, { id: 2, username: 'Bob' }] }));
const cli = (...a) => execFileSync(process.execPath, [path.join(__dirname, '..', 'admin-cli.js'), ...a],
  { env: { ...process.env, PORTRIGA_DATA_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bump = () => { const f = path.join(dir, 'admins.json'); const t = new Date(Date.now() + Math.random() * 1e6); fs.utimesSync(f, t, t); };

const admins = createAdmins({ dataDir: dir });
assert.strictEqual(admins.isAdmin(1), false);
cli('add', 'alice'); bump();
assert.strictEqual(admins.isAdmin(1), true);
assert.strictEqual(admins.isAdmin(2), false);
assert.strictEqual(admins.isAdmin(null), false);
assert.match(cli('add', 'Alice'), /bereits Admin/);
assert.match(cli('list'), /Alice\tID 1/);
assert.throws(() => cli('add', 'Mallory'));
cli('remove', 'Alice'); bump();
assert.strictEqual(admins.isAdmin(1), false);
assert.throws(() => cli('remove', 'Alice'));
fs.rmSync(dir, { recursive: true, force: true });
console.log('admins.test.js: OK');
