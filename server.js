'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const { botBid, botCardId } = require('./bots');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
function driveBots(room) {
  const g = room.game;
  if (!g) return;
  if (g.phase !== 'bidding' && g.phase !== 'playing') return;
  const seat = room.seats[g.turnIdx];
  if (!seat || !seat.bot) return;
  setTimeout(() => {
    try {
      if (g.phase === 'bidding') g.placeBid(seat.id, botBid(g, g.turnIdx));
      else if (g.phase === 'playing') g.playCard(seat.id, botCardId(g, seat.id));
    } catch (e) { /* Zustand hat sich geändert – ignorieren */ }
    broadcast(room);
    driveBots(room);
  }, 700);
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
    // Lobby: leert sich der Raum von Menschen -> schließen
    const humans = room.seats.filter(s => !s.bot);
    if (humans.every(s => !s.connected)) {
      // niemand mehr da: Raum verwerfen
      rooms.delete(room.code);
      for (const s of room.seats) clientRoom.delete(s.id);
      return;
    }
    broadcast(room);
  });
});

function handle(ws, m) {
  switch (m.type) {
    case 'hello': {
      const id = String(m.clientId || '').slice(0, 40);
      if (!id) return err(ws, 'Ungültige Client-ID.');
      ws.clientId = id;
      sockets.set(id, ws);
      // Reconnect in laufenden Raum?
      const code = clientRoom.get(id);
      const room = code && rooms.get(code);
      if (room) {
        const seat = seatOf(room, id);
        if (seat) { seat.connected = true; seat.name = seat.name; }
        send(ws, { type: 'joined', code: room.code, clientId: id, isHost: room.hostId === id });
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
        seats: [{ id: ws.clientId, name, bot: false, connected: true }], game: null };
      rooms.set(room.code, room);
      clientRoom.set(ws.clientId, room.code);
      send(ws, { type: 'joined', code: room.code, clientId: ws.clientId, isHost: true });
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
      if (!seat) {
        seat = { id: ws.clientId, name: cleanName(m.name), bot: false, connected: true };
        room.seats.push(seat);
      } else { seat.connected = true; }
      clientRoom.set(ws.clientId, room.code);
      send(ws, { type: 'joined', code: room.code, clientId: ws.clientId, isHost: room.hostId === ws.clientId });
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
function leaveCurrent(clientId) {
  const code = clientRoom.get(clientId);
  const room = code && rooms.get(code);
  if (!room) return;
  clientRoom.delete(clientId);
  if (room.game) {
    // während des Spiels: Sitz bleibt (Reconnect möglich), nur getrennt markieren
    const seat = seatOf(room, clientId);
    if (seat) seat.connected = false;
    broadcast(room);
    return;
  }
  // Lobby: Sitz entfernen
  room.seats = room.seats.filter(s => s.id !== clientId);
  if (room.hostId === clientId) {
    const nextHuman = room.seats.find(s => !s.bot);
    if (nextHuman) { room.hostId = nextHuman.id; broadcast(room); }
    else closeRoom(room, 'Host hat den Raum verlassen.');
    return;
  }
  broadcast(room);
}

server.listen(PORT, () => console.log(`Portriga läuft auf http://0.0.0.0:${PORT}`));
