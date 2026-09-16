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

let ws, wsReady = false, lastState = null, myId = clientId, hostId = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { wsReady = true; sendRaw({ type:'hello', clientId, name: myName || 'Spieler' }); };
  ws.onclose = () => { wsReady = false; toast('Verbindung getrennt – neu verbinden…'); setTimeout(connect, 1500); };
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
}
function sendRaw(m){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function send(m){ sendRaw(m); }

function onMessage(m){
  switch(m.type){
    case 'ready': break;
    case 'joined':
      hostId = null; show('lobby'); break;
    case 'state':
      if (m.hostId) hostId = m.hostId;
      if (m.lobby) renderLobby(m); else { lastState = m; renderGame(m); }
      break;
    case 'toast': toast(m.message); break;
    case 'error': toast('⚠ ' + m.message); break;
    case 'roomClosed': toast(m.reason || 'Raum geschlossen'); show('home'); break;
    case 'left': show('home'); break;
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
function saveName(){ myName = ($('name').value.trim() || 'Spieler').slice(0,20); localStorage.setItem('portriga_name', myName); }

// ---------- Lobby ----------
function renderLobby(m){
  show('lobby');
  $('lobby-code').textContent = m.code;
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
    ? (m.seats.length<2 ? 'Warte auf Mitspieler oder füge Bots hinzu (2–7).' : 'Bereit – du kannst starten.')
    : 'Warte auf den Host…';
}
$('btn-addbot').onclick = () => send({ type:'addBot' });
$('btn-rmbot').onclick = () => send({ type:'removeBot' });
$('btn-start').onclick = () => send({ type:'startGame' });
$('btn-leave-lobby').onclick = () => send({ type:'leaveRoom' });
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

  // aktueller Stich
  const tc = $('trick-cards'); tc.innerHTML='';
  v.currentTrick.forEach(pl => {
    tc.appendChild(cardEl(pl.card, { who: players[pl.playerIdx].name }));
  });
  // letzter Stich
  const lt = $('last-trick');
  if (v.lastTrick && v.currentTrick.length===0){
    lt.textContent = `Letzter Stich → ${players[v.lastTrick.winnerIdx].name}`;
  } else lt.textContent='';

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
      li.innerHTML=`<span>${i+1}. ${escapeHtml(p.name)}${p.bot?' 🤖':''} <span class="hint">(Ansage ${p.bid==null?'–':p.bid}, ${p.tricks} Stiche)</span></span><span class="sc">${p.score}</span>`;
      sc.appendChild(li);
    });
    $('ov-next').classList.toggle('hidden', v.phase!=='roundEnd');
    $('ov-home').classList.toggle('hidden', v.phase!=='gameEnd');
  } else ov.classList.add('hidden');
}
$('ov-next').onclick = () => send({ type:'nextRound' });
$('ov-home').onclick = () => { send({ type:'leaveRoom' }); };

// ---------- Utils ----------
let toastTimer;
function toast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.add('hidden'),2600);
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

connect();
