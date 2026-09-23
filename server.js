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

// ---- Zentrale Konfiguration ----
// Priorität: eingebaute Defaults < config.json (in /opt/portriga) < Umgebungsvariablen.
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  }
  return out;
}
function loadConfig() {
  const defaults = {
    port: 3000,
    basePath: '',                 // Subdirectory, z.B. "/portriga"; leer = Root
    ice: { stun: 'stun:stun.l.google.com:19302', turn: null }, // turn: {url,user,pass}
    chat: { historyMax: 60, textMax: 300 },
    bots: { moveDelayMs: 700 },
    game: {
      ranks: null,     // null = eingebaute Standard-Wertigkeit (siehe game.js)
      maxPlayers: 63,  // 2–63; > 7 = alternative Variante mit reduzierter Kartenanzahl
    },
    accounts: {
      botMxid: '',          // Matrix-Bot, dem neue User ihren Code schreiben; leer = Konten aus
      publicUrl: '',        // öffentliche Basis-URL (inkl. basePath) – Pflicht für Login-Links
      dataDir: '',          // leer = <App>/data
      codeTtlMin: 15,       // Gültigkeit des Registrierungscodes
      sessionDays: 30,      // Laufzeit der Anmeldung (Cookie)
      cookieSecure: true,   // false nur für lokalen Test ohne HTTPS
    },
  };
  let file = {};
  const cfgPath = path.join(__dirname, 'config.json');
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    console.log(`Konfiguration geladen: ${cfgPath}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`config.json ignoriert (${e.message}) – nutze Defaults.`);
  }
  const cfg = deepMerge(defaults, file);
  // ENV-Overrides (höchste Priorität; gut für Secrets)
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.BASE_PATH !== undefined) cfg.basePath = process.env.BASE_PATH;
  if (process.env.STUN_URL) cfg.ice.stun = process.env.STUN_URL;
  const A = cfg.accounts;
  if (process.env.MATRIX_BOT_MXID !== undefined) A.botMxid = process.env.MATRIX_BOT_MXID;
  if (process.env.PORTRIGA_PUBLIC_URL !== undefined) A.publicUrl = process.env.PORTRIGA_PUBLIC_URL;
  if (process.env.PORTRIGA_DATA_DIR) A.dataDir = process.env.PORTRIGA_DATA_DIR;
  if (process.env.COOKIE_SECURE !== undefined) A.cookieSecure = process.env.COOKIE_SECURE !== 'false' && process.env.COOKIE_SECURE !== '0';
  if (process.env.TURN_URL) {
    cfg.ice.turn = { url: process.env.TURN_URL, user: process.env.TURN_USER || '', pass: process.env.TURN_PASS || '' };
  }
  return cfg;
}
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

// ---- Benutzerkonten (Registrierung per Matrix-DM, siehe accounts.js) ----
const AC = CONFIG.accounts || {};
const accounts = createAccounts({
  dataDir: AC.dataDir || path.join(__dirname, 'data'),
  botMxid: String(AC.botMxid || '').trim(),
  publicUrl: String(AC.publicUrl || '').trim(),
  codeTtlMs: Math.max(1, Number(AC.codeTtlMin) || 15) * 60 * 1000,
  sessionTtlMs: Math.max(1, Number(AC.sessionDays) || 30) * 24 * 3600 * 1000,
  cookieSecure: AC.cookieSecure !== false,
  basePath: BASE,
});
accounts.mount(app, express, BASE);
accounts.start();

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
  for (const s of room.seats) if (!s.bot) send(sockets.get(s.id), { type: 'chat', msg });
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
    .map(id => { const s = seatOf(room, id); return s ? { id, name: s.name } : null; })
    .filter(Boolean);
}
function broadcastVoice(room) {
  const members = voiceMembers(room);
  for (const s of room.seats) if (!s.bot) send(sockets.get(s.id), { type: 'voice', members });
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
 */
const VOTE_MS = 60000;
function voters(room) { return room.seats.filter(s => !s.bot && s.connected); }
function voteView(room) {
  const v = room.vote;
  if (!v) return null;
  const remainingMs = v.paused ? v.remainingMs : Math.max(0, v.deadline - Date.now());
  return {
    kind: v.kind, paused: v.paused, remainingMs, totalMs: VOTE_MS,
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
/* Nach jeder Stimm-/Sitzänderung: sofort starten, pausieren oder fortsetzen. */
function evaluateVote(room) {
  const v = room.vote;
  if (!v) return false;
  const vs = voters(room);
  if (vs.length > 0 && vs.every(s => v.votes[s.id] === 'yes')) {
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
    room.game = new Game(room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot })));
    room.game.start();
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

function lobbyView(room) {
  return {
    type: 'state',
    lobby: true,
    code: room.code,
    hostId: room.hostId,
    seats: room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot, connected: s.connected, verified: !!s.accountId })),
    maxPlayers: MAX_PLAYERS,
    vote: voteView(room),
  };
}

function broadcast(room) {
  syncVote(room);
  if (!room.game) {
    for (const s of room.seats) {
      if (!s.bot) send(sockets.get(s.id), { ...lobbyView(room), youId: s.id });
    }
    return;
  }
  for (const s of room.seats) {
    if (s.bot) continue;
    const ws = sockets.get(s.id);
    if (!ws) continue;
    send(ws, {
      type: 'state',
      lobby: false,
      code: room.code,
      hostId: room.hostId,
      view: room.game.viewFor(s.id),
      vote: voteView(room),
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

function seatOf(room, clientId) { return room.seats.find(s => s.id === clientId); }

function closeRoom(room, reason) {
  for (const s of room.seats) {
    if (!s.bot) {
      send(sockets.get(s.id), { type: 'roomClosed', reason });
      clientRoom.delete(s.id);
    }
  }
  clearVote(room);
  rooms.delete(room.code);
}

wss.on('connection', (ws, req) => {
  ws.clientId = null;
  // Angemeldetes Konto aus dem Session-Cookie (Handshake). Nach Login/Logout baut der
  // Client die WebSocket-Verbindung neu auf, damit der neue Zustand greift.
  ws.account = accounts.userFromReq(req);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { handle(ws, m); }
    catch (e) { err(ws, e.message || 'Fehler'); }
  });

  ws.on('close', () => {
    const id = ws.clientId;
    if (!id) return;
    if (sockets.get(id) === ws) sockets.delete(id);
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
      clearVote(room);
      rooms.delete(room.code);
      for (const s of room.seats) clientRoom.delete(s.id);
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
      }
      return;
    }

    case 'createRoom': {
      requireId(ws);
      leaveCurrent(ws.clientId);
      const name = playerName(ws, m.name);
      const room = { code: code4(), hostId: ws.clientId,
        seats: [{ id: ws.clientId, name, bot: false, connected: true, accountId: ws.account ? ws.account.id : null }], game: null, chat: [] };
      rooms.set(room.code, room);
      clientRoom.set(ws.clientId, room.code);
      send(ws, { type: 'joined', code: room.code, clientId: ws.clientId, isHost: true });
      sendChatHistory(ws, room);
      systemChat(room, `${name} hat den Raum erstellt.`);
      broadcast(room);
      return;
    }

    case 'joinRoom': {
      requireId(ws);
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return err(ws, 'Raum nicht gefunden.');
      if (room.game) return err(ws, 'Spiel läuft bereits – kein Beitritt möglich.');
      if (room.seats.length >= MAX_PLAYERS) return err(ws, `Raum ist voll (max. ${MAX_PLAYERS}).`);
      leaveCurrent(ws.clientId);
      let seat = seatOf(room, ws.clientId);
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

    case 'startGame': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Spiel läuft bereits.');
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
      return;
    }

    default: return;
  }
}

// ---- Helfer ----
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
  if (!room) throw new Error('Kein Raum.');
  if (room.hostId !== ws.clientId) throw new Error('Nur der Host darf das.');
  return room;
}
function playerRoom(ws) {
  requireId(ws);
  const room = rooms.get(clientRoom.get(ws.clientId));
  if (!room || !room.game) throw new Error('Kein laufendes Spiel.');
  const seat = seatOf(room, ws.clientId);
  if (!seat) throw new Error('Du sitzt nicht in diesem Raum.');
  return { room, seat };
}
// Raum + Sitz, egal ob Lobby oder laufendes Spiel (für Chat).
function memberRoom(ws) {
  requireId(ws);
  const room = rooms.get(clientRoom.get(ws.clientId));
  if (!room) throw new Error('Kein Raum.');
  const seat = seatOf(room, ws.clientId);
  if (!seat) throw new Error('Du sitzt nicht in diesem Raum.');
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
