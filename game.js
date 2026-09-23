'use strict';

/*
 * Portriga – Regel-Engine (server-autoritativ, kein State im Client)
 * Quelle der Regeln: http://portriga.bplaced.net/
 *
 * ANNAHMEN (per Regelseite nicht 100% eindeutig, hier in je 1 Zeile änderbar):
 *  - RANKS: Karten-Wertigkeit exakt in der auf der Seite gezeigten Bildreihenfolge
 *           (Ass am höchsten). Falls das nur Anzeige war -> diese Zeile umsortieren.
 *  - Trumpfzwang: Bedienen wenn möglich, sonst Trumpf spielen wenn vorhanden, sonst frei.
 */

// Farben: Kreuz, Pik, Herz, Karo
const SUITS = [
  { id: 'kreuz', sym: '♣', color: 'black' },
  { id: 'pik',   sym: '♠', color: 'black' },
  { id: 'herz',  sym: '♥', color: 'red'   },
  { id: 'karo',  sym: '♦', color: 'red'   },
];

// Wertigkeit hoch -> niedrig, exakt wie auf der Regelseite abgebildet.
// ANNAHME (siehe oben). Zur Laufzeit über config.json (game.ranks) / setRanks() änderbar.
let RANKS = ['A', '7', 'K', 'D', 'B', '10', '9', '8'];

// Überschreibt die Kartenwertigkeit prozessweit (z.B. aus config.json).
// Es müssen genau 8 eindeutige Rang-Bezeichner sein, sonst stimmt die Deckgröße (8*4*2=64) nicht.
function setRanks(arr) {
  if (!Array.isArray(arr) || arr.length !== 8 || new Set(arr).size !== 8) {
    throw new Error('ranks muss genau 8 eindeutige Werte enthalten.');
  }
  RANKS = arr.map(String);
}

function rankStrength(rank) {
  // vorne = stark. A -> RANKS.length, ... letzter -> 1
  return RANKS.length - RANKS.indexOf(rank);
}

function buildDeck() {
  // 2 Skatblätter = 64 Karten (jede Karte doppelt)
  const deck = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ id: `${s.id}-${r}-${copy}`, suit: s.id, rank: r });
      }
    }
  }
  return deck;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Rundenfolge der Kartenanzahl pro Spieler.
 * 1..7 aufsteigend, dann 8 genau N-mal, dann 7..1 absteigend.
 * (Regel: "steigt bis 8; die 8 wird so oft gespielt wie es Spieler gibt;
 *  anschließend absteigend, letzte Runde wieder 1 Karte".)
 */
function buildRoundPlan(numPlayers) {
  const plan = [];
  for (let c = 1; c <= 7; c++) plan.push(c);
  for (let i = 0; i < numPlayers; i++) plan.push(8);
  for (let c = 7; c >= 1; c--) plan.push(c);
  return plan;
}

/**
 * Vergleichszahl einer Karte im aktuellen Stich.
 * Trumpf schlägt Nicht-Trumpf; nur bedienende oder Trumpf-Karten können stechen.
 */
function trickScore(card, ledSuit, trumpSuit) {
  const isTrump = card.suit === trumpSuit;
  const follows = card.suit === ledSuit;
  if (isTrump) return 200 + rankStrength(card.rank);
  if (follows) return 100 + rankStrength(card.rank);
  return 0; // weder Trumpf noch bedient -> kann nicht gewinnen
}

class Game {
  /**
   * @param {Array<{id:string,name:string,bot?:boolean}>} players Reihenfolge = Sitzordnung
   * @param {object} [opts] { rng }
   */
  constructor(players, opts = {}) {
    if (players.length < 2 || players.length > 7) {
      throw new Error('Spieleranzahl muss 2–7 betragen.');
    }
    this.rng = opts.rng || Math.random;
    this.players = players.map(p => ({
      id: p.id, name: p.name, bot: !!p.bot,
      hand: [], bid: null, tricks: 0, score: 0,
    }));
    this.roundPlan = buildRoundPlan(this.players.length);
    this.roundIndex = -1;
    this.phase = 'lobby'; // lobby | bidding | playing | roundEnd | gameEnd
    this.trumpCard = null;
    this.trumpSuit = null;
    this.currentTrick = [];   // [{playerIdx, card}]
    this.turnIdx = null;      // Index des Spielers, der dran ist
    this.leaderIdx = null;    // wer den aktuellen Stich eröffnet hat
    this.dealerIdx = null;
    this.tricksTotal = 0;     // Stiche in dieser Runde (= Kartenanzahl)
    this.tricksPlayed = 0;
    this.lastTrick = null;    // zur Anzeige des letzten abgeschlossenen Stichs
    this.log = [];
  }

  get numPlayers() { return this.players.length; }
  get cardsThisRound() { return this.roundPlan[this.roundIndex]; }
  get isLastRound() { return this.roundIndex >= this.roundPlan.length - 1; }

  start() {
    if (this.phase !== 'lobby') throw new Error('Spiel läuft bereits.');
    this._startNextRound();
  }

  _startNextRound() {
    this.roundIndex++;
    const n = this.numPlayers;
    const count = this.cardsThisRound;
    this.dealerIdx = this.roundIndex % n;

    // austeilen
    const deck = shuffle(buildDeck(), this.rng);
    let k = 0;
    for (const p of this.players) {
      p.hand = deck.slice(k, k + count).sort(sortHand);
      k += count;
      p.bid = null;
      p.tricks = 0;
    }
    // Trumpf aufdecken
    this.trumpCard = deck[k] || null;
    this.trumpSuit = this.trumpCard ? this.trumpCard.suit : null;

    this.tricksTotal = count;
    this.tricksPlayed = 0;
    this.currentTrick = [];
    this.lastTrick = null;
    // Ansage beginnt links vom Geber, Geber zuletzt
    this.turnIdx = (this.dealerIdx + 1) % n;
    this.leaderIdx = this.turnIdx; // wer zuerst ansagt, spielt zuerst aus
    this.phase = 'bidding';
    this.log.push(`Runde ${this.roundIndex + 1}: ${count} Karte(n), Trumpf ${this.trumpSuit || '—'}.`);
  }

  // ---- Ansage ----
  placeBid(playerId, bid) {
    if (this.phase !== 'bidding') throw new Error('Gerade keine Ansage.');
    const idx = this._idx(playerId);
    if (idx !== this.turnIdx) throw new Error('Du bist nicht an der Reihe.');
    if (!Number.isInteger(bid) || bid < 0 || bid > this.cardsThisRound) {
      throw new Error(`Ansage muss 0–${this.cardsThisRound} sein.`);
    }
    this.players[idx].bid = bid;
    // nächster Ansager
    if (this._allBidsPlaced()) {
      this.phase = 'playing';
      this.turnIdx = this.leaderIdx;
    } else {
      this.turnIdx = (this.turnIdx + 1) % this.numPlayers;
    }
  }

  _allBidsPlaced() { return this.players.every(p => p.bid !== null); }

  // ---- Karten legen ----
  legalCards(playerId) {
    const idx = this._idx(playerId);
    const p = this.players[idx];
    if (this.phase !== 'playing' || idx !== this.turnIdx) return [];
    if (this.currentTrick.length === 0) return p.hand.slice(); // Anspiel = frei
    const ledSuit = this.currentTrick[0].card.suit;
    const hasLed = p.hand.some(c => c.suit === ledSuit);
    if (hasLed) return p.hand.filter(c => c.suit === ledSuit); // Bedienzwang
    const hasTrump = p.hand.some(c => c.suit === this.trumpSuit);
    if (hasTrump) return p.hand.filter(c => c.suit === this.trumpSuit); // Trumpfzwang
    return p.hand.slice(); // frei
  }

  playCard(playerId, cardId) {
    if (this.phase !== 'playing') throw new Error('Gerade wird nicht gespielt.');
    const idx = this._idx(playerId);
    if (idx !== this.turnIdx) throw new Error('Du bist nicht an der Reihe.');
    const legal = this.legalCards(playerId);
    const card = legal.find(c => c.id === cardId);
    if (!card) throw new Error('Karte nicht erlaubt (Bedien-/Trumpfzwang) oder nicht in der Hand.');

    const p = this.players[idx];
    p.hand = p.hand.filter(c => c.id !== cardId);
    this.currentTrick.push({ playerIdx: idx, card });

    if (this.currentTrick.length === this.numPlayers) {
      this._resolveTrick();
    } else {
      this.turnIdx = (this.turnIdx + 1) % this.numPlayers;
    }
  }

  _resolveTrick() {
    const ledSuit = this.currentTrick[0].card.suit;
    let best = null;
    // ">= " sorgt für "der 2. übersticht den 1.": bei Gleichstand gewinnt der SPÄTER gelegte.
    for (const play of this.currentTrick) {
      const s = trickScore(play.card, ledSuit, this.trumpSuit);
      if (best === null || s >= best.score) best = { play, score: s };
    }
    const winnerIdx = best.play.playerIdx;
    this.players[winnerIdx].tricks++;
    this.tricksPlayed++;
    this.lastTrick = {
      cards: this.currentTrick.map(t => ({ playerIdx: t.playerIdx, card: t.card })),
      winnerIdx,
      ledSuit,
    };
    this.currentTrick = [];

    if (this.tricksPlayed >= this.tricksTotal) {
      this._scoreRound();
    } else {
      this.turnIdx = winnerIdx;   // Stichgewinner spielt aus
      this.leaderIdx = winnerIdx;
    }
  }

  _scoreRound() {
    for (const p of this.players) {
      if (p.bid === p.tricks) {
        p.score += 10 + p.tricks * 3; // korrekt: 10 + Stiche*3 (auch bei 0)
      } else {
        p.score -= Math.abs(p.bid - p.tricks) * 3; // Differenz * 3 Minuspunkte
      }
    }
    if (this.isLastRound) {
      this.phase = 'gameEnd';
    } else {
      this.phase = 'roundEnd';
    }
  }

  /** Nach 'roundEnd' die nächste Runde starten (vom Server/Host ausgelöst). */
  nextRound() {
    if (this.phase !== 'roundEnd') throw new Error('Runde noch nicht beendet.');
    this._startNextRound();
  }

  standings() {
    return this.players
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  _idx(playerId) {
    const i = this.players.findIndex(p => p.id === playerId);
    if (i === -1) throw new Error('Unbekannter Spieler.');
    return i;
  }

  /**
   * Personalisierte, redigierte Sicht: nur die eigene Hand ist sichtbar,
   * von den anderen nur die Kartenanzahl. Verhindert Cheating.
   */
  viewFor(playerId) {
    const meIdx = this.players.findIndex(p => p.id === playerId);
    return {
      phase: this.phase,
      roundIndex: this.roundIndex,
      roundNumber: this.roundIndex + 1,
      totalRounds: this.roundPlan.length,
      cardsThisRound: this.phase === 'lobby' ? null : this.cardsThisRound,
      trumpCard: this.trumpCard,
      trumpSuit: this.trumpSuit,
      dealerIdx: this.dealerIdx,
      turnIdx: this.turnIdx,
      leaderIdx: this.leaderIdx,
      tricksTotal: this.tricksTotal,
      tricksPlayed: this.tricksPlayed,
      currentTrick: this.currentTrick.map(t => ({ playerIdx: t.playerIdx, card: t.card })),
      lastTrick: this.lastTrick,
      meIdx,
      myHand: meIdx >= 0 ? this.players[meIdx].hand : [],
      myLegal: (meIdx >= 0 && this.phase === 'playing') ? this.legalCards(playerId).map(c => c.id) : [],
      players: this.players.map((p, i) => ({
        idx: i, id: p.id, name: p.name, bot: p.bot,
        handCount: p.hand.length,
        bid: p.bid,
        tricks: p.tricks,
        score: p.score,
        isDealer: i === this.dealerIdx,
        isTurn: i === this.turnIdx,
      })),
      log: this.log.slice(-12),
    };
  }
}

function sortHand(a, b) {
  const sa = SUITS.findIndex(s => s.id === a.suit);
  const sb = SUITS.findIndex(s => s.id === b.suit);
  if (sa !== sb) return sa - sb;
  return rankStrength(b.rank) - rankStrength(a.rank);
}

module.exports = { Game, buildDeck, buildRoundPlan, trickScore, rankStrength, setRanks, SUITS, RANKS };
