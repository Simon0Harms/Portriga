'use strict';
/*
 * Portriga – Ankündigung neuer öffentlicher/Ranglisten-Spiele in einem Matrix-Raum.
 *
 * Wird ein Raum im Modus „public“ oder „ranked“ eröffnet (oder ein privater Raum
 * erstmals auf einen dieser Modi umgestellt), legt die App einen Auftrag in die
 * Matrix-Outbox. Der Sidecar (deploy/matrix/portriga_matrix_bot.py) sendet ihn in
 * den konfigurierten Ankündigungsraum – auch wenn dieser unverschlüsselt ist,
 * aber ausschließlich dorthin (Allowlist im Sidecar: PORTRIGA_ANNOUNCE_ROOM).
 *
 * Schutz vor Spam: je Ersteller (Konto bzw. IP) höchstens eine Ankündigung pro
 * `perCreatorSec`, insgesamt höchstens `maxPerHour`. Jeder Raum wird nur einmal
 * angekündigt.
 *
 * Rückzug: Startet das Spiel (oder wird der Raum geschlossen bzw. wieder privat),
 * legt `retract(ref)` einen Auftrag in die Outbox, mit dem der Sidecar seine eigene
 * Ankündigung per Matrix-Redaction entfernt. `ref` ist die von `announce()`
 * zurückgegebene Auftrags-ID; der Sidecar merkt sich dazu die event_id.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOM_RE = /^[!#][^\s:]+:[A-Za-z0-9.\-]+(:\d+)?$/;

// Nutzertext für einen öffentlichen Raum entschärfen: Steuerzeichen/Zeilenumbrüche raus,
// Länge begrenzen, „@“ brechen (kein @room-/Mention-Ping durch Spielernamen).
function clean(s, max = 40) {
  return String(s || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, max).replace(/@/g, '@\u200b');
}

function createAnnouncer(opts) {
  const o = Object.assign({
    room: '', link: '', outboxDir: '', publicUrl: '',
    perCreatorSec: 120, maxPerHour: 30,
    now: () => Date.now(),
    log: (...a) => console.log('[announce]', ...a),
  }, opts || {});
  const room = String(o.room || '').trim();
  const enabled = ROOM_RE.test(room) && !!o.outboxDir;
  if (room && !ROOM_RE.test(room)) o.log('Ungültige Raum-ID/-Alias, Ankündigungen aus:', room);
  const link = String(o.link || '').trim() || (enabled ? 'https://matrix.to/#/' + encodeURIComponent(room) : '');
  const base = String(o.publicUrl || '').replace(/\/+$/, '');
  const lastByCreator = new Map();
  let recent = [];

  function writeJob(extra) {
    try {
      fs.mkdirSync(o.outboxDir, { recursive: true, mode: 0o700 });
      const id = Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex');
      const tmp = path.join(o.outboxDir, '.' + id + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id, roomId: room, createdAt: Date.now() }, extra)), { mode: 0o600 });
      fs.renameSync(tmp, path.join(o.outboxDir, id + '.json'));
      return id;
    } catch (e) { o.log('Outbox-Fehler:', e.message); return null; }
  }

  function enqueue(body) { return writeJob({ body, announce: true }); }

  function text(r) {
    const ranked = r.mode === 'ranked';
    const lines = [
      ranked ? `🏅 Neues Ranglisten-Spiel – Raum ${r.code}` : `🃏 Neues öffentliches Spiel – Raum ${r.code}`,
      `Erstellt von ${clean(r.host)} · ${r.players}/${r.maxPlayers} Plätze belegt`,
    ];
    if (ranked) lines.push('Nur mit angemeldetem Konto, keine Bots – das Ergebnis zählt für die Rangliste.');
    lines.push(base ? `Mitspielen: ${base}/?join=${encodeURIComponent(r.code)}` : `Mitspielen: Raumcode ${r.code} in Portriga eingeben.`);
    return lines.join('\n');
  }

  /** r: { code, mode, host, players, maxPlayers, creatorKey } – Rückgabe: Auftrags-ID (Referenz für retract) oder false */
  function announce(r) {
    if (!enabled || !r || (r.mode !== 'public' && r.mode !== 'ranked')) return false;
    const t = o.now();
    recent = recent.filter(x => t - x < 3600e3);
    if (recent.length >= o.maxPerHour) { o.log('Stundenlimit erreicht – nicht angekündigt:', r.code); return false; }
    const key = String(r.creatorKey || '');
    if (key) {
      const last = lastByCreator.get(key);
      if (last && t - last < o.perCreatorSec * 1000) { o.log('Ersteller-Limit – nicht angekündigt:', r.code); return false; }
    }
    const id = enqueue(text(r));
    if (!id) return false;
    recent.push(t);
    if (key) lastByCreator.set(key, t);
    if (lastByCreator.size > 5000) for (const [k, v] of lastByCreator) if (t - v > o.perCreatorSec * 1000) lastByCreator.delete(k);
    return id;
  }

  /** Ankündigung zurückziehen (Redaction durch den Sidecar). ref = Rückgabe von announce(). */
  function retract(ref, reason) {
    if (!enabled || !ref || typeof ref !== 'string') return false;
    return !!writeJob({ retract: ref, reason: clean(reason || 'Spiel gestartet', 80) });
  }

  return { enabled, room: enabled ? room : '', link, announce, retract, text };
}

module.exports = { createAnnouncer, clean };
