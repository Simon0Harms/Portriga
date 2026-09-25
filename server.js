'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { Game, setRanks, MAX_PLAYERS_LIMIT } = require('./game');
const { botBid, botCardId } = require('./bots');
const { createAccounts } = require('./accounts');
const { createRanking, periodKey, PERIODS } = require('./ranking');
const { createAdmins } = require('./admins');
const { createAnnouncer } = require('./announce');

// ---- Zentrale Konfiguration (config.js) ----
const { loadConfig, dataDirOf } = require('./config');
const CONFIG = loadConfig();
if (CONFIG.game && CONFIG.game.ranks) {
  try { setRanks(CONFIG.game.ranks); } catch (e) { console.warn('game.ranks ignoriert:', e.message); }
}
// Max. Plätze pro Raum (2..63). Ungültige Werte -> 7 (klassische Regel).
const MAX_PLAYERS = (() => {
  const v = Number(CONFIG.game && CONFIG.game.maxPlayers);
  if (Number.isInteger(v) && v >= 2 && v <= MAX_PLAYERS_LIMIT) return v;
  console.warn(`game.maxPlayers ungültig (${CONFIG.game && CONFIG.game.maxPlayers}) – nutze 7.`);
  return 7;
})();
const PORT = CONFIG.port || 3000;

// ICE-Server für WebRTC-Voice aus der Konfiguration.
function iceServers() {
  const list = [{ urls: CONFIG.ice.stun }];
  const t = CONFIG.ice.turn;
  if (t && t.url) list.push({ urls: t.url, username: t.user || '', credential: t.pass || '' });
  return list;
}

const app = express();

// Basis-Pfad für Subdirectory-Betrieb (z.B. "/portriga"). Leer = Root.
const BASE = String((CONFIG.basePath || '')).replace(/\/+$/, '');

// index.html mit injiziertem Basis-Pfad ausliefern (für <base href> und window.__BASE__).
const PUB = path.join(__dirname, 'public');
let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/%%BASE%%/g, BASE);
} catch (e) { console.error('index.html nicht lesbar:', e.message); }
const sendIndex = (_req, res) => res.type('html').send(INDEX_HTML);

// ---- Ankündigungsraum auf Matrix (neue öffentliche/Ranglisten-Spiele, siehe announce.js) ----
const ANN = CONFIG.announce || {};
const announcer = createAnnouncer({
  room: ANN.room, link: ANN.link,
  outboxDir: path.join(dataDirOf(CONFIG), 'matrix-outbox'),
  publicUrl: String((CONFIG.accounts || {}).publicUrl || '').trim(),
  perCreatorSec: Math.max(0, Number(ANN.perCreatorSec) || 0),
  maxPerHour: Math.max(1, Number(ANN.maxPerHour) || 30),
});
if (announcer.enabled) console.log('Ankündigungen neuer Spiele in', announcer.room);
const announceInfo = (_req, res) => res.json({ enabled: announcer.enabled, room: announcer.room || null, link: announcer.link || null });
if (BASE) app.get(BASE + '/api/announce', announceInfo);
app.get('/api/announce', announceInfo);
// Raum einmalig ankündigen, sobald er öffentlich/Rangliste ist.
function announceRoom(room, ws) {
  if (room.announced || room.mode === 'private') return;
  const host = seatOf(room, room.hostId);
  const ok = announcer.announce({ code: room.code, mode: room.mode, host: host ? host.name : '?',
    players: room.seats.length, maxPlayers: MAX_PLAYERS,
    creatorKey: ws.account ? 'acc:' + ws.account.id : 'ip:' + (ws.ip || '') });
  if (ok) { room.announced = true; room.announceRef = ok; systemChat(room, 'Dieses Spiel wurde im Matrix-Raum angekündigt.'); }
}
// Ankündigung im Matrix-Raum wieder entfernen (Spielstart, Raum geschlossen, wieder privat).
function retractAnnouncement(room, reason) {
  if (!room.announceRef) return;
  announcer.retract(room.announceRef, reason);
  room.announceRef = null;
}

// ---- Benutzerkonten (Registrierung per Matrix-DM, siehe accounts.js) ----
const AC = CONFIG.accounts || {};
const accounts = createAccounts({
  dataDir: dataDirOf(CONFIG),
  botMxid: String(AC.botMxid || '').trim(),
  publicUrl: String(AC.publicUrl || '').trim(),
  codeTtlMs: Math.max(1, Number(AC.codeTtlMin) || 15) * 60 * 1000,
  sessionTtlMs: Math.max(1, Number(AC.sessionDays) || 30) * 24 * 3600 * 1000,
  cookieSecure: AC.cookieSecure !== false,
  basePath: BASE,
  announceRoom: announcer.room, announceLink: announcer.link,
  // Gelöschtes Konto: offene Verbindungen sofort abmelden (Sitze bleiben als Gast bestehen).
  onUserDeleted: (id) => {
    for (const c of wss.clients) {
      if (c.account && c.account.id === id) { c.account = null; send(c, { type: 'account', user: null }); }
    }
    ranking.removeUser(id);
    for (const room of rooms.values()) {
      let hit = false;
      for (const s of room.seats) if (s.accountId === id) { s.accountId = null; hit = true; }
      if (hit) broadcast(room);
    }
  },
});
accounts.mount(app, express, BASE);
accounts.start();

// ---- Spielmodi & Rangliste (Issue #8) ----
// private: nur per Code/Link · public: in der Raumliste, jeder darf beitreten
// ranked: in der Raumliste, nur angemeldete Konten, keine Bots, Ergebnis zählt für die Rangliste
const MODES = ['private', 'public', 'ranked'];
const MODE_LABEL = { private: 'Privat', public: 'Öffentlich', ranked: 'Rangliste' };
// Platzänderungen per Matrix-DM melden (nur Konten mit aktivierter Option, siehe accounts.notifyRankChanges)
const ranking = createRanking({ dataDir: dataDirOf(CONFIG), onRankChanges: (ch) => accounts.notifyRankChanges(ch) });
// Admin-Rolle: wird per Terminal vergeben (node admin-cli.js), siehe admins.js.
const admins = createAdmins({ dataDir: dataDirOf(CONFIG) });
// ?period=all|year|month|week (Standard: all), optional ?key=JJJJ, JJJJ-MM bzw. JJJJ-Www für vergangene Zeiträume
const rankingHandler = (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'all';
  const re = period === 'year' ? /^\d{4}$/ : period === 'week' ? /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/ : /^\d{4}-(0[1-9]|1[0-2])$/;
  const key = period === 'all' ? null : (typeof req.query.key === 'string' && re.test(req.query.key) ? req.query.key : periodKey(period));
  res.set('Cache-Control', 'no-store').json({ enabled: accounts.enabled, period, key, players: ranking.top(50, period, key) });
};
if (BASE) app.get(BASE + '/api/ranking', rankingHandler);
app.get('/api/ranking', rankingHandler);

app.get('/health', (_req, res) => res.json({ ok: true }));

// QR-Code (SVG) für den Direktlink zum Raumbeitritt (Lobby).
// Der Client übergibt den fertigen Link, da nur er die öffentliche URL
// (inkl. Reverse-Proxy/Basis-Pfad) sicher kennt. Länge begrenzt.
const qrHandler = (req, res) => {
  const t = String(req.query.t || '');
  if (!t || t.length > 512 || !/^https?:\/\//i.test(t)) return res.status(400).send('bad request');
  QRCode.toString(t, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }, (err, svg) => {
    if (err) return res.status(500).send('qr error');
    res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(svg);
  });
};
if (BASE) app.get(BASE + '/qr.svg', qrHandler);
app.get('/qr.svg', qrHandler);

// Statische Dateien und Index sowohl unter dem Basis-Pfad ALS AUCH unter Root
// ausliefern – so funktioniert es, egal ob der Reverse-Proxy das Präfix strippt oder nicht.
if (BASE) {
  app.get(BASE, sendIndex);
  app.get(BASE + '/', sendIndex);
  app.use(BASE, express.static(PUB, { index: false }));
}
app.get('/', sendIndex);
app.use('/', express.static(PUB, { index: false }));


const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Heartbeat: hält WS-Verbindungen offen (verhindert stille Proxy-Idle-Timeouts)
// und räumt tote Verbindungen ab.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));


/* ---------------- Räume im Speicher ----------------
 * room = {
 *   code, hostId,
 *   seats: [{id,name,bot,connected}],   // Sitzordnung
 *   game: Game|null,
 * }
 * Verbindungen: clientId -> ws
 */
const rooms = new Map();        // code -> room
const sockets = new Map();      // clientId -> ws
const clientRoom = new Map();   // clientId -> code

function code4() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function toast(ws, message) { send(ws, { type: 'toast', message }); }
function err(ws, message) { send(ws, { type: 'error', message }); }

// ---- Chat ----
const CHAT_MAX = CONFIG.chat.historyMax;      // History-Länge pro Raum
const CHAT_TEXT_MAX = CONFIG.chat.textMax;    // max. Zeichen pro Nachricht
function pushChat(room, msg) {
  if (!room.chat) room.chat = [];
  room.chat.push(msg);
  if (room.chat.length > CHAT_MAX) room.chat.shift();
}
function broadcastChat(room, msg) {
  for (const s of room.seats) if (!s.bot && isInRoom(room, s.id)) send(sockets.get(s.id), { type: 'chat', msg });
}
function systemChat(room, text) {
  const msg = { system: true, text, ts: Date.now() };
  pushChat(room, msg); broadcastChat(room, msg);
}
function sendChatHistory(ws, room) {
  send(ws, { type: 'chatHistory', messages: room.chat || [] });
}

// ---- Voice (WebRTC-Mesh) ----
function voiceMembers(room) {
  if (!room.voice) return [];
  return [...room.voice]
    .map(id => { const s = seatOf(room, id); return s ? { id, name: s.name, muted: isMuted(room, s) } : null; })
    .filter(Boolean);
}
function broadcastVoice(room) {
  const members = voiceMembers(room);
  for (const s of room.seats) if (!s.bot && isInRoom(room, s.id)) send(sockets.get(s.id), { type: 'voice', members });
}
function leaveVoice(room, clientId) {
  if (room.voice && room.voice.delete(clientId)) broadcastVoice(room);
}

/* ---- Abstimmung: Spielstart / nächste Runde (Issue #9) ----
 * room.vote = { kind:'start'|'next', votes:{clientId:'yes'|'no'},
 *               remainingMs, deadline, paused, timer }
 * - Stimmberechtigt sind alle verbundenen menschlichen Spieler.
 * - Stimmen alle mit Ja -> sofort Start.
 * - Stimmt jemand mit Nein -> Zeit wird angehalten, bis alle Nein-Stimmen zu Ja wechseln.
 * - Läuft die Zeit ab (nur möglich ohne Nein-Stimme) -> Start; Nichtwähler gelten als Zustimmung.
 * - Spielstart mit getrennten (offline) Spielern in der Lobby: kein Sofortstart, auch wenn alle
 *   Verbundenen mit Ja stimmen – der Timer läuft regulär ab (Nein-Stimmen halten ihn wie gewohnt an).
 *   Wer bei Ablauf noch offline ist, wird aus dem Raum entfernt (ohne Sperre, erneuter Beitritt
 *   möglich); danach startet das Spiel.
 * - Geht ein Spieler offline, verfällt seine Stimme (gilt als nicht abgestimmt). War es die
 *   letzte Nein-Stimme, läuft der Timer weiter.
 */
const VOTE_MS = 60000;
function voters(room) { return room.seats.filter(s => !s.bot && s.connected); }
function offlineHumans(room) { return room.seats.filter(s => !s.bot && !s.connected); }
/* Startabstimmung in der Lobby, während mindestens ein Spieler offline ist. */
function waitingForOffline(room) {
  const v = room.vote;
  return !!v && v.kind === 'start' && !room.game && offlineHumans(room).length > 0;
}
function voteView(room) {
  const v = room.vote;
  if (!v) return null;
  const remainingMs = v.paused ? v.remainingMs : Math.max(0, v.deadline - Date.now());
  return {
    kind: v.kind, paused: v.paused, remainingMs, totalMs: VOTE_MS,
    offline: waitingForOffline(room) ? offlineHumans(room).map(s => s.name) : [],
    voters: voters(room).map(s => ({ id: s.id, name: s.name, vote: v.votes[s.id] || null })),
  };
}
function clearVote(room) {
  if (room.vote && room.vote.timer) clearTimeout(room.vote.timer);
  room.vote = null;
}
function armVoteTimer(room) {
  const v = room.vote;
  if (v.timer) clearTimeout(v.timer);
  v.timer = setTimeout(() => {
    if (room.vote !== v || v.paused) return;
    if (waitingForOffline(room)) { expireOffline(room, v); return; }
    finishVote(room, 'Zeit abgelaufen');
  }, v.remainingMs);
  v.deadline = Date.now() + v.remainingMs;
  v.paused = false;
}
function openVote(room, kind) {
  clearVote(room);
  room.vote = { kind, votes: {}, remainingMs: VOTE_MS, deadline: 0, paused: false, timer: null };
  armVoteTimer(room);
}
/* Zeit abgelaufen, aber noch Spieler offline: diese entfernen, danach regulär auswerten. */
function expireOffline(room, v) {
  v.timer = null;
  for (const s of offlineHumans(room)) {
    if (room.vote !== v) break;          // Abstimmung ggf. beim Entfernen hinfällig geworden
    systemChat(room, `${s.name} war bei Ablauf der Startabstimmung offline und wurde aus dem Raum entfernt.`);
    leaveCurrent(s.id);                  // entfernt den Sitz, übergibt ggf. den Host, wertet aus/broadcastet
  }
  if (room.vote !== v || rooms.get(room.code) !== room) return;
  finishVote(room, 'Zeit abgelaufen');   // Timer läuft nur ohne Nein-Stimme ab
}
/* Nach jeder Stimm-/Sitzänderung: sofort starten, pausieren oder fortsetzen. */
function evaluateVote(room) {
  const v = room.vote;
  if (!v) return false;
  // Stimmen getrennter Spieler verfallen – sie gelten als nicht abgestimmt (auch nach Reconnect).
  for (const s of room.seats) if (!s.bot && !s.connected) delete v.votes[s.id];
  const vs = voters(room);
  // Offline-Spieler vorhanden: kein vorzeitiger Start, der Timer muss ablaufen.
  if (!waitingForOffline(room) && vs.length > 0 && vs.every(s => v.votes[s.id] === 'yes')) {
    finishVote(room, null);
    return true;
  }
  const anyNo = vs.some(s => v.votes[s.id] === 'no');
  if (anyNo && !v.paused) {
    clearTimeout(v.timer); v.timer = null;
    v.remainingMs = Math.max(0, v.deadline - Date.now());
    v.paused = true;
  } else if (!anyNo && v.paused) {
    armVoteTimer(room);
  }
  return false;
}
function finishVote(room, reason) {
  const kind = room.vote && room.vote.kind;
  clearVote(room);
  if (kind === 'start') {
    if (room.game || room.seats.length < 2) { broadcast(room); return; }
    if (room.mode === 'ranked') {
      try { checkRankedAllowed(room); }
      catch (e) { systemChat(room, `Start abgebrochen: ${e.message}`); broadcast(room); return; }
    }
    room.game = new Game(room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot })));
    room.game.start();
    retractAnnouncement(room, 'Spiel gestartet');
    systemChat(room, `Das Spiel wurde gestartet${reason ? ` (${reason})` : ''}. Viel Erfolg!`);
  } else if (kind === 'next') {
    if (!room.game || room.game.phase !== 'roundEnd') { broadcast(room); return; }
    room.game.nextRound();
    if (reason) systemChat(room, `Nächste Runde gestartet (${reason}).`);
  }
  broadcast(room);
  driveBots(room);
}
/* Rundenende erkannt -> Abstimmung für die nächste Runde öffnen. */
function syncVote(room) {
  const g = room.game;
  if (g && g.phase === 'roundEnd') {
    if (!room.vote || room.vote.kind !== 'next') openVote(room, 'next');
  } else if (room.vote && room.vote.kind === 'next') {
    clearVote(room);
  }
}

/* ---- Votekick (nur in der Lobby) ----
 * room.kick = { targetId, initiatorId, votes:{clientId:'yes'|'no'}, deadline, timer }
 * - Stimmberechtigt: alle verbundenen menschlichen Spieler außer dem Betroffenen.
 * - Gekickt wird, sobald MEHR als 50 % der Stimmberechtigten mit Ja gestimmt haben.
 * - Ist keine Mehrheit mehr erreichbar oder läuft die Zeit ab -> abgelehnt.
 * - Ein Admin (Rolle per Terminal vergeben, siehe admin-cli.js) kickt sofort ohne Abstimmung;
 *   Admins selbst können nicht per Abstimmung gekickt werden.
 * - Gekickte Spieler können dem Raum nicht erneut beitreten.
 */
const KICK_MS = 60000;
function kickVoters(room) {
  const k = room.kick;
  return k ? voters(room).filter(s => s.id !== k.targetId) : [];
}
function kickView(room) {
  const k = room.kick;
  if (!k) return null;
  const target = seatOf(room, k.targetId);
  const vs = kickVoters(room);
  return {
    targetId: k.targetId, targetName: target ? target.name : '?',
    remainingMs: Math.max(0, k.deadline - Date.now()), totalMs: KICK_MS,
    needed: Math.floor(vs.length / 2) + 1,
    voters: vs.map(s => ({ id: s.id, name: s.name, vote: k.votes[s.id] || null })),
  };
}
function clearKick(room) {
  if (room.kick && room.kick.timer) clearTimeout(room.kick.timer);
  room.kick = null;
}
function openKick(room, targetId, initiatorId) {
  clearKick(room);
  const k = { targetId, initiatorId, votes: { [initiatorId]: 'yes' }, deadline: Date.now() + KICK_MS, timer: null };
  k.timer = setTimeout(() => {
    if (room.kick !== k || rooms.get(room.code) !== room) return;
    const target = seatOf(room, k.targetId);
    clearKick(room);
    systemChat(room, `Abstimmung zum Kicken von ${target ? target.name : '?'} abgelaufen – keine Mehrheit.`);
    broadcast(room);
  }, KICK_MS);
  room.kick = k;
}
/* 'kick' = Mehrheit erreicht, 'fail' = Mehrheit nicht mehr möglich, 'gone' = hinfällig, null = offen */
function kickOutcome(room) {
  const k = room.kick;
  if (!k) return null;
  if (room.game || !seatOf(room, k.targetId)) return 'gone';
  const vs = kickVoters(room);
  const yes = vs.filter(s => k.votes[s.id] === 'yes').length;
  const no = vs.filter(s => k.votes[s.id] === 'no').length;
  if (vs.length > 0 && yes * 2 > vs.length) return 'kick';
  if ((vs.length - no) * 2 <= vs.length) return 'fail';
  return null;
}
function resolveKick(room) {
  const outcome = kickOutcome(room);
  if (!outcome) return false;
  const k = room.kick;
  const target = seatOf(room, k.targetId);
  clearKick(room);
  if (outcome === 'kick') kickPlayer(room, k.targetId, 'per Abstimmung');
  else {
    if (outcome === 'fail' && target) systemChat(room, `${target.name} wird nicht gekickt – keine Mehrheit.`);
    broadcast(room);
  }
  return true;
}
function kickPlayer(room, targetId, how) {
  const seat = seatOf(room, targetId);
  if (!seat || seat.bot) return;
  if (!room.banned) room.banned = { ids: new Set(), accounts: new Set() };
  room.banned.ids.add(targetId);
  if (seat.accountId) room.banned.accounts.add(seat.accountId);
  systemChat(room, `${seat.name} wurde ${how} aus dem Raum entfernt.`);
  const ws = sockets.get(targetId);
  leaveCurrent(targetId);   // entfernt den Sitz, übergibt ggf. den Host, broadcastet
  send(ws, { type: 'kicked', reason: `Du wurdest ${how} aus dem Raum ${room.code} entfernt.` });
  send(ws, { type: 'roomList', rooms: roomListView() });
}
/* ---- Mute per Abstimmung (Lobby und laufendes Spiel) ----
 * room.muted   = { ids:Set<clientId>, accounts:Set<accountId> }  – stummgeschaltet in Text- und Sprachchat
 * room.muteVote = { targetId, initiatorId, action:'mute'|'unmute', votes:{clientId:'yes'|'no'}, deadline, timer }
 * - Stimmberechtigt: alle verbundenen menschlichen Spieler außer dem Betroffenen.
 * - Wirksam, sobald MEHR als 50 % der Stimmberechtigten mit Ja gestimmt haben.
 * - Sind nur 2 Menschen im Raum, greift der (Ent-)Mute sofort.
 * - Admins muten/entmuten sofort und können selbst nicht per Abstimmung gemutet werden.
 * - Stummgeschaltete dürfen nicht schreiben; im Voice dürfen sie nur zuhören – ihr Audio wird
 *   von allen Empfängern verworfen und ihr eigener Client sendet kein Mikrofon mehr.
 * - Der Mute hängt an Client-ID und Konto und überdauert Reconnect/Neubeitritt im selben Raum.
 */
const MUTE_MS = 60000;
function isMuted(room, seat) {
  const m = room.muted;
  return !!m && !!seat && (m.ids.has(seat.id) || (seat.accountId != null && m.accounts.has(seat.accountId)));
}
function setMuted(room, seat, on) {
  if (!room.muted) room.muted = { ids: new Set(), accounts: new Set() };
  const m = room.muted;
  if (on) { m.ids.add(seat.id); if (seat.accountId != null) m.accounts.add(seat.accountId); }
  else { m.ids.delete(seat.id); if (seat.accountId != null) m.accounts.delete(seat.accountId); }
}
function muteVoters(room) {
  const v = room.muteVote;
  return v ? voters(room).filter(s => s.id !== v.targetId) : [];
}
function muteView(room) {
  const v = room.muteVote;
  const players = room.seats.filter(s => !s.bot).map(s => ({
    id: s.id, name: s.name, connected: s.connected, muted: isMuted(room, s), admin: isAdminSeat(s),
  }));
  let vote = null;
  if (v) {
    const target = seatOf(room, v.targetId);
    const vs = muteVoters(room);
    vote = {
      targetId: v.targetId, targetName: target ? target.name : '?', action: v.action,
      remainingMs: Math.max(0, v.deadline - Date.now()), totalMs: MUTE_MS,
      needed: Math.floor(vs.length / 2) + 1,
      voters: vs.map(s => ({ id: s.id, name: s.name, vote: v.votes[s.id] || null })),
    };
  }
  return { players, vote };
}
function clearMuteVote(room) {
  if (room.muteVote && room.muteVote.timer) clearTimeout(room.muteVote.timer);
  room.muteVote = null;
}
function openMuteVote(room, targetId, initiatorId, action) {
  clearMuteVote(room);
  const v = { targetId, initiatorId, action, votes: { [initiatorId]: 'yes' }, deadline: Date.now() + MUTE_MS, timer: null };
  v.timer = setTimeout(() => {
    if (room.muteVote !== v || rooms.get(room.code) !== room) return;
    const target = seatOf(room, v.targetId);
    clearMuteVote(room);
    systemChat(room, `Abstimmung zum ${v.action === 'mute' ? 'Muten' : 'Entmuten'} von ${target ? target.name : '?'} abgelaufen – keine Mehrheit.`);
    broadcast(room);
  }, MUTE_MS);
  room.muteVote = v;
}
/* 'pass' = Mehrheit erreicht, 'fail' = Mehrheit nicht mehr möglich, 'gone' = hinfällig, null = offen */
function muteOutcome(room) {
  const v = room.muteVote;
  if (!v) return null;
  const target = seatOf(room, v.targetId);
  if (!target || isMuted(room, target) === (v.action === 'mute')) return 'gone';
  const vs = muteVoters(room);
  const yes = vs.filter(s => v.votes[s.id] === 'yes').length;
  const no = vs.filter(s => v.votes[s.id] === 'no').length;
  if (vs.length > 0 && yes * 2 > vs.length) return 'pass';
  if ((vs.length - no) * 2 <= vs.length) return 'fail';
  return null;
}
function resolveMuteVote(room) {
  const outcome = muteOutcome(room);
  if (!outcome) return false;
  const v = room.muteVote;
  const target = seatOf(room, v.targetId);
  clearMuteVote(room);
  if (outcome === 'pass') applyMute(room, target, v.action === 'mute', 'per Abstimmung');
  else {
    if (outcome === 'fail' && target) systemChat(room, `${target.name} wird nicht ${v.action === 'mute' ? 'gemutet' : 'entmutet'} – keine Mehrheit.`);
    broadcast(room);
  }
  return true;
}
function applyMute(room, seat, on, how) {
  if (!seat || seat.bot) return;
  setMuted(room, seat, on);
  systemChat(room, on ? `${seat.name} wurde ${how} stummgeschaltet (Text- und Sprachchat).`
                      : `${seat.name} wurde ${how} wieder freigeschaltet.`);
  broadcast(room);
  broadcastVoice(room);
}

function isAdminSeat(seat) { return !!seat && !seat.bot && admins.isAdmin(seat.accountId); }
function isBanned(room, ws) {
  const b = room.banned;
  return !!b && (b.ids.has(ws.clientId) || (ws.account && b.accounts.has(ws.account.id)));
}

function lobbyView(room) {
  return {
    type: 'state',
    lobby: true,
    code: room.code,
    mode: room.mode,
    hostId: room.hostId,
    seats: room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot, connected: s.connected, verified: !!s.accountId, admin: isAdminSeat(s) })),
    maxPlayers: MAX_PLAYERS,
    vote: voteView(room),
    kick: kickView(room),
    mute: muteView(room),
  };
}

function broadcast(room) {
  syncVote(room);
  // Sitz-/Verbindungsänderung kann eine laufende Kick-Abstimmung entscheiden -> nachgelagert auflösen.
  if (kickOutcome(room)) setImmediate(() => { if (rooms.get(room.code) === room) resolveKick(room); });
  if (muteOutcome(room)) setImmediate(() => { if (rooms.get(room.code) === room) resolveMuteVote(room); });
  recordRanked(room);
  scheduleRoomList();
  if (!room.game) {
    for (const s of room.seats) {
      if (!s.bot && isInRoom(room, s.id)) send(sockets.get(s.id), { ...lobbyView(room), youId: s.id });
    }
    return;
  }
  for (const s of room.seats) {
    if (s.bot || !isInRoom(room, s.id)) continue;
    const ws = sockets.get(s.id);
    if (!ws) continue;
    send(ws, {
      type: 'state',
      lobby: false,
      code: room.code,
      mode: room.mode,
      hostId: room.hostId,
      view: room.game.viewFor(s.id),
      vote: voteView(room),
      mute: muteView(room),
    });
  }
}

/* Bots automatisch ziehen lassen, solange ein Bot am Zug ist. */
const LAST_TRICK_SHOW_MS = 5000;
function driveBots(room) {
  const g = room.game;
  if (!g) return;
  if (g.phase !== 'bidding' && g.phase !== 'playing') return;
  const seat = room.seats[g.turnIdx];
  if (!seat || !seat.bot) return;
  // Nach einem abgeschlossenen Stich warten Bots die Anzeigedauer des
  // letzten Stichs ab (Issue #1), sonst wird er sofort überdeckt.
  const delay = (g.phase === 'playing' && g.currentTrick.length === 0 && g.tricksPlayed > 0)
    ? LAST_TRICK_SHOW_MS : CONFIG.bots.moveDelayMs;
  setTimeout(() => {
    try {
      if (g.phase === 'bidding') g.placeBid(seat.id, botBid(g, g.turnIdx));
      else if (g.phase === 'playing') g.playCard(seat.id, botCardId(g, seat.id));
    } catch (e) { /* Zustand hat sich geändert – ignorieren */ }
    broadcast(room);
    driveBots(room);
  }, delay);
}

/* Ranglisten-Spiel beendet -> Ergebnis genau einmal speichern. */
function recordRanked(room) {
  const g = room.game;
  if (room.mode !== 'ranked' || !g || g.phase !== 'gameEnd' || room.rankedRecorded) return;
  room.rankedRecorded = true;
  const results = g.players.map(p => {
    const seat = seatOf(room, p.id);
    return { accountId: seat && seat.accountId, username: p.name, score: p.score };
  });
  try {
    if (ranking.recordGame(results)) systemChat(room, 'Ergebnis wurde in die Rangliste eingetragen.');
  } catch (e) { console.warn('Rangliste nicht gespeichert:', e.message); }
}

/* Offene öffentliche/Ranglisten-Räume (Lobby, nicht voll) für den Startbildschirm. */
function roomListView() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.mode === 'private' || room.game || room.seats.length >= MAX_PLAYERS) continue;
    const host = seatOf(room, room.hostId);
    list.push({ code: room.code, mode: room.mode, host: host ? host.name : '?',
      players: room.seats.length, maxPlayers: MAX_PLAYERS, voting: !!room.vote });
  }
  return list.sort((a, b) => b.players - a.players || a.code.localeCompare(b.code));
}
// An alle Clients ohne Raum (Startbildschirm) senden – gebündelt, max. einmal pro Tick.
let roomListPending = false;
function scheduleRoomList() {
  if (roomListPending) return;
  roomListPending = true;
  setImmediate(() => {
    roomListPending = false;
    const msg = { type: 'roomList', rooms: roomListView() };
    for (const c of wss.clients) if (c.clientId && !clientRoom.has(c.clientId)) send(c, msg);
  });
}
function parseMode(v) { return MODES.includes(v) ? v : 'private'; }
function checkRankedAllowed(room) {
  if (!accounts.enabled) throw new Error('Ranglisten-Spiele benötigen Benutzerkonten (auf diesem Server deaktiviert).');
  if (room.seats.some(s => s.bot)) throw new Error('Ranglisten-Spiele sind ohne Bots – bitte zuerst alle Bots entfernen.');
  if (room.seats.some(s => !s.accountId)) throw new Error('Ranglisten-Spiele nur mit angemeldeten Konten – im Raum sitzen noch Gäste.');
}

function seatOf(room, clientId) { return room.seats.find(s => s.id === clientId); }

// Nur Spieler, deren Zuordnung (noch) auf diesen Raum zeigt. Wer ein beendetes Spiel
// verlassen hat, behält dort seinen Sitz, sitzt aber evtl. schon in einem neuen Raum –
// dessen Zuordnung darf beim Aufräumen des alten Raums nicht gelöscht werden.
function isInRoom(room, clientId) { return clientRoom.get(clientId) === room.code; }
function discardRoom(room) {
  clearVote(room);
  clearKick(room);
  clearMuteVote(room);
  for (const s of room.seats) if (!s.bot && isInRoom(room, s.id)) clientRoom.delete(s.id);
  if (rooms.get(room.code) === room) rooms.delete(room.code);
  scheduleRoomList();
}
function closeRoom(room, reason) {
  for (const s of room.seats) {
    if (!s.bot && isInRoom(room, s.id)) {
      send(sockets.get(s.id), { type: 'roomClosed', reason });
      clientRoom.delete(s.id);
    }
  }
  clearVote(room);
  clearKick(room);
  clearMuteVote(room);
  retractAnnouncement(room, 'Raum geschlossen');
  rooms.delete(room.code);
  scheduleRoomList();
}

wss.on('connection', (ws, req) => {
  ws.clientId = null;
  // Angemeldetes Konto aus dem Session-Cookie (Handshake). Nach Login/Logout baut der
  // Client die WebSocket-Verbindung neu auf, damit der neue Zustand greift.
  ws.account = accounts.userFromReq(req);
  ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { handle(ws, m); }
    catch (e) {
      err(ws, e.message || 'Fehler');
      // Client zeigt noch einen Raum, der Server kennt ihn aber nicht (mehr) -> UI zurücksetzen.
      if (e.noRoom) { send(ws, { type: 'left' }); send(ws, { type: 'roomList', rooms: roomListView() }); }
    }
  });

  ws.on('close', () => {
    const id = ws.clientId;
    if (!id) return;
    // Abgelöster Socket (Sitz wurde übernommen): Sitz nicht als getrennt markieren.
    if (sockets.get(id) !== ws) return;
    sockets.delete(id);
    const code = clientRoom.get(id);
    const room = code && rooms.get(code);
    if (!room) return;
    const seat = seatOf(room, id);
    if (seat) seat.connected = false;
    if (room.voice && room.voice.has(id)) room.voice.delete(id);
    if (evaluateVote(room)) return;
    // Lobby: leert sich der Raum von Menschen -> schließen
    const humans = room.seats.filter(s => !s.bot);
    if (humans.every(s => !s.connected)) {
      // niemand mehr da: Raum verwerfen
      retractAnnouncement(room, 'Raum geschlossen');
      discardRoom(room);
      return;
    }
    broadcast(room);
    broadcastVoice(room);
  });
});

function handle(ws, m) {
  switch (m.type) {
    case 'hello': {
      const id = String(m.clientId || '').slice(0, 40);
      if (!id) return err(ws, 'Ungültige Client-ID.');
      // Socket wechselt die Client-ID (Sitzübernahme): alte Zuordnung lösen.
      if (ws.clientId && ws.clientId !== id && sockets.get(ws.clientId) === ws) sockets.delete(ws.clientId);
      // Läuft dieselbe Client-ID noch auf einem anderen Gerät/Tab: dort ablösen.
      const prevWs = sockets.get(id);
      if (prevWs && prevWs !== ws) {
        send(prevWs, { type: 'replaced', message: 'Dein Platz wurde von einem anderen Gerät/Tab übernommen.' });
        try { prevWs.close(); } catch (_) {}
      }
      ws.clientId = id;
      sockets.set(id, ws);
      send(ws, { type: 'rtcConfig', iceServers: iceServers() });
      send(ws, { type: 'account', user: accounts.publicUser(ws.account) });
      // Reconnect in laufenden Raum?
      const code = clientRoom.get(id);
      const room = code && rooms.get(code);
      if (room) {
        const seat = seatOf(room, id);
        if (seat) { seat.connected = true; seat.name = seat.name; }
        evaluateVote(room);
        send(ws, { type: 'joined', code: room.code, clientId: id, isHost: room.hostId === id });
        sendChatHistory(ws, room);
        broadcast(room);
      } else {
        send(ws, { type: 'ready', clientId: id });
        send(ws, { type: 'roomList', rooms: roomListView() });
      }
      return;
    }

    case 'listRooms': {
      send(ws, { type: 'roomList', rooms: roomListView() });
      return;
    }

    case 'createRoom': {
      requireId(ws);
      const mode = parseMode(m.mode);
      if (mode === 'ranked' && !accounts.enabled) throw new Error('Ranglisten-Spiele benötigen Benutzerkonten (auf diesem Server deaktiviert).');
      if (mode === 'ranked' && !ws.account) throw new Error('Für Ranglisten-Spiele bitte zuerst anmelden.');
      const name = playerName(ws, m.name);
      leaveCurrent(ws.clientId);
      const room = { code: code4(), hostId: ws.clientId, mode,
        seats: [{ id: ws.clientId, name, bot: false, connected: true, accountId: ws.account ? ws.account.id : null }], game: null, chat: [] };
      rooms.set(room.code, room);
      clientRoom.set(ws.clientId, room.code);
      send(ws, { type: 'joined', code: room.code, clientId: ws.clientId, isHost: true });
      sendChatHistory(ws, room);
      systemChat(room, `${name} hat den Raum erstellt (Modus: ${MODE_LABEL[mode]}).`);
      announceRoom(room, ws);
      broadcast(room);
      return;
    }

    case 'joinRoom': {
      requireId(ws);
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return err(ws, 'Raum nicht gefunden.');
      // Konto sitzt bereits (mit anderer Client-ID, z. B. anderes Gerät/Browser) in diesem Raum:
      // Sitz übernehmen statt zusätzlichen Platz anzulegen – auch während eines laufenden Spiels.
      if (ws.account && !seatOf(room, ws.clientId)) {
        const own = room.seats.find(s => !s.bot && s.accountId === ws.account.id);
        if (own) {
          if (clientRoom.get(ws.clientId) !== room.code) leaveCurrent(ws.clientId);
          send(ws, { type: 'adoptClientId', clientId: own.id });
          return;
        }
      }
      if (room.game) return err(ws, 'Spiel läuft bereits – kein Beitritt möglich.');
      if (isBanned(room, ws)) return err(ws, 'Du wurdest aus diesem Raum gekickt.');
      let seat = seatOf(room, ws.clientId);
      if (!seat && room.seats.length >= MAX_PLAYERS) return err(ws, `Raum ist voll (max. ${MAX_PLAYERS}).`);
      if (!seat && room.mode === 'ranked' && !ws.account) return err(ws, 'Ranglisten-Raum: Beitritt nur mit angemeldetem Konto.');
      if (clientRoom.get(ws.clientId) !== room.code) leaveCurrent(ws.clientId);
      let isNew = false;
      if (!seat) {
        const name = playerName(ws, m.name);
        if (ws.account && room.seats.some(s => s.accountId === ws.account.id)) return err(ws, 'Du sitzt mit diesem Konto bereits in diesem Raum.');
        // Namenskollision nur verhindern, wenn ein Konto beteiligt ist (Gäste dürfen wie bisher gleich heißen).
        if (room.seats.some(s => !s.bot && s.name.toLowerCase() === name.toLowerCase() && (ws.account || s.accountId))) return err(ws, `Der Name „${name}“ ist in diesem Raum schon vergeben.`);
        seat = { id: ws.clientId, name, bot: false, connected: true, accountId: ws.account ? ws.account.id : null };
        room.seats.push(seat);
        isNew = true;
      } else { seat.connected = true; }
      clientRoom.set(ws.clientId, room.code);
      send(ws, { type: 'joined', code: room.code, clientId: ws.clientId, isHost: room.hostId === ws.clientId });
      sendChatHistory(ws, room);
      if (isNew) systemChat(room, `${seat.name} ist beigetreten.`);
      if (evaluateVote(room)) return;
      broadcast(room);
      return;
    }

    case 'addBot': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Nur in der Lobby.');
      if (room.seats.length >= MAX_PLAYERS) throw new Error(`Max. ${MAX_PLAYERS} Plätze.`);
      if (room.mode === 'ranked') throw new Error('In Ranglisten-Räumen sind keine Bots erlaubt.');
      const n = room.seats.filter(s => s.bot).length + 1;
      room.seats.push({ id: `bot-${room.code}-${Date.now()}-${n}`, name: `Bot ${n}`, bot: true, connected: true });
      if (room.vote) { clearVote(room); systemChat(room, 'Abstimmung abgebrochen (Sitzordnung geändert).'); }
      broadcast(room);
      return;
    }

    case 'removeBot': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Nur in der Lobby.');
      const i = [...room.seats].reverse().findIndex(s => s.bot);
      if (i >= 0) room.seats.splice(room.seats.length - 1 - i, 1);
      if (i >= 0 && room.vote) { clearVote(room); systemChat(room, 'Abstimmung abgebrochen (Sitzordnung geändert).'); }
      broadcast(room);
      return;
    }

    case 'setMode': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Nur in der Lobby.');
      const mode = parseMode(m.mode);
      if (mode === room.mode) return;
      if (mode === 'ranked') checkRankedAllowed(room);
      room.mode = mode;
      if (room.vote) clearVote(room);
      systemChat(room, `Spielmodus geändert: ${MODE_LABEL[mode]}.`);
      if (mode === 'private') retractAnnouncement(room, 'Raum ist jetzt privat');
      announceRoom(room, ws);
      broadcast(room);
      return;
    }

    case 'startGame': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Spiel läuft bereits.');
      if (room.mode === 'ranked') checkRankedAllowed(room);
      if (room.seats.length < 2) throw new Error('Mindestens 2 Plätze nötig.');
      if (room.vote) throw new Error('Abstimmung läuft bereits.');
      // Host eröffnet die Abstimmung und stimmt selbst mit Ja.
      openVote(room, 'start');
      room.vote.votes[ws.clientId] = 'yes';
      systemChat(room, `Abstimmung zum Spielstart – ${VOTE_MS / 1000} s Zeit.`);
      if (evaluateVote(room)) return;
      broadcast(room);
      return;
    }

    case 'vote': {
      const { room, seat } = memberRoom(ws);
      if (seat.bot) return;
      if (!room.vote) throw new Error('Keine Abstimmung aktiv.');
      const choice = m.choice === 'no' ? 'no' : 'yes';
      const prev = room.vote.votes[seat.id];
      room.vote.votes[seat.id] = choice;
      if (choice === 'no' && prev !== 'no') systemChat(room, `${seat.name} hat mit Nein gestimmt – Zeit angehalten.`);
      if (evaluateVote(room)) return;
      broadcast(room);
      return;
    }

    case 'kick': {
      const { room, seat } = memberRoom(ws);
      if (room.game) throw new Error('Kicken ist nur in der Lobby möglich.');
      const targetId = String(m.targetId || '');
      const target = seatOf(room, targetId);
      if (!target) throw new Error('Spieler nicht gefunden.');
      if (target.bot) throw new Error('Bots bitte über „Bot entfernen“ entfernen.');
      if (targetId === seat.id) throw new Error('Du kannst dich nicht selbst kicken.');
      // Admin: sofort, ohne Zustimmung anderer (Rolle wird per Terminal vergeben).
      if (ws.account && admins.isAdmin(ws.account.id) && seat.accountId === ws.account.id) {
        if (room.kick && room.kick.targetId === targetId) clearKick(room);
        if (room.vote) { clearVote(room); systemChat(room, 'Abstimmung abgebrochen (Sitzordnung geändert).'); }
        kickPlayer(room, targetId, 'von einem Admin');
        return;
      }
      if (isAdminSeat(target)) throw new Error('Admins können nicht per Abstimmung gekickt werden.');
      if (room.kick) throw new Error('Es läuft bereits eine Kick-Abstimmung.');
      openKick(room, targetId, seat.id);
      systemChat(room, `${seat.name} möchte ${target.name} kicken – Abstimmung (${KICK_MS / 1000} s, mehr als 50 % Ja nötig).`);
      if (resolveKick(room)) return;
      broadcast(room);
      return;
    }

    case 'kickVote': {
      const { room, seat } = memberRoom(ws);
      const k = room.kick;
      if (!k) throw new Error('Keine Kick-Abstimmung aktiv.');
      if (seat.id === k.targetId) throw new Error('Du bist von dieser Abstimmung betroffen und nicht stimmberechtigt.');
      k.votes[seat.id] = m.choice === 'no' ? 'no' : 'yes';
      if (resolveKick(room)) return;
      broadcast(room);
      return;
    }

    case 'mute': {
      // m.action: 'mute' (Standard) | 'unmute'
      const { room, seat } = memberRoom(ws);
      const action = m.action === 'unmute' ? 'unmute' : 'mute';
      const targetId = String(m.targetId || '');
      const target = seatOf(room, targetId);
      if (!target || target.bot) throw new Error('Spieler nicht gefunden.');
      if (targetId === seat.id) throw new Error(action === 'mute' ? 'Du kannst dich nicht selbst muten.' : 'Du kannst dich nicht selbst entmuten.');
      if (isMuted(room, target) === (action === 'mute')) throw new Error(`${target.name} ist ${action === 'mute' ? 'bereits stummgeschaltet' : 'nicht stummgeschaltet'}.`);
      // Admin: sofort, ohne Abstimmung.
      if (ws.account && admins.isAdmin(ws.account.id) && seat.accountId === ws.account.id) {
        if (room.muteVote && room.muteVote.targetId === targetId) clearMuteVote(room);
        applyMute(room, target, action === 'mute', 'von einem Admin');
        return;
      }
      if (action === 'mute' && isAdminSeat(target)) throw new Error('Admins können nicht per Abstimmung gemutet werden.');
      // Nur 2 Menschen im Raum: sofort wirksam.
      if (room.seats.filter(s => !s.bot).length <= 2) {
        if (room.muteVote && room.muteVote.targetId === targetId) clearMuteVote(room);
        applyMute(room, target, action === 'mute', `von ${seat.name}`);
        return;
      }
      if (room.muteVote) throw new Error('Es läuft bereits eine Mute-Abstimmung.');
      openMuteVote(room, targetId, seat.id, action);
      systemChat(room, `${seat.name} möchte ${target.name} ${action === 'mute' ? 'stummschalten' : 'wieder freischalten'} – Abstimmung (${MUTE_MS / 1000} s, mehr als 50 % Ja nötig).`);
      if (resolveMuteVote(room)) return;
      broadcast(room);
      return;
    }

    case 'muteVote': {
      const { room, seat } = memberRoom(ws);
      const v = room.muteVote;
      if (!v) throw new Error('Keine Mute-Abstimmung aktiv.');
      if (seat.id === v.targetId) throw new Error('Du bist von dieser Abstimmung betroffen und nicht stimmberechtigt.');
      v.votes[seat.id] = m.choice === 'no' ? 'no' : 'yes';
      if (resolveMuteVote(room)) return;
      broadcast(room);
      return;
    }

    case 'bid': {
      const { room, seat } = playerRoom(ws);
      room.game.placeBid(seat.id, Number(m.n));
      broadcast(room);
      driveBots(room);
      return;
    }

    case 'play': {
      const { room, seat } = playerRoom(ws);
      room.game.playCard(seat.id, String(m.cardId));
      broadcast(room);
      driveBots(room);
      return;
    }

    case 'nextRound': {
      // Abwärtskompatibel: entspricht einer Ja-Stimme in der Rundenabstimmung.
      return handle(ws, { type: 'vote', choice: 'yes' });
    }

    case 'chat': {
      const { room, seat } = memberRoom(ws);
      if (isMuted(room, seat)) throw new Error('Du bist stummgeschaltet und kannst nicht schreiben.');
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_TEXT_MAX);
      if (!text) return;
      const msg = { name: seat.name, text, ts: Date.now() };
      pushChat(room, msg);
      broadcastChat(room, msg);
      return;
    }

    case 'voice-join': {
      const { room } = memberRoom(ws);
      (room.voice || (room.voice = new Set())).add(ws.clientId);
      broadcastVoice(room);
      return;
    }

    case 'voice-leave': {
      const { room } = memberRoom(ws);
      leaveVoice(room, ws.clientId);
      return;
    }

    case 'rtc-signal': {
      // Opake SDP/ICE-Nutzlast an genau einen Mitspieler im selben Raum weiterreichen.
      const { room } = memberRoom(ws);
      const to = String(m.to || '');
      const target = seatOf(room, to);
      if (!target || target.bot) return;
      send(sockets.get(to), { type: 'rtc-signal', from: ws.clientId, data: m.data });
      return;
    }

    case 'leaveRoom': {
      leaveCurrent(ws.clientId);
      send(ws, { type: 'left' });
      send(ws, { type: 'roomList', rooms: roomListView() });
      return;
    }

    default: return;
  }
}

// ---- Helfer ----
function noRoomError(msg) { const e = new Error(msg); e.noRoom = true; return e; }
function requireId(ws) { if (!ws.clientId) throw new Error('Kein hello gesendet.'); }
function cleanName(n) { return (String(n || '').trim().slice(0, 20)) || 'Spieler'; }
// Angemeldet: Kontoname ist fest. Gast: freier Name, aber keine registrierten Kontonamen.
function playerName(ws, n) {
  if (ws.account) return ws.account.username;
  const name = cleanName(n);
  if (accounts.enabled && accounts.isRegisteredName(name)) {
    throw new Error(`„${name}“ ist ein registrierter Benutzername – bitte anmelden oder einen anderen Namen wählen.`);
  }
  return name;
}

function hostRoom(ws) {
  requireId(ws);
  const room = rooms.get(clientRoom.get(ws.clientId));
  if (!room) throw noRoomError('Kein Raum.');
  if (room.hostId !== ws.clientId) throw new Error('Nur der Host darf das.');
  return room;
}
function playerRoom(ws) {
  requireId(ws);
  const room = rooms.get(clientRoom.get(ws.clientId));
  if (!room) throw noRoomError('Kein laufendes Spiel.');
  if (!room.game) throw new Error('Kein laufendes Spiel.');
  const seat = seatOf(room, ws.clientId);
  if (!seat) throw noRoomError('Du sitzt nicht in diesem Raum.');
  return { room, seat };
}
// Raum + Sitz, egal ob Lobby oder laufendes Spiel (für Chat).
function memberRoom(ws) {
  requireId(ws);
  const room = rooms.get(clientRoom.get(ws.clientId));
  if (!room) throw noRoomError('Kein Raum.');
  const seat = seatOf(room, ws.clientId);
  if (!seat) throw noRoomError('Du sitzt nicht in diesem Raum.');
  return { room, seat };
}
function leaveCurrent(clientId) {
  const code = clientRoom.get(clientId);
  const room = code && rooms.get(code);
  if (!room) return;
  clientRoom.delete(clientId);
  if (room.voice) room.voice.delete(clientId);
  if (room.game) {
    // während des Spiels: Sitz bleibt (Reconnect möglich), nur getrennt markieren
    const seat = seatOf(room, clientId);
    if (seat) seat.connected = false;
    // Kein Mensch mehr diesem Raum zugeordnet (z. B. alle haben das beendete Spiel verlassen):
    // Raum verwerfen, statt ihn mit veralteten Sitzen im Speicher zu lassen.
    if (!room.seats.some(s => !s.bot && isInRoom(room, s.id))) {
      retractAnnouncement(room, 'Raum geschlossen');
      discardRoom(room);
      return;
    }
    if (!evaluateVote(room)) broadcast(room);
    broadcastVoice(room);
    return;
  }
  // Lobby: Sitz entfernen
  room.seats = room.seats.filter(s => s.id !== clientId);
  if (room.vote) {
    delete room.vote.votes[clientId];
    if (room.seats.length < 2 || !room.seats.some(s => !s.bot)) clearVote(room);
  }
  if (room.hostId === clientId) {
    const nextHuman = room.seats.find(s => !s.bot);
    if (nextHuman) { room.hostId = nextHuman.id; if (!evaluateVote(room)) broadcast(room); broadcastVoice(room); }
    else closeRoom(room, 'Host hat den Raum verlassen.');
    return;
  }
  if (!evaluateVote(room)) broadcast(room);
  broadcastVoice(room);
}

server.listen(PORT, () => console.log(`Portriga läuft auf http://0.0.0.0:${PORT}`));
