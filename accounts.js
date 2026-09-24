'use strict';
/* ---------------------------------------------------------------------------
 * Portriga – Benutzerkonten mit Matrix-Verifikation
 *
 * Registrierung:
 *   1) Benutzername wählen -> Verfügbarkeit wird geprüft
 *   2) optional Passwort setzen
 *   3) App zeigt einen Code; der User schreibt ihn per Direktnachricht an den
 *      konfigurierten Matrix-Bot. Der Sidecar (deploy/matrix/portriga_matrix_bot.py)
 *      legt jede eingehende Nachricht als JSON-Datei in die Inbox; diese App
 *      liest sie, ordnet den Code zu und legt das Konto mit der ABSENDER-MXID an.
 *      Der Absender ist vom Homeserver authentifiziert -> Nachweis, dass die MXID
 *      dem User gehört.
 *
 * Anmeldung: Benutzername/MXID + Passwort ODER Login-Link per Matrix-DM.
 *
 * Konto löschen: bei mit Matrix verknüpften Konten muss die Löschung per
 *   Matrix-DM bestätigt werden („löschen XXXX-XXXX“, Absender = verknüpfte MXID).
 *   Danach verabschiedet sich der Bot und verlässt den DM-Raum (Outbox-Flag
 *   ``leave``). Konten ohne Matrix-Verknüpfung werden nach Passwortprüfung
 *   sofort gelöscht.
 *
 * Matrix-Konto/-Raum ändern: angemeldet in der App einen Code „MX-XXXX-XXXX“
 *   anfordern und ihn per DM an den Bot schicken. Absender-MXID und Raum werden
 *   neu verknüpft (gleiche MXID aus neuem Raum = nur Raumwechsel). Der alte Raum
 *   wird benachrichtigt; der Bot verlässt ihn, wenn kein Konto ihn mehr nutzt.
 *
 * User verlässt den DM-Raum (Sidecar meldet {type:"leave"}):
 *   - Konto MIT Passwort: nur die Raum-Verknüpfung wird entfernt.
 *   - Konto OHNE Passwort und noch gültiges Session-Cookie: Konto wird als
 *     ``needsRelink`` markiert; beim nächsten Aufruf erzwingt die App das
 *     Verknüpfen eines neuen Raums (Code „MX-…“ oder „login“ aus neuem Chat).
 *     Läuft das letzte Cookie ab oder meldet sich der User ab, ohne neu zu
 *     verknüpfen, wird das Konto gelöscht.
 *   - Konto OHNE Passwort und kein gültiges Cookie mehr: sofort gelöscht.
 *   Da Sessions zustandslos (HMAC) sind, merkt sich das Konto das späteste
 *   Ablaufdatum ausgestellter Cookies (``sessUntil``).
 *
 * Kommunikation mit dem Sidecar ausschließlich über zwei Spool-Verzeichnisse
 * (je Auftrag eine Datei, atomar via tmp+rename) – wie in KKk58:
 *   outbox/  App -> Sidecar  {id, roomId, body, createdAt, leave?}
 *   inbox/   Sidecar -> App  {id, eventId, roomId, sender, body, ts}
 *            bzw. {type:"leave", eventId, roomId, sender, ts} (User hat Raum verlassen)
 * ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERNAME_RE = /^[A-Za-z0-9ÄÖÜäöüß_.-]{3,20}$/;
const RESERVED_RE = /^(bot(\s*\d+)?|spieler|admin|system|portriga)$/i;
const MXID_RE = /^@[^\s:]+:[^\s:]+$/;
// Code-Alphabet ohne verwechselbare Zeichen (0/O, 1/I/L)
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /PR-?([A-Z2-9]{4})-?([A-Z2-9]{4})/i;
// Bestätigung der Kontolöschung per DM: „löschen ABCD-EFGH“ (auch „loeschen“, „!löschen“, „delete“)
// Code zum Ändern der Matrix-Verknüpfung (eigenes Präfix, damit er nie als Registrierungscode gilt)
const RELINK_RE = /MX-?([A-Z2-9]{4})-?([A-Z2-9]{4})/i;
const DELETE_RE = /^\s*!?(?:l(?:ö|oe)schen|delete)(?:\s+(?:DEL-?)?([A-Z2-9]{4})-?([A-Z2-9]{4}))?\s*$/i;

function createAccounts(opts) {
  const o = Object.assign({
    dataDir: path.join(__dirname, 'data'),
    botMxid: '',
    publicUrl: '',
    codeTtlMs: 15 * 60 * 1000,
    magicTtlMs: 5 * 60 * 1000,
    sessionTtlMs: 30 * 24 * 3600 * 1000,
    cookieSecure: true,
    cookieName: 'portriga_sess',
    basePath: '',
    inboxPollMs: 2000,
    deleteTtlMs: 10 * 60 * 1000,
    relinkTtlMs: 15 * 60 * 1000,
    onUserDeleted: null, // (userId) => void – z. B. offene WebSockets abmelden
    log: (...a) => console.log('[accounts]', ...a),
  }, opts || {});

  const enabled = !!(o.botMxid && MXID_RE.test(o.botMxid));
  const DB_FILE = path.join(o.dataDir, 'accounts.json');
  const SECRET_FILE = path.join(o.dataDir, 'secret.key');
  const OUTBOX = path.join(o.dataDir, 'matrix-outbox');
  const INBOX = path.join(o.dataDir, 'matrix-inbox');
  for (const d of [o.dataDir, OUTBOX, INBOX]) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (_) {} }

  // ---- Secret (HMAC für Sessions und Codes) ----
  let SECRET;
  try { SECRET = fs.readFileSync(SECRET_FILE); if (SECRET.length < 32) throw new Error('kurz'); }
  catch (_) { SECRET = crypto.randomBytes(48); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
  const hmac = v => crypto.createHmac('sha256', SECRET).update(String(v)).digest('hex');
  const eqHex = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

  // ---- Persistenz ----
  let db = { users: [], pending: [], magic: [], deletions: [], relinks: [], nextId: 1 };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') o.log('accounts.json unlesbar:', e.message); }
  function save() {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  }
  function prune() {
    const now = Date.now();
    if (!Array.isArray(db.relinks)) db.relinks = [];
    const n1 = db.pending.length, n2 = db.magic.length, n3 = db.deletions.length, n4 = db.relinks.length;
    db.pending = db.pending.filter(p => p.expires > now || (p.doneUserId && p.expires + 3600e3 > now));
    db.magic = db.magic.filter(m => !m.used && m.expires > now);
    // erledigte Löschungen noch 1 h behalten, damit der Browser den Status abholen kann
    db.deletions = db.deletions.filter(d => d.expires > now || (d.done && d.expires + 3600e3 > now));
    db.relinks = db.relinks.filter(x => x.expires > now || ((x.done || x.error) && x.expires + 3600e3 > now));
    return n1 !== db.pending.length || n2 !== db.magic.length || n3 !== db.deletions.length || n4 !== db.relinks.length;
  }

  // ---- Passwörter (scrypt) ----
  function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') }; }
  function verifyPw(u, pw) {
    if (!u || !u.hash) return false;
    const h = crypto.scryptSync(String(pw), u.salt, 64), k = Buffer.from(u.hash, 'hex');
    return h.length === k.length && crypto.timingSafeEqual(h, k);
  }

  // ---- Lookups ----
  const lc = s => String(s || '').trim().toLowerCase();
  const userById = id => db.users.find(u => u.id === id) || null;
  const userByName = n => db.users.find(u => lc(u.username) === lc(n)) || null;
  const userByMxid = m => db.users.find(u => lc(u.mxid) === lc(m)) || null;
  function findLogin(login) { const s = String(login || '').trim(); return s[0] === '@' ? userByMxid(s) : userByName(s); }
  function activePendingByName(n, exceptToken) {
    const now = Date.now();
    return db.pending.find(p => !p.doneUserId && !p.error && p.expires > now && p.token !== exceptToken && lc(p.username) === lc(n)) || null;
  }
  function usernameProblem(n) {
    n = String(n || '').trim();
    if (!USERNAME_RE.test(n)) return 'Benutzername: 3–20 Zeichen, erlaubt sind Buchstaben, Ziffern, _ . -';
    if (RESERVED_RE.test(n)) return 'Dieser Name ist reserviert.';
    return null;
  }
  function usernameAvailable(n) {
    const prob = usernameProblem(n);
    if (prob) return { available: false, reason: prob };
    if (userByName(n) || activePendingByName(n)) return { available: false, reason: 'Benutzername ist bereits vergeben.' };
    return { available: true };
  }
  /** Für Gäste: ist dieser Anzeigename einem Konto vorbehalten? */
  function isRegisteredName(n) { return !!userByName(n); }

  // ---- Codes, Sessions, Login-Links ----
  function newCode() {
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHA[crypto.randomInt(0, CODE_ALPHA.length)];
    return 'PR-' + s.slice(0, 4) + '-' + s.slice(4);
  }
  const normCode = (a, b) => (a + b).toUpperCase();

  function makeSession(u, exp) {
    exp = exp || Date.now() + o.sessionTtlMs;
    const payload = `${u.id}.${u.sessVer || 0}.${exp}`;
    return payload + '.' + hmac('sess:' + payload);
  }
  function readSession(tok) {
    const p = String(tok || '').split('.');
    if (p.length !== 4) return null;
    const [id, ver, exp, sig] = p;
    if (!eqHex(sig, hmac('sess:' + `${id}.${ver}.${exp}`))) return null;
    if (!(Number(exp) > Date.now())) return null;
    const u = userById(Number(id));
    if (!u || String(u.sessVer || 0) !== ver) return null;
    return u;
  }
  function parseCookies(h) {
    const out = {};
    String(h || '').split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) { try { out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); } catch (_) {} } });
    return out;
  }
  function userFromReq(req) { return readSession(parseCookies(req.headers.cookie)[o.cookieName]); }
  function cookiePath() { return (o.basePath || '') + '/'; }
  function setSession(res, u) {
    const exp = Date.now() + o.sessionTtlMs;
    // spätestes Cookie-Ablaufdatum merken (für „User hat Raum verlassen“)
    if (!(u.sessUntil >= exp)) { u.sessUntil = exp; save(); }
    res.append('Set-Cookie', `${o.cookieName}=${encodeURIComponent(makeSession(u, exp))}; Path=${cookiePath()}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(o.sessionTtlMs / 1000)}${o.cookieSecure ? '; Secure' : ''}`);
  }
  function clearSession(res) {
    res.append('Set-Cookie', `${o.cookieName}=; Path=${cookiePath()}; HttpOnly; SameSite=Lax; Max-Age=0${o.cookieSecure ? '; Secure' : ''}`);
  }
  function publicUser(u) { return u ? { id: u.id, username: u.username, mxid: u.mxid, hasPassword: !!u.hash, needsRelink: !!u.needsRelink, createdAt: u.createdAt } : null; }

  // ---- Outbox (App -> Sidecar) ----
  function enqueue(roomId, body, extra) {
    try {
      const id = Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex');
      const tmp = path.join(OUTBOX, '.' + id + '.tmp');
      const job = Object.assign({ id, roomId: String(roomId), body: String(body), createdAt: Date.now() }, extra || {});
      fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
      fs.renameSync(tmp, path.join(OUTBOX, id + '.json'));
      return true;
    } catch (e) { o.log('Outbox-Fehler:', e.message); return false; }
  }
  // Login-Links NUR mit fest konfigurierter öffentlicher URL: aus Host-/X-Forwarded-Headern
  // abgeleitete Links wären per Header-Spoofing auf fremde Domains umlenkbar (Token-Diebstahl).
  const PUBLIC_BASE = String(o.publicUrl || '').replace(/\/+$/, '');
  function createMagic(u) {
    db.magic = db.magic.filter(m => m.userId !== u.id && !m.used && m.expires > Date.now());
    const m = { token: crypto.randomBytes(24).toString('base64url'), userId: u.id, expires: Date.now() + o.magicTtlMs, used: false };
    db.magic.push(m); save(); return m;
  }
  function sendLoginLink(u, base) {
    if (!u.dmRoomId) return false;
    const m = createMagic(u);
    return enqueue(u.dmRoomId, `🃏 Portriga – Anmeldung\nDein Login-Link (${Math.round(o.magicTtlMs / 60000)} Minuten gültig, einmal verwendbar):\n${base}/?mlogin=${m.token}\nWenn du das nicht angefordert hast, ignoriere diese Nachricht.`);
  }

  // ---- Konto löschen ----
  function deleteUser(u) {
    db.users = db.users.filter(x => x.id !== u.id);
    db.magic = db.magic.filter(m => m.userId !== u.id);
    db.pending = db.pending.filter(p => p.doneUserId !== u.id);
    for (const d of db.deletions) if (d.userId === u.id && !d.done) { d.done = true; d.codeHash = null; }
    db.relinks = (db.relinks || []).filter(x => x.userId !== u.id);
    save();
    o.log('Konto gelöscht:', u.username, u.mxid || '(ohne Matrix)');
    if (typeof o.onUserDeleted === 'function') { try { o.onUserDeleted(u.id); } catch (e) { o.log('onUserDeleted:', e.message); } }
  }
  function startDeletion(u) {
    db.deletions = db.deletions.filter(d => d.userId !== u.id || d.done);
    const code = newCode().slice(3); // XXXX-XXXX
    const d = { token: crypto.randomBytes(24).toString('base64url'), userId: u.id, codeHash: hmac('del:' + u.id + ':' + code.replace('-', '')), expires: Date.now() + o.deleteTtlMs, done: false, createdAt: Date.now() };
    db.deletions.push(d); save();
    enqueue(u.dmRoomId, `🃏 Portriga – Konto löschen\nFür dein Konto „${u.username}“ wurde die Löschung angefordert.\nZum Bestätigen antworte hier mit:\n\nlöschen ${code}\n\n(${Math.round(o.deleteTtlMs / 60000)} Minuten gültig.) Das Konto wird endgültig gelöscht und ich verlasse danach diesen Chat.\nWenn du das nicht angefordert hast, ignoriere diese Nachricht und ändere ggf. dein Passwort.`);
    return { d, code };
  }

  // ---- Matrix-Konto/-Raum ändern ----
  function startRelink(u) {
    db.relinks = (db.relinks || []).filter(x => x.userId !== u.id);
    const code = 'MX-' + newCode().slice(3);
    const x = { token: crypto.randomBytes(24).toString('base64url'), userId: u.id, codeHash: hmac('relink:' + u.id + ':' + code.replace(/^MX-|-/g, '')), expires: Date.now() + o.relinkTtlMs, done: false, error: null, createdAt: Date.now() };
    db.relinks.push(x); save();
    return { x, code };
  }
  function handleRelink(sender, roomId, a, b) {
    const now = Date.now();
    const raw = (a + b).toUpperCase();
    const x = (db.relinks || []).find(r => !r.done && !r.error && r.expires > now && eqHex(r.codeHash, hmac('relink:' + r.userId + ':' + raw)));
    if (!x) { enqueue(roomId, '🃏 Portriga\nDieser Code ist unbekannt oder abgelaufen. Bitte fordere in der App unter „Konto“ einen neuen an.'); return 'badrelink'; }
    const u = userById(x.userId);
    if (!u) { x.error = 'Konto nicht gefunden.'; save(); return 'nouser'; }
    const other = userByMxid(sender);
    if (other && other.id !== u.id) {
      x.error = 'Diese Matrix-ID ist bereits mit dem Konto „' + other.username + '“ verknüpft.'; x.expires = now + 10 * 60 * 1000; save();
      enqueue(roomId, `🃏 Portriga\nDeine Matrix-ID ist bereits mit dem Konto „${other.username}“ verknüpft. Die Verknüpfung wurde nicht geändert.`);
      return 'mxidtaken';
    }
    const oldMxid = u.mxid || null, oldRoom = u.dmRoomId || null;
    const mxidChanged = lc(oldMxid) !== lc(sender);
    u.mxid = sender; u.dmRoomId = roomId; delete u.needsRelink;
    // Neue Identität -> offene Login-Links/Löschanfragen der alten MXID verwerfen
    if (mxidChanged) {
      db.magic = db.magic.filter(m => m.userId !== u.id);
      db.deletions = db.deletions.filter(d => d.userId !== u.id || d.done);
    }
    x.done = true; x.codeHash = null; x.newMxid = sender;
    save();
    o.log('Matrix-Verknüpfung geändert:', u.username, (oldMxid || '-') + ' -> ' + sender, oldRoom === roomId ? '' : '(neuer Raum)');
    enqueue(roomId, `🃏 Portriga\n${mxidChanged ? `Dein Konto „${u.username}“ ist jetzt mit ${sender} verknüpft.` : `Für dein Konto „${u.username}“ nutze ich ab jetzt diesen Chat.`}\nLogin-Links und Bestätigungen kommen künftig hierher.`);
    if (oldRoom && oldRoom !== roomId) {
      const shared = db.users.some(v => v.dmRoomId === oldRoom);
      enqueue(oldRoom, `🃏 Portriga\nDie Matrix-Verknüpfung des Kontos „${u.username}“ wurde ${mxidChanged ? 'auf ' + sender : 'auf einen anderen Chat'} umgestellt.${shared ? '' : ' Ich verlasse diesen Chat.'}\nWenn du das nicht warst, melde dich in der App an und ändere dein Passwort.`, shared ? null : { leave: true });
    }
    return 'relinked';
  }

  // ---- User hat den DM-Raum verlassen ----
  function hasLiveSession(u) {
    // Konten von vor dieser Änderung kennen sessUntil nicht -> konservativ annehmen,
    // dass noch ein Cookie bis max. sessionTtlMs existieren kann.
    if (u.sessUntil === undefined) u.sessUntil = Date.now() + o.sessionTtlMs;
    return u.sessUntil > Date.now();
  }
  function handleMemberLeave(sender, roomId) {
    const u = userByMxid(sender);
    if (!u || u.dmRoomId !== roomId) return 'ignored';
    u.dmRoomId = null;
    db.magic = db.magic.filter(m => m.userId !== u.id);
    db.deletions = db.deletions.filter(d => d.userId !== u.id || d.done);
    if (u.hash) { save(); o.log('Raum verlassen, Konto behält Passwort:', u.username); return 'unlinked'; }
    if (hasLiveSession(u)) {
      u.needsRelink = true; save();
      o.log('Raum verlassen, Konto ohne Passwort wartet auf neue Verknüpfung:', u.username);
      return 'needsrelink';
    }
    o.log('Raum verlassen, Konto ohne Passwort und ohne Sitzung:', u.username);
    deleteUser(u);
    return 'deleted';
  }
  // Konten, die neu verknüpft werden müssten, aber keine gültige Sitzung mehr haben
  function purgeOrphans() {
    for (const u of db.users.slice()) if (u.needsRelink && !u.hash && !hasLiveSession(u)) deleteUser(u);
  }

  // ---- Inbox (Sidecar -> App) ----
  function handleInbound(msg) {
    const sender = String(msg.sender || '').trim();
    const roomId = String(msg.roomId || '').trim();
    const body = String(msg.body || '');
    if (!MXID_RE.test(sender) || !roomId || lc(sender) === lc(o.botMxid)) return 'ignored';
    if (msg.type === 'leave') return handleMemberLeave(sender, roomId);
    const rl = body.match(RELINK_RE);
    if (rl) {
      if (rateHit('relink:' + lc(sender), 3000)) return 'rate';
      return handleRelink(sender, roomId, rl[1], rl[2]);
    }
    const m = body.match(CODE_RE);
    if (m) {
      const code = normCode(m[1], m[2]);
      const now = Date.now();
      const p = db.pending.find(x => !x.doneUserId && !x.error && x.expires > now && eqHex(x.codeHash, hmac('code:' + code)));
      if (!p) { enqueue(roomId, '🃏 Portriga\nDieser Code ist unbekannt oder abgelaufen. Bitte starte die Registrierung in der App neu.'); return 'badcode'; }
      const existing = userByMxid(sender);
      if (existing) {
        p.expires = Date.now() + 10 * 60 * 1000; p.error = 'Diese Matrix-ID ist bereits mit dem Konto „' + existing.username + '“ verknüpft.'; save();
        enqueue(roomId, `🃏 Portriga\nDeine Matrix-ID ist bereits mit dem Konto „${existing.username}“ verknüpft. Es wurde kein neues Konto angelegt.`);
        return 'mxidtaken';
      }
      if (userByName(p.username)) {
        p.expires = Date.now() + 10 * 60 * 1000; p.error = 'Benutzername wurde inzwischen vergeben.'; save();
        enqueue(roomId, '🃏 Portriga\nDer Benutzername wurde inzwischen vergeben. Bitte registriere dich mit einem anderen Namen.');
        return 'nametaken';
      }
      const u = { id: db.nextId++, username: p.username, mxid: sender, dmRoomId: roomId, salt: p.salt || null, hash: p.hash || null, sessVer: 0, createdAt: now };
      db.users.push(u);
      p.doneUserId = u.id; delete p.salt; delete p.hash;
      save();
      o.log('Konto angelegt:', u.username, u.mxid);
      enqueue(roomId, `🃏 Portriga\nWillkommen, ${u.username}! Dein Konto ist aktiv und mit ${sender} verknüpft.\nDu kannst dich künftig per Login-Link über diesen Chat anmelden${u.hash ? ' oder mit deinem Passwort' : ''}.\nTipp: Schreib mir „login“, um jederzeit einen Login-Link zu bekommen.${o.announceRoom ? `\n📢 Neue öffentliche und Ranglisten-Spiele findest du im Raum ${o.announceRoom}${o.announceLink ? ' (' + o.announceLink + ')' : ''}.` : ''}`);
      return 'registered';
    }
    const dm = body.match(DELETE_RE);
    if (dm) {
      const u = userByMxid(sender);
      if (!u) { enqueue(roomId, '🃏 Portriga\nZu deiner Matrix-ID gibt es kein Konto.'); return 'nouser'; }
      const now = Date.now();
      const d = db.deletions.find(x => x.userId === u.id && !x.done && x.expires > now);
      if (!d) { enqueue(roomId, '🃏 Portriga\nEs liegt keine offene Löschanfrage vor. Starte sie in der App unter „Konto“ → „Konto löschen“.'); return 'nodelete'; }
      if (!dm[1]) { enqueue(roomId, '🃏 Portriga\nBitte den Bestätigungscode mitschicken, z. B.: löschen ABCD-EFGH'); return 'delnocode'; }
      if (rateHit('delcode:' + u.id, 3000)) return 'rate';
      if (!eqHex(d.codeHash, hmac('del:' + u.id + ':' + (dm[1] + dm[2]).toUpperCase()))) { enqueue(roomId, '🃏 Portriga\nDer Bestätigungscode stimmt nicht. Das Konto wurde nicht gelöscht.'); return 'delbadcode'; }
      const leaveRoom = u.dmRoomId || roomId;
      deleteUser(u);
      // Raum nur verlassen, wenn ihn kein anderes Konto als DM nutzt
      const shared = db.users.some(x => x.dmRoomId === leaveRoom || x.dmRoomId === roomId);
      enqueue(roomId, `🃏 Portriga\nDein Konto „${u.username}“ wurde gelöscht. Tschüss und danke fürs Spielen!${shared ? '' : '\nIch verlasse jetzt diesen Chat.'}`, shared ? null : { leave: true });
      if (!shared && leaveRoom !== roomId) enqueue(leaveRoom, '🃏 Portriga\nKonto gelöscht – ich verlasse diesen Chat.', { leave: true });
      return 'deleted';
    }
    if (/^\s*!?(login|anmelden)\s*$/i.test(body)) {
      const u = userByMxid(sender);
      if (!u) { enqueue(roomId, '🃏 Portriga\nZu deiner Matrix-ID gibt es noch kein Konto. Registriere dich in der App.'); return 'nouser'; }
      if (u.dmRoomId !== roomId || u.needsRelink) { u.dmRoomId = roomId; delete u.needsRelink; save(); }
      if (!PUBLIC_BASE) { enqueue(roomId, '🃏 Portriga\nLogin-Link derzeit nicht möglich (öffentliche URL unbekannt). Bitte melde dich mit Passwort an.'); return 'nobase'; }
      if (rateHit('mlogin:' + u.id, 30000)) return 'rate';
      sendLoginLink(u, PUBLIC_BASE);
      return 'loginlink';
    }
    return 'ignored';
  }
  function processInbox() {
    let names;
    try { names = fs.readdirSync(INBOX).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch (_) { return; }
    for (const n of names) {
      const f = path.join(INBOX, n);
      let msg = null;
      try { msg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
      try { if (msg) handleInbound(msg); } catch (e) { o.log('Inbox-Fehler:', e.message); }
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }

  // ---- Ratenbegrenzung ----
  const rate = new Map();
  function rateHit(key, minMs) { const now = Date.now(); const t = rate.get(key) || 0; if (now - t < minMs) return true; rate.set(key, now); return false; }
  const fails = new Map(); // ip -> {n, until}
  function throttled(ip) { const f = fails.get(ip); return !!(f && f.n >= 8 && f.until > Date.now()); }
  function badTry(ip) { const f = fails.get(ip) || { n: 0, until: 0 }; f.n++; f.until = Date.now() + 10 * 60 * 1000; fails.set(ip, f); }
  const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

  // ---- HTTP-Routen ----
  function mount(app, express, BASE) {
    const r = express.Router();
    r.use(express.json({ limit: '8kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    // CSRF-Schutz für schreibende Requests: Origin muss zum Host passen (falls gesetzt).
    r.use((req, res, next) => {
      if (req.method === 'GET') return next();
      const origin = req.headers.origin;
      if (origin) {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        try { if (new URL(origin).host !== host) return res.status(403).json({ error: 'bad origin' }); } catch (_) { return res.status(403).json({ error: 'bad origin' }); }
      }
      next();
    });
    const off = (res) => res.status(503).json({ error: 'Konten sind auf diesem Server nicht aktiviert.' });

    r.get('/config', (req, res) => res.json({ enabled, botMxid: enabled ? o.botMxid : null, codeTtlMs: o.codeTtlMs, matrixLogin: enabled && !!PUBLIC_BASE }));
    r.get('/me', (req, res) => res.json({ user: publicUser(userFromReq(req)) }));

    r.get('/register/check', (req, res) => {
      if (!enabled) return off(res);
      res.json(usernameAvailable(req.query.u));
    });

    r.post('/register/start', (req, res) => {
      if (!enabled) return off(res);
      const ip = ipOf(req);
      const username = String((req.body && req.body.username) || '').trim();
      const password = String((req.body && req.body.password) || '');
      const av = usernameAvailable(username);
      if (!av.available) return res.status(409).json({ error: av.reason });
      if (password && password.length < 8) return res.status(422).json({ error: 'Passwort: mindestens 8 Zeichen (oder leer lassen).' });
      if (rateHit('reg:' + ip, 5000)) return res.status(429).json({ error: 'Bitte kurz warten.' });
      if (db.pending.filter(p => p.ip === ip && !p.doneUserId && p.expires > Date.now()).length >= 3) return res.status(429).json({ error: 'Zu viele offene Registrierungen – bitte später erneut.' });
      prune();
      const code = newCode();
      const token = crypto.randomBytes(24).toString('base64url');
      const p = { token, username, codeHash: hmac('code:' + code.replace(/^PR-|-/g, '')), expires: Date.now() + o.codeTtlMs, ip, createdAt: Date.now() };
      if (password) Object.assign(p, hashPw(password));
      db.pending.push(p); save();
      res.json({ ok: true, token, code, botMxid: o.botMxid, matrixTo: 'https://matrix.to/#/' + o.botMxid, expires: p.expires });
    });

    // Browser pollt, bis der Sidecar den Code zugestellt hat -> dann direkt angemeldet.
    r.get('/register/status', (req, res) => {
      if (!enabled) return off(res);
      const p = db.pending.find(x => x.token === String(req.query.token || ''));
      if (!p) return res.json({ status: 'expired' });
      if (p.doneUserId) {
        const u = userById(p.doneUserId);
        db.pending = db.pending.filter(x => x !== p); save();
        if (!u) return res.json({ status: 'expired' });
        setSession(res, u);
        return res.json({ status: 'done', user: publicUser(u) });
      }
      if (p.error) return res.json({ status: 'failed', error: p.error });
      if (!(p.expires > Date.now())) return res.json({ status: 'expired' });
      res.json({ status: 'pending', expires: p.expires });
    });

    r.post('/register/cancel', (req, res) => {
      const t = String((req.body && req.body.token) || '');
      const n = db.pending.length; db.pending = db.pending.filter(x => x.token !== t || x.doneUserId);
      if (n !== db.pending.length) save();
      res.json({ ok: true });
    });

    r.post('/login', (req, res) => {
      if (!enabled) return off(res);
      const ip = ipOf(req);
      if (throttled(ip)) return res.status(429).json({ error: 'Zu viele Versuche, bitte später erneut.' });
      const u = findLogin(req.body && req.body.login);
      if (!u || !verifyPw(u, (req.body && req.body.password) || '')) { badTry(ip); return res.status(401).json({ error: 'Anmeldung fehlgeschlagen.' }); }
      fails.delete(ip); setSession(res, u);
      res.json({ ok: true, user: publicUser(u) });
    });

    // Login-Link per Matrix-DM anfordern. Antwort immer generisch (keine Konten-Aufzählung).
    r.post('/login/matrix', (req, res) => {
      if (!enabled) return off(res);
      const ip = ipOf(req);
      if (throttled(ip) || rateHit('mreq:' + ip, 3000)) return res.status(429).json({ error: 'Bitte kurz warten.' });
      const u = findLogin(req.body && req.body.login);
      if (PUBLIC_BASE && u && u.dmRoomId && !rateHit('mlogin:' + u.id, 30000)) sendLoginLink(u, PUBLIC_BASE);
      res.json({ ok: true, sent: true });
    });

    r.post('/login/matrix/redeem', (req, res) => {
      if (!enabled) return off(res);
      const ip = ipOf(req);
      if (throttled(ip)) return res.status(429).json({ error: 'Zu viele Versuche, bitte später erneut.' });
      const t = String((req.body && req.body.token) || '');
      const m = db.magic.find(x => x.token === t && !x.used && x.expires > Date.now());
      if (!m) { badTry(ip); return res.status(404).json({ error: 'Login-Link ungültig oder abgelaufen.' }); }
      const u = userById(m.userId);
      m.used = true; prune(); save();
      if (!u) return res.status(404).json({ error: 'Konto nicht gefunden.' });
      setSession(res, u);
      res.json({ ok: true, user: publicUser(u) });
    });

    r.post('/logout', (req, res) => {
      const u = userFromReq(req);
      clearSession(res);
      // Konto ohne Passwort und ohne Matrix-Raum: ohne Cookie nicht mehr erreichbar -> löschen
      if (u && u.needsRelink && !u.hash) { u.sessUntil = 0; deleteUser(u); return res.json({ ok: true, deleted: true }); }
      res.json({ ok: true });
    });

    // Status einer Löschanfrage – ohne Login-Pflicht, da die Session nach der Löschung ungültig ist.
    r.get('/me/delete/status', (req, res) => {
      const d = db.deletions.find(x => x.token === String(req.query.token || ''));
      if (!d) return res.json({ status: 'expired' });
      if (d.done) { clearSession(res); return res.json({ status: 'deleted' }); }
      if (!(d.expires > Date.now())) return res.json({ status: 'expired' });
      res.json({ status: 'pending', expires: d.expires });
    });

    // Ab hier: angemeldet
    r.use((req, res, next) => { const u = userFromReq(req); if (!u) return res.status(401).json({ error: 'Nicht angemeldet.' }); req.user = u; next(); });

    r.post('/me/password', (req, res) => {
      const u = req.user;
      const np = String((req.body && req.body.newPassword) || '');
      if (np && np.length < 8) return res.status(422).json({ error: 'Passwort: mindestens 8 Zeichen.' });
      if (u.hash && !verifyPw(u, (req.body && req.body.currentPassword) || '')) return res.status(401).json({ error: 'Aktuelles Passwort falsch.' });
      if (!np && u.needsRelink) return res.status(409).json({ error: 'Bitte zuerst einen neuen Matrix-Chat verknüpfen.' });
    if (np) Object.assign(u, hashPw(np)); else { u.hash = null; u.salt = null; }
      save();
      res.json({ ok: true, user: publicUser(u) });
    });

    // Konto löschen. Mit Matrix-Verknüpfung: Bestätigung per DM nötig; sonst sofort.
    r.post('/me/delete', (req, res) => {
      const u = req.user;
      const ip = ipOf(req);
      if (throttled(ip)) return res.status(429).json({ error: 'Zu viele Versuche, bitte später erneut.' });
      if (u.hash && !verifyPw(u, (req.body && req.body.password) || '')) { badTry(ip); return res.status(401).json({ error: 'Passwort falsch.' }); }
      if (u.mxid) {
        if (!u.dmRoomId) return res.status(409).json({ error: 'Kein Matrix-Chat mit dem Bot bekannt. Schreib dem Bot zuerst „login“ und versuche es dann erneut.' });
        if (rateHit('del:' + u.id, 10000)) return res.status(429).json({ error: 'Bitte kurz warten.' });
        const { d, code } = startDeletion(u);
        return res.json({ ok: true, confirm: 'matrix', token: d.token, code, botMxid: o.botMxid, matrixTo: 'https://matrix.to/#/' + o.botMxid, expires: d.expires });
      }
      deleteUser(u); clearSession(res);
      res.json({ ok: true, deleted: true });
    });
    r.post('/me/delete/cancel', (req, res) => {
      const n = db.deletions.length;
      db.deletions = db.deletions.filter(d => d.userId !== req.user.id || d.done);
      if (n !== db.deletions.length) save();
      res.json({ ok: true });
    });

    // Matrix-Konto/-Raum ändern: Code anfordern, per DM von der (neuen) MXID an den Bot schicken.
    r.post('/me/matrix', (req, res) => {
      if (!enabled) return off(res);
      const u = req.user;
      const ip = ipOf(req);
      if (throttled(ip)) return res.status(429).json({ error: 'Zu viele Versuche, bitte später erneut.' });
      if (u.hash && !verifyPw(u, (req.body && req.body.password) || '')) { badTry(ip); return res.status(401).json({ error: 'Passwort falsch.' }); }
      if (rateHit('relinkreq:' + u.id, 5000)) return res.status(429).json({ error: 'Bitte kurz warten.' });
      const { x, code } = startRelink(u);
      res.json({ ok: true, token: x.token, code, botMxid: o.botMxid, matrixTo: 'https://matrix.to/#/' + o.botMxid, expires: x.expires });
    });
    r.get('/me/matrix/status', (req, res) => {
      const x = (db.relinks || []).find(v => v.userId === req.user.id && v.token === String(req.query.token || ''));
      if (!x) return res.json({ status: 'expired' });
      if (x.done) return res.json({ status: 'done', user: publicUser(req.user) });
      if (x.error) return res.json({ status: 'failed', error: x.error });
      if (!(x.expires > Date.now())) return res.json({ status: 'expired' });
      res.json({ status: 'pending', expires: x.expires });
    });
    r.post('/me/matrix/cancel', (req, res) => {
      const n = (db.relinks || []).length;
      db.relinks = (db.relinks || []).filter(v => v.userId !== req.user.id || v.done);
      if (n !== db.relinks.length) save();
      res.json({ ok: true });
    });

    // Alle Sitzungen beenden (inkl. dieser)
    r.post('/me/logout-all', (req, res) => {
      const u = req.user;
      u.sessVer = (u.sessVer || 0) + 1; u.sessUntil = 0; save(); clearSession(res);
      if (u.needsRelink && !u.hash) { deleteUser(u); return res.json({ ok: true, deleted: true }); }
      res.json({ ok: true });
    });

    if (BASE) app.use(BASE + '/api/account', r);
    app.use('/api/account', r);
  }

  let timer = null;
  function start() {
    if (!enabled) { o.log('deaktiviert (accounts.botMxid nicht gesetzt).'); return; }
    processInbox(); purgeOrphans();
    timer = setInterval(() => { processInbox(); purgeOrphans(); if (prune()) save(); }, o.inboxPollMs);
    timer.unref && timer.unref();
    o.log(`aktiv – Bot ${o.botMxid}, Daten in ${o.dataDir}`);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {
    enabled, mount, start, stop, processInbox, handleInbound,
    userFromReq, isRegisteredName, usernameAvailable, publicUser,
    paths: { DB_FILE, INBOX, OUTBOX },
    _db: () => db,
  };
}

module.exports = { createAccounts, USERNAME_RE, CODE_RE, RELINK_RE, DELETE_RE };
