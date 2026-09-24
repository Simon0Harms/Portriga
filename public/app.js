'use strict';
const SUIT = {
  kreuz:{sym:'♣',color:'black'}, pik:{sym:'♠',color:'black'},
  herz:{sym:'♥',color:'red'},   karo:{sym:'♦',color:'red'},
};
const $ = id => document.getElementById(id);

// persistente Client-ID für Reconnect
let clientId = localStorage.getItem('portriga_cid');
if (!clientId) { clientId = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('portriga_cid', clientId); }
let myName = localStorage.getItem('portriga_name') || '';
if (myName) $('name').value = myName;

// Direktlink: ?join=CODE -> Code vorbelegen und (bei bekanntem Namen) automatisch beitreten
const joinParam = (new URLSearchParams(location.search).get('join') || '').trim().toUpperCase();
if (/^[A-Z0-9]{4}$/.test(joinParam)) {
  $('join-code').value = joinParam;
  history.replaceState(null, '', location.pathname + location.hash);
}

let ws, wsReady = false, lastState = null, myId = clientId, hostId = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Basis-Pfad wird vom Server in die Seite injiziert (window.__BASE__),
  // damit der WebSocket auch im Subdirectory-Betrieb (/portriga) korrekt verbindet.
  const base = (typeof window.__BASE__ === 'string') ? window.__BASE__ : '';
  const url = `${proto}://${location.host}${base}/`;
  console.log('[Portriga] WebSocket verbinde:', url);
  ws = new WebSocket(url);
  ws.onopen = () => {
    wsReady = true;
    console.log('[Portriga] WebSocket verbunden');
    sendRaw({ type:'hello', clientId, name: myName || 'Spieler' });
    flushOutbox();               // gepufferte Aktionen jetzt senden
  };
  ws.onerror = (e) => { console.error('[Portriga] WebSocket-Fehler', e); };
  ws.onclose = (e) => {
    wsReady = false;
    console.warn('[Portriga] WebSocket geschlossen', e && e.code, e && e.reason);
    setTimeout(connect, 1200);
  };
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
}
function sendRaw(m){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
// Aktionen, die vor dem Verbindungsaufbau ausgelöst werden, puffern statt verwerfen.
let outbox = [];
function flushOutbox(){
  const pending = outbox; outbox = [];
  for (const m of pending) sendRaw(m);
}
function send(m){
  if (ws && ws.readyState === 1){ sendRaw(m); return; }
  // Verbindung noch nicht offen -> puffern. Lobby-Aktionen nicht doppeln.
  if (m.type === 'createRoom' || m.type === 'joinRoom'){
    outbox = outbox.filter(x => x.type !== 'createRoom' && x.type !== 'joinRoom');
  }
  outbox.push(m);
  toast('Verbinde… die Aktion wird gleich ausgeführt.');
}

function onMessage(m){
  switch(m.type){
    case 'ready': break;
    case 'roomList': renderRoomList(m.rooms || []); break;
    case 'account': setAccount(m.user || null); break;
    case 'joined':
      hostId = null; enterRoomUI(); show('lobby'); break;
    case 'state':
      if (m.hostId) hostId = m.hostId;
      enterRoomUI();
      if (m.lobby) renderLobby(m); else { lastState = m; renderGame(m); }
      renderVote(m.lobby ? 'lobby-vote' : 'ov-vote', m.vote || null);
      if (m.lobby) $('btn-start').disabled = !!m.vote;
      renderKick(m.lobby ? (m.kick || null) : null);
      renderMute(m.mute || null);
      break;
    case 'rtcConfig': if (m.iceServers) rtcConfig = { iceServers: m.iceServers }; break;
    case 'voice': onVoiceMembers(m.members || []); break;
    case 'rtc-signal': onSignal(m.from, m.data); break;
    case 'chatHistory': renderChatHistory(m.messages || []); break;
    case 'chat': addChatMsg(m.msg); break;
    case 'toast': toast(m.message); break;
    case 'error': toast('⚠ ' + m.message); break;
    case 'roomClosed': toast(m.reason || 'Raum geschlossen'); exitRoomUI(); leaveChatUI(); show('home'); break;
    case 'kicked': toast('⚠ ' + (m.reason || 'Du wurdest aus dem Raum entfernt.')); exitRoomUI(); leaveChatUI(); show('home'); break;
    case 'left': exitRoomUI(); leaveChatUI(); show('home'); break;
  }
}

// ---------- Screens ----------
function show(name){
  for (const s of ['home','lobby','game']) $('screen-'+s).classList.toggle('hidden', s!==name);
}

// ---------- Home ----------
const MODE_LABEL = { private:'🔒 Privat', public:'🌐 Öffentlich', ranked:'🏅 Rangliste' };
$('btn-create').onclick = () => {
  saveName();
  const mode = $('create-mode').value;
  if (mode === 'ranked' && !account) return openGuestRanked();
  send({ type:'createRoom', name: myName, mode });
};
function renderRoomList(list){
  const ul = $('room-list'); ul.innerHTML = '';
  $('room-list-empty').classList.toggle('hidden', list.length > 0);
  for (const r of list){
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.textContent = `${r.code} · ${r.host} · ${r.players}/${r.maxPlayers}`;
    li.appendChild(nm);
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = MODE_LABEL[r.mode] || r.mode; li.appendChild(tag);
    const b = document.createElement('button'); b.textContent = 'Beitreten';
    if (r.mode === 'ranked' && !account){ b.title = 'Nur mit angemeldetem Konto'; b.onclick = () => openGuestRanked(); }
    else b.onclick = () => { saveName(); send({ type:'joinRoom', code: r.code, name: myName }); };
    li.appendChild(b);
    ul.appendChild(li);
  }
}
async function loadRanking(){
  const base = (typeof window.__BASE__ === 'string') ? window.__BASE__ : '';
  try {
    const res = await fetch(`${base}/api/ranking`, { cache:'no-store' });
    const d = await res.json();
    const tb = $('ranking-table').querySelector('tbody'); tb.innerHTML = '';
    (d.players || []).forEach((p, i) => {
      const tr = document.createElement('tr');
      for (const v of [i+1, p.username, p.rating ?? 0, p.wins, p.games, p.avg, p.best ?? '–']){
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      tb.appendChild(tr);
    });
    $('ranking-empty').classList.toggle('hidden', (d.players || []).length > 0);
  } catch (e) { toast('Rangliste konnte nicht geladen werden.'); }
}
$('btn-ranking').onclick = () => {
  const box = $('ranking-box');
  const open = box.classList.toggle('hidden') === false;
  $('btn-ranking').textContent = open ? '🏅 Rangliste ausblenden' : '🏅 Rangliste anzeigen';
  if (open) loadRanking();
};
$('btn-join').onclick = () => {
  saveName();
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Bitte 4-stelligen Code eingeben.');
  send({ type:'joinRoom', code, name: myName });
};
if (/^[A-Z0-9]{4}$/.test(joinParam)) {
  if (myName) send({ type:'joinRoom', code: joinParam, name: myName });
  else { $('name').focus(); toast('Namen eingeben und „Beitreten“ drücken.'); }
}
function saveName(){ if (account) { myName = account.username; return; } myName = ($('name').value.trim() || 'Spieler').slice(0,20); localStorage.setItem('portriga_name', myName); }

// ---------- Lobby ----------
function renderLobby(m){
  show('lobby');
  $('lobby-code').textContent = m.code;
  const link = joinLink(m.code);
  if ($('lobby-link').href !== link) {
    $('lobby-link').href = link;
    $('lobby-link').textContent = link;
    const base = (typeof window.__BASE__ === 'string') ? window.__BASE__ : '';
    $('lobby-qr').src = `${base}/qr.svg?t=${encodeURIComponent(link)}`;
  }
  const isHost = m.hostId === clientId;
  $('host-controls').classList.toggle('hidden', !isHost);
  const mode = m.mode || 'private';
  $('lobby-mode').textContent = MODE_LABEL[mode] || mode;
  $('lobby-mode-label').classList.toggle('hidden', !isHost);
  $('lobby-mode-select').value = mode;
  $('btn-addbot').classList.toggle('hidden', mode === 'ranked');
  $('btn-rmbot').classList.toggle('hidden', mode === 'ranked');
  const ul = $('seat-list'); ul.innerHTML = '';
  const iAmAdmin = !!(m.seats.find(x => x.id===clientId) || {}).admin;
  m.seats.forEach(s => {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot' + (s.connected?'':' off');
    li.appendChild(dot);
    const nm = document.createElement('span'); nm.textContent = s.name + (s.id===clientId?' (du)':''); li.appendChild(nm);
    if (s.verified){ const v=document.createElement('span'); v.className='verified'; v.title='registriertes Konto (Matrix-verifiziert)'; v.textContent='✓'; li.appendChild(v); }
    if (s.bot) { const b=document.createElement('span'); b.className='tag bot'; b.textContent='Bot'; li.appendChild(b); }
    if (s.id===m.hostId){ const h=document.createElement('span'); h.className='tag'; h.textContent='Host'; li.appendChild(h); }
    if (s.admin){ const a=document.createElement('span'); a.className='tag admin'; a.textContent='Admin'; li.appendChild(a); }
    if (!s.bot && s.id!==clientId && (iAmAdmin || (!m.kick && !s.admin))){
      const k=document.createElement('button'); k.className='kick-btn';
      k.textContent = iAmAdmin ? 'Kicken' : 'Votekick';
      k.title = iAmAdmin ? 'Sofort aus dem Raum entfernen (Admin)' : 'Abstimmung zum Kicken starten (mehr als 50 % Ja nötig)';
      k.onclick = () => {
        if (iAmAdmin && !confirm(`${s.name} wirklich aus dem Raum entfernen?`)) return;
        send({ type:'kick', targetId: s.id });
      };
      li.appendChild(k);
    }
    ul.appendChild(li);
  });
  $('lobby-hint').textContent = isHost
    ? (m.seats.length<2 ? `Warte auf Mitspieler oder füge Bots hinzu (2–${m.maxPlayers||7}).`
       : m.seats.length>7 ? `Bereit – ${m.seats.length} Spieler: alternative Variante (max. ${Math.min(8,Math.floor(63/m.seats.length))} Karten pro Runde).`
       : 'Bereit – du kannst starten.')
    : 'Warte auf den Host…';
}
$('lobby-mode-select').onchange = (e) => send({ type:'setMode', mode: e.target.value });
$('btn-addbot').onclick = () => send({ type:'addBot' });
$('btn-rmbot').onclick = () => send({ type:'removeBot' });
$('btn-start').onclick = () => send({ type:'startGame' });
$('btn-leave-lobby').onclick = () => send({ type:'leaveRoom' });
function joinLink(code){
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
}
$('btn-copy-link').onclick = () => { navigator.clipboard?.writeText($('lobby-link').href); toast('Link kopiert.'); };
$('btn-copy').onclick = () => { navigator.clipboard?.writeText($('lobby-code').textContent); toast('Code kopiert.'); };

// ---------- Game ----------
function cardEl(card, opts={}){
  const el = document.createElement('div');
  el.className = 'card ' + (SUIT[card.suit].color==='red'?'red':'');
  if (opts.win) el.classList.add('win');
  el.innerHTML = `<div class="r">${card.rank}</div><div class="s">${SUIT[card.suit].sym}</div>`;
  if (opts.who!=null){ const w=document.createElement('div'); w.className='who'; w.textContent=opts.who; el.appendChild(w); }
  return el;
}

function renderGame(m){
  show('game');
  const v = m.view;
  const players = v.players;
  const me = v.meIdx;

  $('round-num').textContent = v.roundNumber;
  $('round-total').textContent = v.totalRounds;
  $('cards-count').textContent = v.cardsThisRound;
  $('tricks-progress').textContent = `${v.tricksPlayed}/${v.tricksTotal}`;
  const t = $('trump');
  if (v.trumpSuit){ t.textContent = SUIT[v.trumpSuit].sym + ' ' + v.trumpSuit; t.className = 'trump ' + SUIT[v.trumpSuit].color; }
  else { t.textContent='—'; t.className='trump'; }

  // Gegner (alle außer mir), in Sitzreihenfolge ab mir+1
  const opp = $('opponents'); opp.innerHTML='';
  for (let k=1;k<players.length;k++){
    const p = players[(me+k)%players.length];
    const d = document.createElement('div');
    d.className = 'opp' + (p.isTurn?' turn':'');
    let badges = '';
    if (p.isDealer) badges += '<span class="badge d">Geber</span>';
    const bidTxt = p.bid==null ? '–' : p.bid;
    d.innerHTML = `<div class="nm">${escapeHtml(p.name)}${p.bot?' 🤖':''}${badges}</div>
      <div class="bt">Ansage ${bidTxt} · Stiche ${p.tricks}</div>
      <div class="bt">Punkte ${p.score}</div>`;
    const cards = document.createElement('div'); cards.className='cards';
    for (let i=0;i<p.handCount;i++){ const mc=document.createElement('div'); mc.className='mini-card'; cards.appendChild(mc); }
    d.appendChild(cards);
    opp.appendChild(d);
  }

  // aktueller Stich bzw. – für 5 s nach Abschluss – der gerade beendete Stich.
  // Nach dem letzten Stich einer Runde bleibt er sichtbar, bis 'Nächste Runde' geklickt wurde.
  renderLastTrick(v, players);
  const tc = $('trick-cards'); tc.innerHTML='';
  const lt = $('last-trick');
  const roundOver = v.phase==='roundEnd' || v.phase==='gameEnd';
  if (v.currentTrick.length===0 && v.lastTrick && (roundOver || Date.now() < lastTrickUntil)){
    v.lastTrick.cards.forEach(pl => {
      tc.appendChild(cardEl(pl.card, { who: players[pl.playerIdx].name, win: pl.playerIdx===v.lastTrick.winnerIdx }));
    });
    lt.textContent = `Stich geht an ${players[v.lastTrick.winnerIdx].name}`;
  } else {
    v.currentTrick.forEach(pl => {
      tc.appendChild(cardEl(pl.card, { who: players[pl.playerIdx].name }));
    });
    lt.textContent = '';
  }

  // Zug-Banner
  const banner = $('turn-banner');
  const meP = players[me];
  if (v.phase==='bidding'){
    banner.textContent = v.turnIdx===me ? 'Du bist dran: Stiche ansagen' : `${players[v.turnIdx].name} sagt an…`;
  } else if (v.phase==='playing'){
    banner.textContent = v.turnIdx===me ? 'Du bist dran: Karte spielen' : `${players[v.turnIdx].name} ist am Zug…`;
  } else banner.textContent='';
  ttsOnTurn(v, me);

  // Ansage-Buttons
  const bidding = $('bidding'), bb = $('bid-buttons');
  if (v.phase==='bidding' && v.turnIdx===me){
    bidding.classList.remove('hidden'); bb.innerHTML='';
    for (let n=0;n<=v.cardsThisRound;n++){
      const b=document.createElement('button'); b.textContent=n;
      b.onclick=()=>send({type:'bid',n}); bb.appendChild(b);
    }
  } else bidding.classList.add('hidden');

  // meine Hand
  const meta = $('my-meta');
  meta.innerHTML = `<b>${escapeHtml(meP.name)}</b> · Ansage ${meP.bid==null?'–':meP.bid} · Stiche ${meP.tricks} · Punkte ${meP.score}` +
    (meP.isDealer?' <span class="badge d">Geber</span>':'');
  const hand = $('myhand'); hand.innerHTML='';
  const legal = new Set(v.myLegal||[]);
  const myTurnPlaying = v.phase==='playing' && v.turnIdx===me;
  v.myHand.forEach(c => {
    const el = cardEl(c);
    if (myTurnPlaying){
      if (legal.has(c.id)){ el.classList.add('playable'); el.onclick=()=>send({type:'play',cardId:c.id}); }
      else el.classList.add('illegal');
    }
    hand.appendChild(el);
  });

  // Overlay Runden-/Spielende
  const ov = $('overlay');
  if (v.phase==='roundEnd' || v.phase==='gameEnd'){
    ov.classList.remove('hidden');
    $('ov-title').textContent = v.phase==='gameEnd' ? '🏆 Spielende' : `Runde ${v.roundNumber} beendet`;
    const sc = $('ov-scores'); sc.innerHTML='';
    const sorted = players.slice().sort((a,b)=>b.score-a.score);
    sorted.forEach((p,i)=>{
      const li=document.createElement('li'); if(i===0) li.className='lead';
      li.innerHTML=`<span>${i+1}. ${escapeHtml(p.name)}${p.bot?' 🤖':''} <span class="hint">(Ansage ${p.bid==null?'–':p.bid}, ${p.tricks} Stiche)</span></span><span class="sc">${p.lastDelta==null?'':`<span class="delta ${p.lastDelta>=0?'pos':'neg'}">${p.lastDelta>0?'+':''}${p.lastDelta}</span> `}${p.score}</span>`;
      sc.appendChild(li);
    });
    $('ov-home').classList.toggle('hidden', v.phase!=='gameEnd');
  } else ov.classList.add('hidden');
}
// ---------- Letzter Stich (Issue #1) ----------
const LAST_TRICK_SHOW_MS = 5000;
let lastTrickKey = null, lastTrickUntil = 0, lastTrickTimer = null;

function renderLastTrick(v, players){
  const key = v.lastTrick ? `${v.roundIndex}-${v.tricksPlayed}` : null;
  if (key && key !== lastTrickKey){
    // neuer Stich abgeschlossen -> 5 s in der Tischmitte zeigen
    lastTrickUntil = Date.now() + LAST_TRICK_SHOW_MS;
    clearTimeout(lastTrickTimer);
    lastTrickTimer = setTimeout(() => { if (lastState) renderGame(lastState); }, LAST_TRICK_SHOW_MS + 50);
  }
  lastTrickKey = key;

  const has = !!v.lastTrick;
  $('last-trick-side').classList.toggle('hidden', !has);
  $('btn-last-trick').classList.toggle('hidden', !has);
  if (!has) $('last-trick-modal').classList.add('hidden');
  for (const box of [$('last-trick-side'), $('last-trick-modal')]){
    const cards = box.querySelector('.lt-cards'); cards.innerHTML = '';
    const win = box.querySelector('.lt-winner');
    if (!has){ win.textContent = ''; continue; }
    v.lastTrick.cards.forEach(pl => {
      cards.appendChild(cardEl(pl.card, { who: players[pl.playerIdx].name, win: pl.playerIdx===v.lastTrick.winnerIdx }));
    });
    win.textContent = `→ ${players[v.lastTrick.winnerIdx].name}`;
  }
}
$('btn-last-trick').onclick = () => $('last-trick-modal').classList.remove('hidden');
$('btn-lt-close').onclick = () => $('last-trick-modal').classList.add('hidden');
$('last-trick-modal').onclick = e => { if (e.target.id === 'last-trick-modal') $('last-trick-modal').classList.add('hidden'); };

// ---------- Abstimmung Spielstart / nächste Runde (Issue #9) ----------
let voteState = null, voteBox = null, voteTimer = null;
function renderVote(boxId, v){
  for (const id of ['lobby-vote','ov-vote']) if (id!==boxId) $(id).classList.add('hidden');
  const box = $(boxId);
  voteState = v ? { ...v, localDeadline: Date.now() + v.remainingMs } : null;
  voteBox = box;
  if (!v){ box.classList.add('hidden'); box.innerHTML=''; stopVoteTimer(); return; }
  box.classList.remove('hidden');
  const mine = (v.voters.find(x => x.id===clientId) || {}).vote;
  const title = v.kind==='start' ? 'Spiel starten?' : 'Nächste Runde starten?';
  const list = v.voters.map(x => {
    const cls = x.vote || 'open', sym = x.vote==='yes' ? '✓' : x.vote==='no' ? '✗' : '…';
    return `<li class="${cls}">${sym} ${escapeHtml(x.name)}${x.id===clientId?' (du)':''}</li>`;
  }).join('');
  box.innerHTML = `<div class="vt-head"><span>🗳 ${title}</span><span class="vt-time"></span></div>
    <div class="vt-bar"><div></div></div>
    <ul>${list}</ul>
    <div class="hint">${v.paused ? 'Zeit angehalten – wartet, bis alle Nein-Stimmen auf Ja wechseln.'
      : 'Ohne Nein-Stimme startet es nach Ablauf der Zeit automatisch.'}</div>
    <div class="vt-btns">
      <button data-v="yes" class="primary${mine==='yes'?' sel':''}">Ja</button>
      <button data-v="no" class="${mine==='no'?'sel':''}">Nein</button>
    </div>`;
  box.querySelectorAll('button[data-v]').forEach(b => b.onclick = () => send({ type:'vote', choice: b.dataset.v }));
  tickVote();
  if (!voteTimer) voteTimer = setInterval(tickVote, 250);
}
// ---------- Votekick (Lobby) ----------
let kickState = null, kickTimer = null;
function renderKick(k){
  const box = $('lobby-kick');
  kickState = k ? { ...k, localDeadline: Date.now() + k.remainingMs } : null;
  if (!k){ box.classList.add('hidden'); box.innerHTML=''; if (kickTimer){ clearInterval(kickTimer); kickTimer=null; } return; }
  box.classList.remove('hidden');
  const isTarget = k.targetId === clientId;
  const mine = (k.voters.find(x => x.id===clientId) || {}).vote;
  const yes = k.voters.filter(x => x.vote==='yes').length;
  const list = k.voters.map(x => {
    const cls = x.vote || 'open', sym = x.vote==='yes' ? '✓' : x.vote==='no' ? '✗' : '…';
    return `<li class="${cls}">${sym} ${escapeHtml(x.name)}${x.id===clientId?' (du)':''}</li>`;
  }).join('');
  box.innerHTML = `<div class="vt-head"><span>🚫 ${escapeHtml(k.targetName)} kicken?</span><span class="vt-time"></span></div>
    <div class="vt-bar"><div></div></div>
    <ul>${list}</ul>
    <div class="hint">${yes} von ${k.needed} nötigen Ja-Stimmen (mehr als 50 %).</div>
    ${isTarget ? '<div class="hint">Über dich wird abgestimmt – du bist nicht stimmberechtigt.</div>' : `<div class="vt-btns">
      <button data-k="yes" class="primary${mine==='yes'?' sel':''}">Ja</button>
      <button data-k="no" class="${mine==='no'?'sel':''}">Nein</button>
    </div>`}`;
  box.querySelectorAll('button[data-k]').forEach(b => b.onclick = () => send({ type:'kickVote', choice: b.dataset.k }));
  tickKick();
  if (!kickTimer) kickTimer = setInterval(tickKick, 250);
}
function tickKick(){
  const box = $('lobby-kick');
  if (!kickState) return;
  const ms = Math.max(0, kickState.localDeadline - Date.now());
  const t = box.querySelector('.vt-time'), bar = box.querySelector('.vt-bar>div');
  if (t) t.textContent = Math.ceil(ms/1000) + ' s';
  if (bar) bar.style.width = (100 * ms / kickState.totalMs) + '%';
}
function stopVoteTimer(){ if (voteTimer){ clearInterval(voteTimer); voteTimer=null; } }
function tickVote(){
  if (!voteState || !voteBox) return stopVoteTimer();
  const ms = voteState.paused ? voteState.remainingMs : Math.max(0, voteState.localDeadline - Date.now());
  const t = voteBox.querySelector('.vt-time'), bar = voteBox.querySelector('.vt-bar>div');
  if (t){ t.textContent = (voteState.paused ? '⏸ ' : '') + Math.ceil(ms/1000) + ' s'; t.classList.toggle('paused', voteState.paused); }
  if (bar) bar.style.width = (100 * ms / voteState.totalMs) + '%';
}
$('ov-home').onclick = () => { send({ type:'leaveRoom' }); };

// ---------- Utils ----------
let toastTimer;
function toast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.add('hidden'),2600);
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- Chat ----------
let chatOpen = false, unread = 0;
function setFab(visible){
  $('chat-fab').classList.toggle('hidden', !visible || chatOpen);
  if (!visible){ $('chat').classList.add('hidden'); chatOpen = false; }
}
function openChat(){
  chatOpen = true; unread = 0;
  $('chat').classList.remove('hidden');
  $('chat-fab').classList.add('hidden');
  updateBadge();
  const log = $('chat-log'); log.scrollTop = log.scrollHeight;
  $('chat-text').focus();
}
function closeChat(){
  chatOpen = false;
  $('chat').classList.add('hidden');
  $('chat-fab').classList.remove('hidden');
}
function updateBadge(){
  const b = $('chat-badge');
  if (unread>0 && !chatOpen){ b.textContent = unread>99?'99+':unread; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}
function fmtTime(ts){ const d=new Date(ts||Date.now()); return d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}); }
function msgEl(msg){
  const el=document.createElement('div');
  if (msg.system){ el.className='cm sys'; el.textContent=msg.text; return el; }
  el.className='cm' + (msg.name===myName?' me':'');
  const nm=document.createElement('span'); nm.className='nm'; nm.textContent=msg.name+': ';
  const tx=document.createElement('span'); tx.textContent=msg.text;
  const tm=document.createElement('span'); tm.className='tm'; tm.textContent=fmtTime(msg.ts);
  el.appendChild(nm); el.appendChild(tx); el.appendChild(tm);
  return el;
}
function addChatMsg(msg){
  const log=$('chat-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(msgEl(msg));
  if (atBottom || chatOpen) log.scrollTop = log.scrollHeight;
  if (!chatOpen && !msg.system){ unread++; updateBadge(); }
}
function renderChatHistory(list){
  const log=$('chat-log'); log.innerHTML='';
  list.forEach(m=>log.appendChild(msgEl(m)));
  log.scrollTop = log.scrollHeight;
}
function leaveChatUI(){
  $('chat-log').innerHTML=''; unread=0; updateBadge(); setFab(false);
}
function sendChat(){
  const inp=$('chat-text'); const text=inp.value.trim();
  if (!text) return;
  send({ type:'chat', text });
  inp.value=''; inp.focus();
}
$('chat-fab').onclick = openChat;
$('chat-close').onclick = closeChat;
$('chat-send').onclick = sendChat;
$('chat-text').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

// ---------- Voice (WebRTC-Mesh, Perfect Negotiation) ----------
let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let voiceJoined = false, localStream = null, muted = false, localSpeaking = false;
let voiceRoster = [];                 // aktuelle Voice-Mitglieder laut Server
const peers = new Map();              // id -> {pc, polite, makingOffer, ignoreOffer, name, speaking}

function enterRoomUI(){ setFab(true); $('voice').classList.remove('hidden'); }
function exitRoomUI(){ renderVote('lobby-vote', null); renderKick(null); renderMute(null); setFab(false); $('voice').classList.add('hidden'); voiceLeave(true); }

async function voiceJoin(){
  if (voiceJoined) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    return toast('Mikrofon nicht verfügbar (HTTPS nötig).');
  }
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }catch(e){
    return toast('Mikrofonzugriff verweigert oder kein HTTPS.');
  }
  voiceJoined = true; muted = false;
  try{ ensureCtx().resume(); }catch(e){}
  setupMeter('me', localStream);
  $('voice-join').classList.add('hidden');
  $('voice-active').classList.remove('hidden');
  $('voice-mute').classList.remove('on'); $('voice-mute').textContent = '🔇 Stumm';
  send({ type:'voice-join' });
  if (selfVoteMuted) applySelfMute(true);   // per Abstimmung stumm: nur zuhören
  renderVoiceList();
}

function voiceLeave(silent){
  if (voiceJoined && !silent) send({ type:'voice-leave' });
  for (const id of [...peers.keys()]) closePeer(id);
  peers.clear();
  if (localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  removeMeter('me');
  voiceJoined = false; localSpeaking = false;
  $('voice-active') && $('voice-active').classList.add('hidden');
  $('voice-join') && $('voice-join').classList.remove('hidden');
  renderVoiceList();
}

function onVoiceMembers(members){
  voiceRoster = members;
  for (const m of members) applyRemoteMute(m.id, !!m.muted);
  const others = voiceRoster.filter(m=>m.id!==clientId);
  $('voice-join').textContent = others.length ? `🎤 Voice beitreten (${others.length} aktiv)` : '🎤 Voice beitreten';
  if (voiceJoined){
    const ids = new Set(voiceRoster.map(m=>m.id));
    for (const id of [...peers.keys()]) if (!ids.has(id)) closePeer(id);
    for (const m of voiceRoster){
      if (m.id===clientId) continue;
      if (!peers.has(m.id)) createPeer(m.id, m.name);
      else peers.get(m.id).name = m.name;
    }
  }
  renderVoiceList();
}

function createPeer(id, name){
  const pc = new RTCPeerConnection(rtcConfig);
  const p = { pc, polite: clientId > id, makingOffer:false, ignoreOffer:false, name, speaking:false };
  peers.set(id, p);
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.onicecandidate = ({candidate}) => { if (candidate) send({ type:'rtc-signal', to:id, data:{ candidate } }); };
  pc.ontrack = (ev) => attachRemote(id, ev.streams[0]);
  pc.onnegotiationneeded = async () => {
    try{
      p.makingOffer = true;
      await pc.setLocalDescription();
      send({ type:'rtc-signal', to:id, data:{ description: pc.localDescription } });
    }catch(e){ console.error(e); }
    finally{ p.makingOffer = false; }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed'){ try{ pc.restartIce && pc.restartIce(); }catch(e){} }
    renderVoiceList();
  };
  return p;
}

async function onSignal(from, data){
  if (!data) return;
  let p = peers.get(from);
  if (!p){
    if (!voiceJoined || !localStream) return; // wir sind nicht im Voice
    p = createPeer(from, (voiceRoster.find(m=>m.id===from)||{}).name || 'Spieler');
  }
  const pc = p.pc;
  try{
    if (data.description){
      const collision = data.description.type==='offer' && (p.makingOffer || pc.signalingState!=='stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type==='offer'){
        await pc.setLocalDescription();
        send({ type:'rtc-signal', to:from, data:{ description: pc.localDescription } });
      }
    } else if (data.candidate){
      try{ await pc.addIceCandidate(data.candidate); }
      catch(e){ if (!p.ignoreOffer) console.error(e); }
    }
  }catch(e){ console.error('rtc-signal', e); }
}

function attachRemote(id, stream){
  let el = document.getElementById('audio-'+id);
  if (!el){ el=document.createElement('audio'); el.id='audio-'+id; el.autoplay=true; el.setAttribute('playsinline',''); $('remote-audio').appendChild(el); }
  el.srcObject = stream;
  el.muted = isVoteMuted(id);
  setupMeter(id, stream);
}

function closePeer(id){
  const p = peers.get(id);
  if (p){ try{ p.pc.close(); }catch(e){} peers.delete(id); }
  removeMeter(id);
  const el = document.getElementById('audio-'+id);
  if (el){ el.srcObject=null; el.remove(); }
}

function toggleMute(){
  if (!localStream) return;
  if (selfVoteMuted) return toast('Du bist stummgeschaltet und kannst das Mikrofon nicht aktivieren.');
  muted = !muted;
  localStream.getAudioTracks().forEach(t=>t.enabled = !muted);
  const b = $('voice-mute');
  b.classList.toggle('on', muted);
  b.textContent = muted ? '🔈 Laut' : '🔇 Stumm';
  renderVoiceList();
}

// --- Sprech-Anzeige (WebAudio) ---
let audioCtx=null; const meters=new Map(); let meterRAF=null;
function ensureCtx(){ if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)(); return audioCtx; }
function setupMeter(id, stream){
  try{
    const ctx=ensureCtx();
    const src=ctx.createMediaStreamSource(stream);
    const an=ctx.createAnalyser(); an.fftSize=512;
    src.connect(an);
    meters.set(id, { an, data:new Uint8Array(an.fftSize), src });
    startMeterLoop();
  }catch(e){}
}
function removeMeter(id){ const m=meters.get(id); if(m){ try{m.src.disconnect();}catch(e){} meters.delete(id); } }
function startMeterLoop(){
  if (meterRAF) return;
  const tick=()=>{
    for (const [id,m] of meters){
      m.an.getByteTimeDomainData(m.data);
      let sum=0; for (let i=0;i<m.data.length;i++){ const v=(m.data[i]-128)/128; sum+=v*v; }
      const rms=Math.sqrt(sum/m.data.length);
      const speaking = rms>0.045;
      if (id==='me'){ if(muted){ localSpeaking=false; } else localSpeaking=speaking; }
      else { const p=peers.get(id); if(p) p.speaking=speaking; }
    }
    updateSpeakingDom();
    meterRAF = meters.size ? requestAnimationFrame(tick) : null;
  };
  meterRAF = requestAnimationFrame(tick);
}
function updateSpeakingDom(){
  const meRow=document.getElementById('vrow-me');
  if (meRow) meRow.classList.toggle('speaking', localSpeaking);
  for (const [id,p] of peers){
    const r=document.getElementById('vrow-'+id);
    if (r) r.classList.toggle('speaking', !!p.speaking);
  }
}

function stateLabel(s){
  return ({connected:'verbunden', connecting:'verbinde…', new:'verbinde…', checking:'verbinde…',
    disconnected:'getrennt', failed:'fehlgeschlagen', closed:'zu'}[s] || s || '');
}
function voiceRow(rowId, name, isMuted, speaking, right){
  const el=document.createElement('div');
  el.id='vrow-'+rowId;
  el.className='vc'+(speaking?' speaking':'')+(isMuted?' muted':'')+(isVoteMuted(rowId==='me'?clientId:rowId)?' muted-by-vote':'');
  el.innerHTML=`<span class="ring"></span><span class="nm">${escapeHtml(name)}</span><span class="st">${escapeHtml(right||'')}</span>`;
  return el;
}
function renderVoiceList(){
  const box=$('voice-list'); if(!box) return; box.innerHTML='';
  if (voiceJoined) box.appendChild(voiceRow('me', 'Du', muted, localSpeaking, muted?'stumm':''));
  for (const m of voiceRoster){
    if (m.id===clientId) continue;
    const p=peers.get(m.id);
    box.appendChild(voiceRow(m.id, m.name, !!m.muted, p?p.speaking:false, m.muted?'stumm (Abst.)':(p?stateLabel(p.pc.connectionState):'…')));
  }
}

// ---------- Mute per Abstimmung (Text- und Sprachchat) ----------
let mutedIds = new Set(), selfVoteMuted = false, muteVoteState = null, muteVoteTimer = null, mutePanelOpen = false;
function isVoteMuted(id){ return mutedIds.has(id); }
function applyRemoteMute(id, on){
  const el = document.getElementById('audio-'+id);
  if (el) el.muted = on;
}
function applySelfMute(on){
  selfVoteMuted = on;
  // Chat-Eingabe sperren
  const inp = $('chat-text');
  inp.disabled = on; $('chat-send').disabled = on;
  inp.placeholder = on ? 'Du bist stummgeschaltet' : 'Nachricht…';
  // Mikrofon zwangsweise aus
  if (localStream){
    if (on){ muted = true; localStream.getAudioTracks().forEach(t=>t.enabled=false); }
    const b = $('voice-mute');
    b.classList.toggle('on', muted); b.textContent = muted ? '🔈 Laut' : '🔇 Stumm';
    b.disabled = on;
  }
}
function renderMute(info){
  const players = info ? info.players : [];
  const prevSelf = selfVoteMuted;
  mutedIds = new Set(players.filter(p=>p.muted).map(p=>p.id));
  const me = players.find(p=>p.id===clientId);
  const meMuted = !!(me && me.muted);
  if (meMuted !== prevSelf){
    applySelfMute(meMuted);
    if (info) toast(meMuted ? '🔇 Du wurdest im Text- und Sprachchat stummgeschaltet.' : '🔈 Du bist wieder freigeschaltet.');
  }
  for (const p of players) applyRemoteMute(p.id, p.muted && p.id!==clientId);
  // Spielerliste im Chat-Panel
  const ul = $('mute-list'); ul.innerHTML = '';
  const iAmAdmin = !!(me && me.admin);
  const vote = info ? info.vote : null;
  for (const p of players){
    if (p.id===clientId) continue;
    const li = document.createElement('li'); if (p.muted) li.className='muted';
    const nm = document.createElement('span'); nm.className='nm';
    nm.textContent = (p.muted?'🔇 ':'') + p.name + (p.admin?' (Admin)':'') + (p.connected?'':' (getrennt)');
    li.appendChild(nm);
    const canVote = iAmAdmin || (!vote && (p.muted || !p.admin));
    if (canVote){
      const b = document.createElement('button');
      b.textContent = p.muted ? 'Entmuten' : 'Muten';
      b.title = iAmAdmin ? 'Sofort (Admin)' : 'Abstimmung starten (mehr als 50 % Ja; bei 2 Spielern sofort)';
      b.onclick = () => send({ type:'mute', targetId: p.id, action: p.muted ? 'unmute' : 'mute' });
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  if (!ul.children.length){ const li=document.createElement('li'); li.textContent='Keine Mitspieler.'; ul.appendChild(li); }
  renderMuteVote(vote);
  renderVoiceList();
}
function renderMuteVote(v){
  const box = $('mute-vote');
  muteVoteState = v ? { ...v, localDeadline: Date.now() + v.remainingMs } : null;
  if (!v){ box.classList.add('hidden'); box.innerHTML=''; if (muteVoteTimer){ clearInterval(muteVoteTimer); muteVoteTimer=null; } return; }
  box.classList.remove('hidden');
  const isTarget = v.targetId === clientId;
  const mine = (v.voters.find(x => x.id===clientId) || {}).vote;
  const yes = v.voters.filter(x => x.vote==='yes').length;
  const list = v.voters.map(x => {
    const cls = x.vote || 'open', sym = x.vote==='yes' ? '✓' : x.vote==='no' ? '✗' : '…';
    return `<li class="${cls}">${sym} ${escapeHtml(x.name)}${x.id===clientId?' (du)':''}</li>`;
  }).join('');
  const what = v.action === 'mute' ? 'stummschalten' : 'wieder freischalten';
  box.innerHTML = `<div class="vt-head"><span>${v.action==='mute'?'🔇':'🔈'} ${escapeHtml(v.targetName)} ${what}?</span><span class="vt-time"></span></div>
    <div class="vt-bar"><div></div></div>
    <ul>${list}</ul>
    <div class="hint">${yes} von ${v.needed} nötigen Ja-Stimmen (mehr als 50 %).</div>
    ${isTarget ? '<div class="hint">Über dich wird abgestimmt – du bist nicht stimmberechtigt.</div>' : `<div class="vt-btns">
      <button data-m="yes" class="primary${mine==='yes'?' sel':''}">Ja</button>
      <button data-m="no" class="${mine==='no'?'sel':''}">Nein</button>
    </div>`}`;
  box.querySelectorAll('button[data-m]').forEach(b => b.onclick = () => send({ type:'muteVote', choice: b.dataset.m }));
  tickMuteVote();
  if (!muteVoteTimer) muteVoteTimer = setInterval(tickMuteVote, 250);
}
function tickMuteVote(){
  if (!muteVoteState) return;
  const box = $('mute-vote');
  const ms = Math.max(0, muteVoteState.localDeadline - Date.now());
  const t = box.querySelector('.vt-time'), bar = box.querySelector('.vt-bar>div');
  if (t) t.textContent = Math.ceil(ms/1000) + ' s';
  if (bar) bar.style.width = (100 * ms / muteVoteState.totalMs) + '%';
}
$('chat-mute-toggle').onclick = () => {
  mutePanelOpen = !mutePanelOpen;
  $('mute-panel').classList.toggle('hidden', !mutePanelOpen);
  $('chat-mute-toggle').classList.toggle('on', mutePanelOpen);
};

$('voice-join').onclick = voiceJoin;
$('voice-leave').onclick = () => voiceLeave(false);
$('voice-mute').onclick = toggleMute;
window.addEventListener('beforeunload', () => { if(voiceJoined) voiceLeave(false); });

// ---------- Vollbild (Issue #3) ----------
// Fullscreen-API inkl. WebKit-Präfix; auf iPhone-Safari nicht verfügbar → Button bleibt versteckt
// (dort hilft „Zum Home-Bildschirm“, siehe manifest.webmanifest / apple-mobile-web-app-capable).
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsSupported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
function toggleFullscreen(){
  const de = document.documentElement;
  try {
    if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else {
      const r = (de.requestFullscreen || de.webkitRequestFullscreen).call(de, { navigationUI:'hide' });
      if (r && r.catch) r.catch(() => toast('Vollbild wird von diesem Browser nicht erlaubt.'));
    }
  } catch (e) { toast('Vollbild wird von diesem Browser nicht unterstützt.'); }
}
function updateFsBtn(){
  const b = $('btn-fullscreen');
  b.classList.toggle('on', !!fsEl());
  b.title = fsEl() ? 'Vollbild beenden' : 'Vollbild';
}
if (fsSupported) {
  $('btn-fullscreen').classList.remove('hidden');
  $('btn-fullscreen').onclick = toggleFullscreen;
  document.addEventListener('fullscreenchange', updateFsBtn);
  document.addEventListener('webkitfullscreenchange', updateFsBtn);
}

connect();


// ---------- Konten (Registrierung per Matrix-DM) ----------
const API = ((typeof window.__BASE__ === 'string') ? window.__BASE__ : '') + '/api/account';
let account = null, acctCfg = { enabled:false };
let regToken = null, regExpires = 0, regPoll = null, regTick = null;
let delToken = null, delExpires = 0, delPoll = null, delTick = null;
let rlToken = null, rlExpires = 0, rlPoll = null, rlTick = null;

async function api(pathname, body){
  const opt = body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) };
  const r = await fetch(API + pathname, Object.assign({ credentials:'same-origin' }, opt));
  let j = {}; try { j = await r.json(); } catch(_) {}
  if (!r.ok) { const e = new Error(j.error || ('Fehler ' + r.status)); e.status = r.status; throw e; }
  return j;
}
function setMsg(id, text, cls){ const el=$(id); el.textContent = text || ''; el.className = 'msg' + (cls ? ' ' + cls : ''); }

function setAccount(u){
  account = u;
  $('acct-guest').classList.toggle('hidden', !!u);
  $('acct-user').classList.toggle('hidden', !u);
  $('name-label').classList.toggle('hidden', !!u);
  if (wsReady) send({ type:'listRooms' }); // Beitreten-Buttons für Ranglisten-Räume aktualisieren
  if (u){ $('acct-name').textContent = u.username; myName = u.username; }
  else { myName = localStorage.getItem('portriga_name') || ''; $('name').value = myName; }
  setForcedRelink(!!(u && u.needsRelink));
}
// Konto ohne Passwort hat den Bot-Chat verlassen -> neuen Chat verknüpfen erzwingen
function setForcedRelink(on){
  const was = $('acct-modal').classList.contains('forced');
  $('acct-modal').classList.toggle('forced', on);
  $('acct-settings').classList.toggle('forced', on);
  $('rl-forced').classList.toggle('hidden', !on);
  if (on && !was) openAcct('settings');
  else if (!on && was) closeAcct();
}
// Nach Login/Logout WebSocket neu aufbauen, damit der Server das Session-Cookie sieht.
function reconnectWs(){ try { if (ws) ws.close(); } catch(_) {} }

function openAcct(view){
  $('acct-modal').classList.remove('hidden');
  for (const v of ['login','register','settings']) $('acct-'+v).classList.toggle('hidden', v !== view);
  if (view === 'login') { setMsg('login-msg',''); setTimeout(()=>$('login-id').focus(), 30); }
  if (view === 'register') { if (!regToken) showRegStep(1); setTimeout(()=>$('reg-user').focus(), 30); }
  if (view === 'settings' && account) {
    $('set-name').textContent = account.username; $('set-mxid').textContent = account.mxid;
    $('set-cur-label').classList.toggle('hidden', !account.hasPassword);
    $('set-new-caption').textContent = account.hasPassword ? 'Neues Passwort' : 'Passwort setzen';
    $('set-cur').value = ''; $('set-new').value = ''; setMsg('set-msg','');
    $('del-pw-label').classList.toggle('hidden', !account.hasPassword);
    $('del-pw').value = ''; setMsg('del-msg','');
    if (!delToken) showDelStep(1);
    $('rl-pw-label').classList.toggle('hidden', !account.hasPassword);
    $('rl-pw').value = ''; setMsg('rl-msg','');
    $('set-notify-rank').checked = !!account.notifyRank; setMsg('notify-msg','');
    if (!rlToken) showRlStep(1);
  }
}
function closeAcct(){ if (account && account.needsRelink) return; $('acct-modal').classList.add('hidden'); }
$('acct-close').onclick = closeAcct;
$('acct-modal').addEventListener('click', e => { if (e.target === $('acct-modal')) closeAcct(); });
$('btn-show-login').onclick = () => openAcct('login');
// Gast klickt auf ein Ranglisten-Spiel -> Hinweis-Dialog mit Angebot, ein Konto zu erstellen
function openGuestRanked(){ $('guest-ranked-modal').classList.remove('hidden'); setTimeout(()=>$('btn-gr-register').focus(), 30); }
function closeGuestRanked(){ $('guest-ranked-modal').classList.add('hidden'); }
$('btn-gr-register').onclick = () => { closeGuestRanked(); openAcct('register'); };
$('btn-gr-login').onclick = () => { closeGuestRanked(); openAcct('login'); };
$('btn-gr-cancel').onclick = closeGuestRanked;
$('gr-close').onclick = closeGuestRanked;
$('guest-ranked-modal').addEventListener('click', e => { if (e.target === $('guest-ranked-modal')) closeGuestRanked(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('guest-ranked-modal').classList.contains('hidden')) closeGuestRanked(); });
$('btn-show-register').onclick = () => openAcct('register');
$('btn-to-register').onclick = () => openAcct('register');
$('btn-acct-settings').onclick = () => openAcct('settings');
$('btn-logout').onclick = async () => { let j = {}; try { j = await api('/logout', {}); } catch(_) {} setAccount(null); reconnectWs(); toast(j.deleted ? 'Abgemeldet – dein Konto wurde gelöscht.' : 'Abgemeldet.'); };
$('btn-rl-forced-logout').onclick = async () => {
  if (!confirm('Ohne neuen Matrix-Chat wird dein Konto endgültig gelöscht. Fortfahren?')) return;
  resetRl(); try { await api('/me/matrix/cancel', {}); } catch(_) {}
  $('btn-logout').onclick();
};

// --- Anmelden ---
$('btn-login').onclick = async () => {
  try {
    const j = await api('/login', { login: $('login-id').value.trim(), password: $('login-pw').value });
    $('login-pw').value = ''; setAccount(j.user); closeAcct(); reconnectWs(); toast('Willkommen, ' + j.user.username + '!');
  } catch(e){ setMsg('login-msg', e.message, 'bad'); }
};
$('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });
$('btn-login-matrix').onclick = async () => {
  const login = $('login-id').value.trim();
  if (!login) return setMsg('login-msg', 'Benutzername oder Matrix-ID eingeben.', 'bad');
  try { await api('/login/matrix', { login }); setMsg('login-msg', 'Falls ein Konto existiert, wurde dir ein Login-Link per Matrix geschickt.', 'ok'); }
  catch(e){ setMsg('login-msg', e.message, 'bad'); }
};

// --- Registrieren ---
function showRegStep(n){
  $('reg-step1').classList.toggle('hidden', n !== 1);
  $('reg-step2').classList.toggle('hidden', n !== 2);
}
let availTimer = null, availOk = false;
function updateRegBtn(){
  const pw = $('reg-pw').value, pw2 = $('reg-pw2').value;
  $('reg-pw2-label').classList.toggle('hidden', !pw);
  const pwOk = !pw || (pw.length >= 8 && pw === pw2);
  $('btn-reg-start').disabled = !(availOk && pwOk);
  if (pw && pw.length < 8) setMsg('reg-msg', 'Passwort: mindestens 8 Zeichen.', 'bad');
  else if (pw && pw2 && pw !== pw2) setMsg('reg-msg', 'Passwörter stimmen nicht überein.', 'bad');
  else setMsg('reg-msg', '');
}
$('reg-user').addEventListener('input', () => {
  availOk = false; updateRegBtn();
  clearTimeout(availTimer);
  const u = $('reg-user').value.trim();
  if (!u) return setMsg('reg-avail', '');
  setMsg('reg-avail', 'Prüfe…');
  availTimer = setTimeout(async () => {
    try {
      const j = await api('/register/check?u=' + encodeURIComponent(u));
      if ($('reg-user').value.trim() !== u) return;
      availOk = !!j.available;
      setMsg('reg-avail', j.available ? '✓ „' + u + '“ ist frei.' : '✗ ' + j.reason, j.available ? 'ok' : 'bad');
      updateRegBtn();
    } catch(e){ setMsg('reg-avail', e.message, 'bad'); }
  }, 350);
});
$('reg-pw').addEventListener('input', updateRegBtn);
$('reg-pw2').addEventListener('input', updateRegBtn);
$('btn-reg-start').onclick = async () => {
  try {
    const j = await api('/register/start', { username: $('reg-user').value.trim(), password: $('reg-pw').value, notifyRank: $('reg-notify-rank').checked });
    $('reg-pw').value = ''; $('reg-pw2').value = '';
    regToken = j.token; regExpires = j.expires;
    $('reg-code').textContent = j.code;
    $('reg-bot').textContent = j.botMxid; $('reg-bot').href = j.matrixTo;
    setMsg('reg-wait', '⏳ Warte auf deine Nachricht…');
    showRegStep(2); startRegPoll();
  } catch(e){ setMsg('reg-msg', e.message, 'bad'); if (e.status === 409) { availOk = false; updateRegBtn(); } }
};
function copyText(t){ (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(()=>toast('Kopiert.'), ()=>toast(t)); }
$('btn-copy-code').onclick = () => copyText($('reg-code').textContent);
$('btn-copy-bot').onclick = () => copyText($('reg-bot').textContent);
function stopRegPoll(){ clearInterval(regPoll); clearInterval(regTick); regPoll = regTick = null; }
function resetReg(){ stopRegPoll(); regToken = null; showRegStep(1); $('reg-user').value=''; setMsg('reg-avail',''); availOk=false; updateRegBtn(); }
function startRegPoll(){
  stopRegPoll();
  const tick = () => {
    const s = Math.max(0, Math.round((regExpires - Date.now()) / 1000));
    $('reg-timer').textContent = Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  };
  tick(); regTick = setInterval(tick, 1000);
  regPoll = setInterval(async () => {
    if (!regToken) return stopRegPoll();
    try {
      const j = await api('/register/status?token=' + encodeURIComponent(regToken));
      if (j.status === 'done') {
        resetReg(); setAccount(j.user); closeAcct(); reconnectWs();
        toast('Konto „' + j.user.username + '“ angelegt – du bist angemeldet.');
      } else if (j.status === 'failed') { stopRegPoll(); regToken = null; setMsg('reg-wait', '✗ ' + j.error, 'bad'); }
      else if (j.status === 'expired') { stopRegPoll(); regToken = null; setMsg('reg-wait', '✗ Code abgelaufen – bitte neu starten.', 'bad'); }
    } catch(_) { /* vorübergehend – weiter pollen */ }
  }, 2500);
}
$('btn-reg-cancel').onclick = async () => { const t = regToken; resetReg(); if (t) { try { await api('/register/cancel', { token: t }); } catch(_) {} } };

// --- Konto-Einstellungen ---
$('btn-set-pw').onclick = async () => {
  const np = $('set-new').value;
  if (!np && account && !account.hasPassword) return setMsg('set-msg', 'Bitte ein Passwort eingeben.', 'bad');
  if (!np && !confirm('Passwort wirklich entfernen? Anmeldung dann nur noch per Matrix-Link.')) return;
  try {
    const j = await api('/me/password', { currentPassword: $('set-cur').value, newPassword: np });
    setAccount(j.user); openAcct('settings'); setMsg('set-msg', np ? 'Passwort gespeichert.' : 'Passwort entfernt.', 'ok');
  } catch(e){ setMsg('set-msg', e.message, 'bad'); }
};
$('btn-logout-all').onclick = async () => {
  if (!confirm('Auf allen Geräten abmelden?')) return;
  try { await api('/me/logout-all', {}); } catch(_) {}
  setAccount(null); closeAcct(); reconnectWs(); toast('Überall abgemeldet.');
};

// --- Benachrichtigungen ---
$('set-notify-rank').onchange = async () => {
  const el = $('set-notify-rank'), on = el.checked;
  el.disabled = true;
  try {
    const j = await api('/me/notify', { notifyRank: on });
    account = j.user;
    setMsg('notify-msg', on ? 'Benachrichtigung aktiviert.' : 'Benachrichtigung deaktiviert.', 'ok');
  } catch (e) { el.checked = !on; setMsg('notify-msg', e.message, 'bad'); }
  el.disabled = false;
};

// --- Matrix-Konto / -Chat ändern ---
function showRlStep(n){ $('rl-step1').classList.toggle('hidden', n !== 1); $('rl-step2').classList.toggle('hidden', n !== 2); }
function stopRlPoll(){ clearInterval(rlPoll); clearInterval(rlTick); rlPoll = rlTick = null; }
function resetRl(){ stopRlPoll(); rlToken = null; showRlStep(1); }
function startRlPoll(){
  stopRlPoll();
  const tick = () => {
    const s = Math.max(0, Math.round((rlExpires - Date.now()) / 1000));
    $('rl-timer').textContent = Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  };
  tick(); rlTick = setInterval(tick, 1000);
  rlPoll = setInterval(async () => {
    if (!rlToken) return stopRlPoll();
    try {
      const j = await api('/me/matrix/status?token=' + encodeURIComponent(rlToken));
      if (j.status === 'done') { resetRl(); setAccount(j.user); $('set-mxid').textContent = j.user.mxid; setMsg('rl-msg', '✓ Verknüpft mit ' + j.user.mxid + '.', 'ok'); }
      else if (j.status === 'failed') { resetRl(); setMsg('rl-msg', '✗ ' + j.error, 'bad'); }
      else if (j.status === 'expired') { resetRl(); setMsg('rl-msg', '✗ Code abgelaufen – bitte neu anfordern.', 'bad'); }
    } catch(e){ if (e.status === 401) { resetRl(); setAccount(null); closeAcct(); } }
  }, 2500);
}
$('btn-rl-start').onclick = async () => {
  try {
    const j = await api('/me/matrix', { password: $('rl-pw').value });
    $('rl-pw').value = ''; setMsg('rl-msg', '');
    rlToken = j.token; rlExpires = j.expires;
    $('rl-code').textContent = j.code;
    $('rl-bot').textContent = j.botMxid; $('rl-bot').href = j.matrixTo;
    setMsg('rl-wait', '⏳ Warte auf deine Nachricht…');
    showRlStep(2); startRlPoll();
  } catch(e){ setMsg('rl-msg', e.message, 'bad'); }
};
$('btn-copy-rl').onclick = () => copyText($('rl-code').textContent);
$('btn-rl-cancel').onclick = async () => {
  resetRl();
  try { await api('/me/matrix/cancel', {}); setMsg('rl-msg', 'Abgebrochen.', 'ok'); } catch(e){ setMsg('rl-msg', e.message, 'bad'); }
};

// --- Konto löschen (bei Matrix-Verknüpfung Bestätigung per DM) ---
function showDelStep(n){ $('del-step1').classList.toggle('hidden', n !== 1); $('del-step2').classList.toggle('hidden', n !== 2); }
function stopDelPoll(){ clearInterval(delPoll); clearInterval(delTick); delPoll = delTick = null; }
function resetDel(){ stopDelPoll(); delToken = null; showDelStep(1); }
function accountDeleted(){
  resetDel(); setAccount(null); closeAcct(); reconnectWs();
  toast('Dein Konto wurde gelöscht.');
}
function startDelPoll(){
  stopDelPoll();
  const tick = () => {
    const s = Math.max(0, Math.round((delExpires - Date.now()) / 1000));
    $('del-timer').textContent = Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  };
  tick(); delTick = setInterval(tick, 1000);
  delPoll = setInterval(async () => {
    if (!delToken) return stopDelPoll();
    try {
      const j = await api('/me/delete/status?token=' + encodeURIComponent(delToken));
      if (j.status === 'deleted') accountDeleted();
      else if (j.status === 'expired') { resetDel(); setMsg('del-msg', '✗ Löschanfrage abgelaufen – das Konto besteht weiter.', 'bad'); }
    } catch(_) { /* vorübergehend – weiter pollen */ }
  }, 2500);
}
$('btn-del-start').onclick = async () => {
  if (!account) return;
  const linked = !!account.mxid;
  if (!confirm('Konto „' + account.username + '“ wirklich endgültig löschen?' + (linked ? '\nDie Löschung muss anschließend per Matrix bestätigt werden.' : ''))) return;
  try {
    const j = await api('/me/delete', { password: $('del-pw').value });
    $('del-pw').value = ''; setMsg('del-msg', '');
    if (j.deleted) return accountDeleted();
    delToken = j.token; delExpires = j.expires;
    $('del-cmd').textContent = 'löschen ' + j.code;
    $('del-bot').textContent = j.botMxid; $('del-bot').href = j.matrixTo;
    setMsg('del-wait', '⏳ Warte auf deine Bestätigung per Matrix…');
    showDelStep(2); startDelPoll();
  } catch(e){ setMsg('del-msg', e.message, 'bad'); }
};
$('btn-copy-del').onclick = () => copyText($('del-cmd').textContent);
$('btn-del-cancel').onclick = async () => {
  resetDel();
  try { await api('/me/delete/cancel', {}); setMsg('del-msg', 'Löschung abgebrochen.', 'ok'); } catch(e){ setMsg('del-msg', e.message, 'bad'); }
};

// --- Werbung für den Matrix-Ankündigungsraum ---
let announceCfg = { enabled:false };
(async () => {
  try {
    const base = (typeof window.__BASE__ === 'string') ? window.__BASE__ : '';
    const r = await fetch(`${base}/api/announce`, { cache:'no-store' });
    announceCfg = await r.json();
  } catch(_) { return; }
  if (!announceCfg.enabled || !/^https:\/\//.test(announceCfg.link || '')) return;
  for (const [box, a] of [['announce-box','announce-link'], ['lobby-announce','lobby-announce-link']]) {
    $(a).href = announceCfg.link; $(a).textContent = announceCfg.room;
    $(box).classList.remove('hidden');
  }
})();

// --- Start: Konfiguration, Login-Link (?mlogin=…) ---
(async () => {
  try { acctCfg = await api('/config'); } catch(_) { acctCfg = { enabled:false }; }
  if (!acctCfg.enabled) return;
  $('acct-bar').classList.remove('hidden');
  $('btn-login-matrix').classList.toggle('hidden', !acctCfg.matrixLogin);
  const params = new URLSearchParams(location.search);
  const ml = params.get('mlogin');
  if (ml) {
    params.delete('mlogin');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    try { const j = await api('/login/matrix/redeem', { token: ml }); setAccount(j.user); reconnectWs(); toast('Angemeldet als ' + j.user.username + '.'); return; }
    catch(e){ toast('⚠ ' + e.message); }
  }
  try { const j = await api('/me'); setAccount(j.user); } catch(_) {}
})();
// Während der erzwungenen Neuverknüpfung auch „login“ aus einem neuen Chat erkennen
setInterval(async () => {
  if (!account || !account.needsRelink || rlToken) return;
  try { const j = await api('/me'); if (!j.user || !j.user.needsRelink) { setAccount(j.user); if (j.user) toast('Neuer Matrix-Chat verknüpft.'); } } catch(_) {}
}, 5000);

// ---------------------------------------------------------------- TTS: „Du bist dran“
// Sprachausgabe per Web Speech API, wenn der eigene Zug beginnt.
// Ein-/Ausschalter im Spiel-Header, Einstellung wird lokal gemerkt.
const TTS_KEY = 'portriga_tts';
const ttsSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let ttsOn = false;
try { ttsOn = ttsSupported && localStorage.getItem(TTS_KEY) === '1'; } catch (_) {}
let ttsLastKey = null;

function ttsUpdateBtn(){
  const b = $('btn-tts'); if (!b) return;
  b.classList.toggle('hidden', !ttsSupported);
  b.classList.toggle('on', ttsOn);
  b.textContent = ttsOn ? '🔊' : '🔇';
  b.title = ttsOn ? 'Sprachausgabe ausschalten' : 'Sprachausgabe einschalten';
  b.setAttribute('aria-pressed', ttsOn ? 'true' : 'false');
}
function ttsSpeak(text){
  if (!ttsOn || !ttsSupported) return;
  const en = window.PortrigaI18n && window.PortrigaI18n.lang === 'en';
  const msg = en && window.PortrigaI18n.t ? window.PortrigaI18n.t(text) : text;
  const u = new SpeechSynthesisUtterance(msg);
  u.lang = en ? 'en-US' : 'de-DE';
  const voice = speechSynthesis.getVoices().find(x => x.lang && x.lang.toLowerCase().startsWith(en ? 'en' : 'de'));
  if (voice) u.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function ttsOnTurn(v, me){
  const mine = (v.phase==='bidding' || v.phase==='playing') && v.turnIdx===me;
  // Schlüssel je Zug, damit Re-Renders nicht erneut sprechen
  const key = mine ? [v.phase, v.roundIndex, v.tricksPlayed, v.currentTrick.length].join('|') : null;
  if (key && key !== ttsLastKey){
    ttsSpeak(v.phase==='bidding' ? 'Du bist dran: Stiche ansagen' : 'Du bist dran: Karte spielen');
  }
  ttsLastKey = key;
}
if ($('btn-tts')){
  $('btn-tts').onclick = () => {
    ttsOn = !ttsOn;
    try { localStorage.setItem(TTS_KEY, ttsOn ? '1' : '0'); } catch (_) {}
    ttsUpdateBtn();
    if (ttsOn) ttsSpeak('Sprachausgabe eingeschaltet'); else if (ttsSupported) speechSynthesis.cancel();
  };
  ttsUpdateBtn();
}
