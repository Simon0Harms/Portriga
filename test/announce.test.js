'use strict';
/* Unit- und E2E-Test der Matrix-Ankündigungen neuer öffentlicher/Ranglisten-Spiele. */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const WebSocket = require('ws');
const { createAnnouncer } = require('../announce');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readOut = dir => fs.readdirSync(dir).filter(n => n.endsWith('.json'))
  .map(n => { const f = path.join(dir, n); const j = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return j; });

// ---- Unit: Standard = Ersteller-Limit aus ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-ann-'));
  const a = createAnnouncer({ room: '#spiele:example.org', outboxDir: dir, log: () => {} });
  assert.ok(a.announce({ code: 'AAAA', mode: 'public', host: 'x', players: 1, maxPlayers: 7, creatorKey: 'k1' }));
  assert.ok(a.announce({ code: 'BBBB', mode: 'public', host: 'x', players: 1, maxPlayers: 7, creatorKey: 'k1' }), 'kein Ersteller-Limit per Standard');
  fs.rmSync(dir, { recursive: true, force: true });
}
// ---- Unit: 300 s = eine pro 5 Minuten ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-ann-'));
  let t = 1e6;
  const a = createAnnouncer({ room: '#spiele:example.org', outboxDir: dir, perCreatorSec: 300, now: () => t, log: () => {} });
  assert.ok(a.announce({ code: 'CCCC', mode: 'public', host: 'x', players: 1, maxPlayers: 7, creatorKey: 'k1' }));
  t += 299e3;
  assert.strictEqual(a.announce({ code: 'DDDD', mode: 'public', host: 'x', players: 1, maxPlayers: 7, creatorKey: 'k1' }), false);
  t += 2e3;
  assert.ok(a.announce({ code: 'DDDD', mode: 'public', host: 'x', players: 1, maxPlayers: 7, creatorKey: 'k1' }));
  fs.rmSync(dir, { recursive: true, force: true });
}
// ---- Unit ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-ann-'));
  let t = 1e6;
  const a = createAnnouncer({ room: '#spiele:example.org', outboxDir: dir, publicUrl: 'https://p.example.org/',
    perCreatorSec: 60, maxPerHour: 3, now: () => t, log: () => {} });
  assert.ok(a.enabled); assert.strictEqual(a.link, 'https://matrix.to/#/%23spiele%3Aexample.org');
  assert.strictEqual(a.announce({ code: 'ABCD', mode: 'private', host: 'x', players: 1, maxPlayers: 7 }), false);
  assert.ok(a.announce({ code: 'ABCD', mode: 'public', host: 'Ann\n@room', players: 1, maxPlayers: 7, creatorKey: 'k1' }));
  assert.strictEqual(a.announce({ code: 'EFGH', mode: 'public', host: 'x', players: 1, maxPlayers: 7, creatorKey: 'k1' }), false, 'Ersteller-Limit');
  assert.ok(a.announce({ code: 'IJKL', mode: 'ranked', host: 'y', players: 1, maxPlayers: 7, creatorKey: 'k2' }));
  assert.ok(a.announce({ code: 'MNOP', mode: 'public', host: 'z', players: 1, maxPlayers: 7, creatorKey: 'k3' }));
  assert.strictEqual(a.announce({ code: 'QRST', mode: 'public', host: 'z', players: 1, maxPlayers: 7, creatorKey: 'k4' }), false, 'Stundenlimit');
  t += 3601e3;
  assert.ok(a.announce({ code: 'QRST', mode: 'public', host: 'z', players: 1, maxPlayers: 7, creatorKey: 'k1' }));
  const jobs = readOut(dir).sort((x, y) => x.body.localeCompare(y.body));
  assert.strictEqual(jobs.length, 4);
  for (const j of jobs) { assert.strictEqual(j.announce, true); assert.strictEqual(j.roomId, '#spiele:example.org'); }
  const pub = jobs.find(j => j.body.includes('ABCD'));
  assert.ok(pub.body.includes('https://p.example.org/?join=ABCD'));
  assert.ok(!pub.body.includes('@room') && !/Ann\n/.test(pub.body), 'Name entschärft');
  assert.ok(jobs.find(j => j.body.includes('IJKL')).body.startsWith('🏅 Neues Ranglisten-Spiel'));
  // Rückzug: Auftrag mit Referenz auf die Ankündigungs-ID
  const ref = jobs[0].id;
  assert.ok(a.retract(ref, 'Spiel gestartet'));
  assert.strictEqual(a.retract(''), false);
  assert.strictEqual(a.retract(true), false);
  const rj = readOut(dir).filter(j => j.retract);
  assert.strictEqual(rj.length, 1);
  assert.strictEqual(rj[0].retract, ref);
  assert.strictEqual(rj[0].roomId, '#spiele:example.org');
  assert.ok(!rj[0].announce && !rj[0].body);
  assert.strictEqual(createAnnouncer({ room: 'kaputt', outboxDir: dir, log: () => {} }).enabled, false);
  assert.strictEqual(createAnnouncer({ room: '', outboxDir: dir }).enabled, false);
  console.log('announce unit: ok');
}

// ---- E2E über server.js ----
(async () => {
  const PORT = 3990 + Math.floor(Math.random() * 9);
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-ann-e2e-'));
  const OUT = path.join(DATA, 'matrix-outbox');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PORTRIGA_DATA_DIR: DATA,
      PORTRIGA_ANNOUNCE_ROOM: '!abc:example.org', PORTRIGA_PUBLIC_URL: 'https://spiel.example.org',
      MATRIX_BOT_MXID: '' }), stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch (_) { await sleep(100); } }
    const info = await (await fetch(`http://127.0.0.1:${PORT}/api/announce`)).json();
    assert.deepStrictEqual(info, { enabled: true, room: '!abc:example.org', link: 'https://matrix.to/#/!abc%3Aexample.org' });
    const client = (headers) => new Promise(res => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers }); const q = [];
      ws.on('message', d => q.push(JSON.parse(d))); ws.on('open', () => res({ ws, q, send: m => ws.send(JSON.stringify(m)) })); });
    const c = await client();
    c.send({ type: 'hello', clientId: 'ann-test-1' }); await sleep(200);
    c.send({ type: 'createRoom', name: 'Tester', mode: 'private' }); await sleep(200);
    assert.strictEqual(readOut(OUT).length, 0, 'privat -> keine Ankündigung');
    c.send({ type: 'setMode', mode: 'public' }); await sleep(200);
    let jobs = readOut(OUT);
    assert.strictEqual(jobs.length, 1); assert.strictEqual(jobs[0].roomId, '!abc:example.org');
    assert.ok(/Raum [A-Z0-9]{4}/.test(jobs[0].body) && jobs[0].body.includes('?join='));
    const annId = jobs[0].id;
    c.send({ type: 'setMode', mode: 'private' }); await sleep(200);
    jobs = readOut(OUT);
    assert.strictEqual(jobs.length, 1, 'wieder privat -> Ankündigung zurückziehen');
    assert.strictEqual(jobs[0].retract, annId);
    c.send({ type: 'setMode', mode: 'public' }); await sleep(200);
    assert.strictEqual(readOut(OUT).length, 0, 'Raum nur einmal ankündigen');
    c.ws.close();
    // Anderer Ersteller (eigene IP wegen Ersteller-Limit): Spielstart -> Ankündigung zurückziehen
    const d = await client({ 'X-Forwarded-For': '192.0.2.7' });
    d.send({ type: 'hello', clientId: 'ann-test-2' }); await sleep(200);
    d.send({ type: 'createRoom', name: 'Starter', mode: 'public' }); await sleep(200);
    jobs = readOut(OUT);
    assert.strictEqual(jobs.length, 1); const annId2 = jobs[0].id;
    d.send({ type: 'addBot' }); await sleep(100);
    d.send({ type: 'startGame' }); await sleep(300);
    jobs = readOut(OUT);
    assert.strictEqual(jobs.length, 1, 'Spielstart -> Rückzug');
    assert.strictEqual(jobs[0].retract, annId2);
    d.ws.close();
    console.log('announce e2e: ok');
  } finally { srv.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
