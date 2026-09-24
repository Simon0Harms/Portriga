#!/usr/bin/env node
'use strict';
/* Admin-Rolle per Terminal verwalten.
 *
 *   node admin-cli.js list
 *   node admin-cli.js add <benutzername>
 *   node admin-cli.js remove <benutzername>
 *
 * Nutzt dasselbe Datenverzeichnis wie der Server (config.json / PORTRIGA_DATA_DIR).
 * Der laufende Server übernimmt Änderungen automatisch.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, dataDirOf } = require('./config');
const { readAdmins, writeAdmins, adminsFile } = require('./admins');

function usage(code) {
  console.log('Verwendung: node admin-cli.js list | add <benutzername> | remove <benutzername>');
  process.exit(code);
}

function loadUsers(dataDir) {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    return Array.isArray(db.users) ? db.users : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error(`accounts.json unlesbar: ${e.message}`);
    process.exit(1);
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const name = rest.join(' ').trim();
  if (!cmd || cmd === '-h' || cmd === '--help') usage(cmd ? 0 : 1);
  const dataDir = dataDirOf(loadConfig({ quiet: true }));
  const users = loadUsers(dataDir);
  const byId = new Map(users.map(u => [String(u.id), u]));
  const admins = readAdmins(dataDir);

  if (cmd === 'list') {
    if (!admins.length) { console.log(`Keine Admins (${adminsFile(dataDir)}).`); return; }
    for (const a of admins) {
      const u = byId.get(String(a.id));
      const since = a.since ? new Date(a.since).toISOString().slice(0, 10) : '?';
      console.log(`${u ? u.username : a.username + ' (Konto existiert nicht mehr)'}\tID ${a.id}\tseit ${since}`);
    }
    return;
  }

  if (cmd !== 'add' && cmd !== 'remove') usage(1);
  if (!name) usage(1);
  const lc = name.toLowerCase();

  if (cmd === 'add') {
    const u = users.find(x => String(x.username || '').toLowerCase() === lc);
    if (!u) { console.error(`Kein Konto „${name}“ gefunden (${path.join(dataDir, 'accounts.json')}).`); process.exit(2); }
    if (admins.some(a => String(a.id) === String(u.id))) { console.log(`${u.username} ist bereits Admin.`); return; }
    admins.push({ id: u.id, username: u.username, since: Date.now() });
    writeAdmins(dataDir, admins);
    console.log(`${u.username} ist jetzt Admin.`);
    return;
  }

  // remove: per aktuellem Kontonamen oder (bei gelöschtem Konto) per gespeichertem Namen
  const u = users.find(x => String(x.username || '').toLowerCase() === lc);
  const keep = admins.filter(a => !((u && String(a.id) === String(u.id)) || String(a.username || '').toLowerCase() === lc));
  if (keep.length === admins.length) { console.error(`„${name}“ ist kein Admin.`); process.exit(2); }
  writeAdmins(dataDir, keep);
  console.log(`${u ? u.username : name} ist kein Admin mehr.`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
