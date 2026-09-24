'use strict';
/* End-to-End-Test der Konto-Registrierung (ohne echten Matrix-Server):
 * startet server.js, simuliert den Sidecar über die Inbox-/Outbox-Spools. */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'portriga-acc-'));
const BOT = '@portrigabot:example.org';
const URL0 = `http://127.0.0.1:${PORT}`;
const INBOX = path.join(DATA, 'matrix-inbox'), OUTBOX = path.join(DATA, 'matrix-outbox');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cookie = '';
async function req(p, body, useCookie = true) {
  const r = await fetch(URL0 + '/api/account' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, useCookie && cookie ? { Cookie: cookie } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie'); if (sc && useCookie) cookie = sc.split(';')[0];
  return { status: r.status, json: await r.json() };
}
function dm(sender, body, roomId = '!dm1:example.org') {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  fs.writeFileSync(path.join(INBOX, id + '.json'), JSON.stringify({ eventId: '$' + id, roomId, sender, body, ts: Date.now() }));
}
function outbox() {
  return fs.readdirSync(OUTBOX).filter(n => n.endsWith('.json')).map(n => { const f = path.join(OUTBOX, n); const j = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return j; });
}
function wsSession(withCookie) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: withCookie && cookie ? { Cookie: cookie } : {} });
    const msgs = []; ws.on('message', d => msgs.push(JSON.parse(d)));
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', clientId: 'c-' + Math.random() })); res({ ws, msgs }); });
    ws.on('error', rej);
  });
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, {
    PORT: String(PORT), PORTRIGA_DATA_DIR: DATA, MATRIX_BOT_MXID: BOT, PORTRIGA_PUBLIC_URL: 'https://spiel.example.org', COOKIE_SECURE: '0' }), stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; srv.stdout.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 50 && !out.includes('läuft'); i++) await sleep(100);

    let r = await req('/config'); assert.strictEqual(r.json.enabled, true); assert.strictEqual(r.json.matrixLogin, true);
    r = await req('/register/check?u=ab'); assert.strictEqual(r.json.available, false);
    r = await req('/register/check?u=Bot'); assert.strictEqual(r.json.available, false);
    r = await req('/register/check?u=Simon'); assert.strictEqual(r.json.available, true);

    r = await req('/register/start', { username: 'Simon', password: 'kurz' }); assert.strictEqual(r.status, 422);
    r = await req('/register/start', { username: 'Simon', password: 'geheim123' }); assert.strictEqual(r.status, 200);
    const { token, code } = r.json; assert.match(code, /^PR-[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.strictEqual(r.json.botMxid, BOT);
    // Name ist während der Registrierung reserviert
    r = await req('/register/check?u=simon'); assert.strictEqual(r.json.available, false);
    r = await req('/register/status?token=' + token); assert.strictEqual(r.json.status, 'pending');

    // falscher Code -> Hinweis per DM
    dm('@simon:example.org', 'PR-AAAA-BBBB'); await sleep(2600);
    assert.ok(outbox().some(m => /unbekannt/.test(m.body)));
    // eigener Bot wird ignoriert
    dm(BOT, code); await sleep(2600);
    r = await req('/register/status?token=' + token); assert.strictEqual(r.json.status, 'pending');
    // richtiger Code (Kleinschreibung, ohne Bindestriche, mit Text drumherum)
    dm('@simon:example.org', 'hallo ' + code.replace(/-/g, '').toLowerCase() + ' danke'); await sleep(2600);
    const welcome = outbox(); assert.ok(welcome.some(m => /Willkommen, Simon/.test(m.body) && m.roomId === '!dm1:example.org'));

    cookie = '';
    r = await req('/register/status?token=' + token); assert.strictEqual(r.json.status, 'done'); assert.ok(cookie, 'Session-Cookie gesetzt');
    assert.strictEqual(r.json.user.mxid, '@simon:example.org'); assert.strictEqual(r.json.user.hasPassword, true);
    r = await req('/me'); assert.strictEqual(r.json.user.username, 'Simon');

    // WebSocket mit Konto: Name aus dem Konto, Sitz verifiziert
    const a = await wsSession(true); await sleep(200);
    assert.ok(a.msgs.some(m => m.type === 'account' && m.user && m.user.username === 'Simon'));
    a.ws.send(JSON.stringify({ type: 'createRoom', name: 'Fake' })); await sleep(300);
    const st = a.msgs.filter(m => m.type === 'state').pop();
    assert.strictEqual(st.seats[0].name, 'Simon'); assert.strictEqual(st.seats[0].verified, true);
    // Gast darf den registrierten Namen nicht nutzen
    const g = await wsSession(false); await sleep(150);
    g.ws.send(JSON.stringify({ type: 'joinRoom', code: st.code, name: 'simon' })); await sleep(300);
    assert.ok(g.msgs.some(m => m.type === 'error' && /registrierter Benutzername/.test(m.message)));
    g.ws.send(JSON.stringify({ type: 'joinRoom', code: st.code, name: 'Gast' })); await sleep(300);
    assert.ok(g.msgs.some(m => m.type === 'joined'));
    a.ws.close(); g.ws.close();

    // zweite Registrierung mit derselben MXID -> abgelehnt
    const saved = cookie; cookie = '';
    await sleep(5100); r = await req('/register/start', { username: 'Zweitkonto' });
    const t2 = r.json.token; dm('@simon:example.org', r.json.code); await sleep(2600);
    r = await req('/register/status?token=' + t2); assert.strictEqual(r.json.status, 'failed'); outbox();

    // Passwort-Login mit Name und mit MXID, falsches Passwort
    r = await req('/login', { login: 'simon', password: 'falsch123' }); assert.strictEqual(r.status, 401);
    r = await req('/login', { login: '@simon:example.org', password: 'geheim123' }); assert.strictEqual(r.status, 200);

    // Login-Link per Matrix anfordern -> Outbox -> einlösen
    cookie = '';
    r = await req('/login/matrix', { login: 'Simon' }); assert.strictEqual(r.json.sent, true);
    await sleep(3100); r = await req('/login/matrix', { login: 'gibtsnicht' }); assert.strictEqual(r.json.sent, true); // generisch
    const ob = outbox(); assert.strictEqual(ob.length, 1);
    const tok = ob[0].body.match(/mlogin=([\w-]+)/)[1]; assert.ok(ob[0].body.includes('https://spiel.example.org/?mlogin='));
    r = await req('/login/matrix/redeem', { token: tok }); assert.strictEqual(r.status, 200);
    r = await req('/login/matrix/redeem', { token: tok }); assert.strictEqual(r.status, 404); // einmalig

    // „login"-Befehl per DM (Rate-Limit 30 s gilt je Konto -> Zeitstempel ist noch frisch, daher kein Link)
    dm('@fremd:example.org', 'login'); await sleep(2600);
    assert.ok(outbox().some(m => /kein Konto/.test(m.body)));

    // Passwort entfernen, Logout-all invalidiert Cookie
    cookie = saved;
    r = await req('/me/password', { currentPassword: 'geheim123', newPassword: '' }); assert.strictEqual(r.json.user.hasPassword, false);
    r = await req('/login', { login: 'Simon', password: '' }); assert.strictEqual(r.status, 401);
    const before = cookie;
    r = await req('/me/logout-all', {}); cookie = before;
    r = await req('/me'); assert.strictEqual(r.json.user, null);

    // Konto löschen: Bestätigung per Matrix nötig, danach verlässt der Bot den Raum
    cookie = ''; await sleep(5100);
    r = await req('/register/start', { username: 'Loeschkandidat', password: 'geheim456' }); assert.strictEqual(r.status, 200);
    const t3 = r.json.token; dm('@del:example.org', r.json.code, '!dm2:example.org'); await sleep(2600); outbox();
    r = await req('/register/status?token=' + t3); assert.strictEqual(r.json.status, 'done');
    r = await req('/me/delete', { password: 'falsch999' }); assert.strictEqual(r.status, 401);
    const d = await wsSession(true); await sleep(200);
    r = await req('/me/delete', { password: 'geheim456' }); assert.strictEqual(r.json.confirm, 'matrix'); assert.match(r.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const delTok = r.json.token, delCode = r.json.code;
    assert.ok(outbox().some(m => m.body.includes('löschen ' + delCode) && m.roomId === '!dm2:example.org' && !m.leave));
    r = await req('/me/delete/status?token=' + delTok); assert.strictEqual(r.json.status, 'pending');
    // fremde MXID kann nicht bestätigen, falscher Code löscht nicht
    dm('@fremd:example.org', 'löschen ' + delCode); await sleep(2600); outbox();
    dm('@del:example.org', 'löschen AAAA-BBBB', '!dm2:example.org'); await sleep(2600);
    assert.ok(outbox().some(m => /stimmt nicht/.test(m.body)));
    r = await req('/me'); assert.strictEqual(r.json.user.username, 'Loeschkandidat');
    // richtiger Code von der verknüpften MXID
    await sleep(3100); dm('@del:example.org', 'Loeschen ' + delCode.toLowerCase(), '!dm2:example.org'); await sleep(2600);
    const bye = outbox(); assert.ok(bye.some(m => /gelöscht/.test(m.body) && m.leave === true && m.roomId === '!dm2:example.org'));
    assert.ok(d.msgs.some(m => m.type === 'account' && m.user === null), 'WebSocket abgemeldet'); d.ws.close();
    r = await req('/me/delete/status?token=' + delTok); assert.strictEqual(r.json.status, 'deleted');
    r = await req('/me'); assert.strictEqual(r.json.user, null);
    r = await req('/register/check?u=Loeschkandidat'); assert.strictEqual(r.json.available, true);
    r = await req('/login', { login: '@del:example.org', password: 'geheim456' }); assert.strictEqual(r.status, 401);

    // Fremder Origin blockiert
    const x = await fetch(URL0 + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.strictEqual(x.status, 403);

    console.log('Konto-Tests: alle bestanden ✓');
  } catch (e) { console.error('FEHLER:', e); process.exitCode = 1; }
  finally { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
})();
