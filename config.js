'use strict';
const path = require('path');
const fs = require('fs');

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
function loadConfig(opts = {}) {
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
    announce: {
      room: '',             // Matrix-Raum (!id:server oder #alias:server) für neue öffentliche/Ranglisten-Spiele; leer = aus
      link: '',             // Link für die Werbung in der App; leer = https://matrix.to/#/<room>
      perCreatorSec: 0,     // max. eine Ankündigung je Ersteller (Konto/IP) in diesem Zeitraum (s); 0 = aus
      maxPerHour: 30,       // globales Limit pro Stunde
    },
  };
  let file = {};
  const cfgPath = path.join(__dirname, 'config.json');
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!opts.quiet) console.log(`Konfiguration geladen: ${cfgPath}`);
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
  if (process.env.PORTRIGA_ANNOUNCE_ROOM !== undefined) cfg.announce.room = process.env.PORTRIGA_ANNOUNCE_ROOM;
  if (process.env.PORTRIGA_ANNOUNCE_LINK !== undefined) cfg.announce.link = process.env.PORTRIGA_ANNOUNCE_LINK;
  if (process.env.TURN_URL) {
    cfg.ice.turn = { url: process.env.TURN_URL, user: process.env.TURN_USER || '', pass: process.env.TURN_PASS || '' };
  }
  return cfg;
}
// Datenverzeichnis (Konten, Rangliste, Admins) – gemeinsam für Server und admin-cli.js.
function dataDirOf(cfg) {
  return (cfg.accounts && cfg.accounts.dataDir) || path.join(__dirname, 'data');
}

module.exports = { loadConfig, dataDirOf, deepMerge };
