'use strict';
/* Admin-Rolle für Benutzerkonten.
 *
 * Gespeichert in <dataDir>/admins.json: { "admins": [{ "id", "username", "since" }] }.
 * Vergeben/entzogen wird die Rolle ausschließlich per Terminal (admin-cli.js).
 * Der Server liest die Datei nur und lädt sie bei Änderung (mtime) automatisch neu –
 * kein Neustart nötig. Maßgeblich ist die Konto-ID (nicht der Name), damit ein
 * gelöschter und neu registrierter Name nicht die Rolle erbt.
 */
const fs = require('fs');
const path = require('path');

function adminsFile(dataDir) { return path.join(dataDir, 'admins.json'); }

function readAdmins(dataDir) {
  try {
    const d = JSON.parse(fs.readFileSync(adminsFile(dataDir), 'utf8'));
    return Array.isArray(d.admins) ? d.admins.filter(a => a && a.id != null) : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[admins] admins.json unlesbar:', e.message);
    return [];
  }
}

function writeAdmins(dataDir, list) {
  const file = adminsFile(dataDir);
  const tmp = file + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify({ admins: list }, null, 1) + '\n', { mode: 0o600 });
  // Als root aufgerufen: Datei dem Eigentümer des Datenverzeichnisses geben, damit der Dienst sie lesen kann.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try { const st = fs.statSync(dataDir); fs.chownSync(tmp, st.uid, st.gid); } catch (_) {}
  }
  fs.renameSync(tmp, file);
}

function createAdmins({ dataDir }) {
  const file = adminsFile(dataDir);
  let ids = new Set(), mtime = -1;
  function refresh() {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch (_) { m = 0; }
    if (m === mtime) return;
    mtime = m;
    ids = new Set(readAdmins(dataDir).map(a => String(a.id)));
  }
  return {
    isAdmin(accountId) {
      if (accountId == null) return false;
      refresh();
      return ids.has(String(accountId));
    },
  };
}

module.exports = { createAdmins, readAdmins, writeAdmins, adminsFile };
