'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { Game, setRanks } = require('./game');
const { botBid, botCardId } = require('./bots');

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
    game: { ranks: null }, // null = eingebaute Standard-Wertigkeit (siehe game.js)
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
  if (process.env.TURN_URL) {
    cfg.ice.turn = { url: process.env.TURN_URL, user: process.env.TURN_USER || '', pass: process.env.TURN_PASS || '' };
  }
  return cfg;
}
const CONFIG = loadConfig();
if (CONFIG.game && CONFIG.game.ranks) {
  try { setRanks(CONFIG.game.ranks); } catch (e) { console.warn('game.ranks ignoriert:', e.message); }
}
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

function lobbyView(room) {
  return {
    type: 'state',
    lobby: true,
    code: room.code,
    hostId: room.hostId,
    seats: room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot, connected: s.connected })),
  };
}

function broadcast(room) {
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
  rooms.delete(room.code);
}

wss.on('connection', (ws) => {
  ws.clientId = null;
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
    // Lobby: leert sich der Raum von Menschen -> schließen
    const humans = room.seats.filter(s => !s.bot);
    if (humans.every(s => !s.connected)) {
      // niemand mehr da: Raum verwerfen
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
      // Reconnect in laufenden Raum?
      const code = clientRoom.get(id);
      const room = code && rooms.get(code);
      if (room) {
        const seat = seatOf(room, id);
        if (seat) { seat.connected = true; seat.name = seat.name; }
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
      const name = cleanName(m.name);
      const room = { code: code4(), hostId: ws.clientId,
        seats: [{ id: ws.clientId, name, bot: false, connected: true }], game: null, chat: [] };
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
      if (room.seats.filter(s => !s.bot || true).length >= 7) return err(ws, 'Raum ist voll (max. 7).');
      leaveCurrent(ws.clientId);
      let seat = seatOf(room, ws.clientId);
      let isNew = false;
      if (!seat) {
        seat = { id: ws.clientId, name: cleanName(m.name), bot: false, connected: true };
        room.seats.push(seat);
        isNew = true;
      } else { seat.connected = true; }
      clientRoom.set(ws.clientId, room.code);
      send(ws, { type: 'joined', code: room.code, clientId: ws.clientId, isHost: room.hostId === ws.clientId });
      sendChatHistory(ws, room);
      if (isNew) systemChat(room, `${seat.name} ist beigetreten.`);
      broadcast(room);
      return;
    }

    case 'addBot': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Nur in der Lobby.');
      if (room.seats.length >= 7) throw new Error('Max. 7 Plätze.');
      const n = room.seats.filter(s => s.bot).length + 1;
      room.seats.push({ id: `bot-${room.code}-${Date.now()}-${n}`, name: `Bot ${n}`, bot: true, connected: true });
      broadcast(room);
      return;
    }

    case 'removeBot': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Nur in der Lobby.');
      const i = [...room.seats].reverse().findIndex(s => s.bot);
      if (i >= 0) room.seats.splice(room.seats.length - 1 - i, 1);
      broadcast(room);
      return;
    }

    case 'startGame': {
      const room = hostRoom(ws);
      if (room.game) throw new Error('Spiel läuft bereits.');
      if (room.seats.length < 2) throw new Error('Mindestens 2 Plätze nötig.');
      room.game = new Game(room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot })));
      room.game.start();
      systemChat(room, 'Das Spiel wurde gestartet. Viel Erfolg!');
      broadcast(room);
      driveBots(room);
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
      const { room } = playerRoom(ws);
      room.game.nextRound();
      broadcast(room);
      driveBots(room);
      return;
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
    broadcast(room);
    broadcastVoice(room);
    return;
  }
  // Lobby: Sitz entfernen
  room.seats = room.seats.filter(s => s.id !== clientId);
  if (room.hostId === clientId) {
    const nextHuman = room.seats.find(s => !s.bot);
    if (nextHuman) { room.hostId = nextHuman.id; broadcast(room); broadcastVoice(room); }
    else closeRoom(room, 'Host hat den Raum verlassen.');
    return;
  }
  broadcast(room);
  broadcastVoice(room);
}

server.listen(PORT, () => console.log(`Portriga läuft auf http://0.0.0.0:${PORT}`));
