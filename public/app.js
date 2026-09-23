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
    case 'joined':
      hostId = null; enterRoomUI(); show('lobby'); break;
    case 'state':
      if (m.hostId) hostId = m.hostId;
      enterRoomUI();
      if (m.lobby) renderLobby(m); else { lastState = m; renderGame(m); }
      renderVote(m.lobby ? 'lobby-vote' : 'ov-vote', m.vote || null);
      if (m.lobby) $('btn-start').disabled = !!m.vote;
      break;
    case 'rtcConfig': if (m.iceServers) rtcConfig = { iceServers: m.iceServers }; break;
    case 'voice': onVoiceMembers(m.members || []); break;
    case 'rtc-signal': onSignal(m.from, m.data); break;
    case 'chatHistory': renderChatHistory(m.messages || []); break;
    case 'chat': addChatMsg(m.msg); break;
    case 'toast': toast(m.message); break;
    case 'error': toast('⚠ ' + m.message); break;
    case 'roomClosed': toast(m.reason || 'Raum geschlossen'); exitRoomUI(); leaveChatUI(); show('home'); break;
    case 'left': exitRoomUI(); leaveChatUI(); show('home'); break;
  }
}

// ---------- Screens ----------
function show(name){
  for (const s of ['home','lobby','game']) $('screen-'+s).classList.toggle('hidden', s!==name);
}

// ---------- Home ----------
$('btn-create').onclick = () => { saveName(); send({ type:'createRoom', name: myName }); };
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
function saveName(){ myName = ($('name').value.trim() || 'Spieler').slice(0,20); localStorage.setItem('portriga_name', myName); }

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
  const ul = $('seat-list'); ul.innerHTML = '';
  m.seats.forEach(s => {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot' + (s.connected?'':' off');
    li.appendChild(dot);
    const nm = document.createElement('span'); nm.textContent = s.name + (s.id===clientId?' (du)':''); li.appendChild(nm);
    if (s.bot) { const b=document.createElement('span'); b.className='tag bot'; b.textContent='Bot'; li.appendChild(b); }
    if (s.id===m.hostId){ const h=document.createElement('span'); h.className='tag'; h.textContent='Host'; li.appendChild(h); }
    ul.appendChild(li);
  });
  $('lobby-hint').textContent = isHost
    ? (m.seats.length<2 ? `Warte auf Mitspieler oder füge Bots hinzu (2–${m.maxPlayers||7}).`
       : m.seats.length>7 ? `Bereit – ${m.seats.length} Spieler: alternative Variante (max. ${Math.min(8,Math.floor(63/m.seats.length))} Karten pro Runde).`
       : 'Bereit – du kannst starten.')
    : 'Warte auf den Host…';
}
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
function exitRoomUI(){ renderVote('lobby-vote', null); setFab(false); $('voice').classList.add('hidden'); voiceLeave(true); }

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
  el.className='vc'+(speaking?' speaking':'')+(isMuted?' muted':'');
  el.innerHTML=`<span class="ring"></span><span class="nm">${escapeHtml(name)}</span><span class="st">${escapeHtml(right||'')}</span>`;
  return el;
}
function renderVoiceList(){
  const box=$('voice-list'); if(!box) return; box.innerHTML='';
  if (voiceJoined) box.appendChild(voiceRow('me', 'Du', muted, localSpeaking, muted?'stumm':''));
  for (const m of voiceRoster){
    if (m.id===clientId) continue;
    const p=peers.get(m.id);
    box.appendChild(voiceRow(m.id, m.name, false, p?p.speaking:false, p?stateLabel(p.pc.connectionState):'…'));
  }
}

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
