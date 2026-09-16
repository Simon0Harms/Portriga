'use strict';
/*
 * Sehr einfacher Platzhalter-Bot (bewusst simpel gehalten).
 * Zweck: Alleine testen können + Sitze auffüllen. KEINE starke KI.
 * Saubere Naht zum späteren Ersetzen durch echte Strategie.
 */
const { rankStrength } = require('./game');

function botBid(game, playerIdx) {
  const p = game.players[playerIdx];
  // grobe Heuristik: zähle "starke" Karten (Stärke >= 6) + Trümpfe
  let est = 0;
  for (const c of p.hand) {
    const strong = rankStrength(c.rank) >= 6;
    const trump = c.suit === game.trumpSuit;
    if (trump && strong) est += 1;
    else if (trump || strong) est += 0.5;
  }
  return Math.max(0, Math.min(game.cardsThisRound, Math.round(est)));
}

function botCardId(game, playerId) {
  const legal = game.legalCards(playerId);
  if (legal.length === 0) return null;
  // simpel: zufällige legale Karte
  return legal[Math.floor(Math.random() * legal.length)].id;
}

module.exports = { botBid, botCardId };
