'use strict';
/* Kopflose Simulation: spielt komplette Spiele nur mit Bots durch.
 * Prüft, dass Phasen, Züge, Stiche und Wertung ohne Crash durchlaufen
 * und die Rundenanzahl stimmt. Kein Beweis für Regel-Korrektheit,
 * aber fängt Logik-/Absturzfehler zuverlässig ab. */
const assert = require('assert');
const { Game, buildRoundPlan } = require('../game');
const { botBid, botCardId } = require('../bots');

function playOneGame(n) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Bot${i}`, bot: true }));
  const g = new Game(players);
  g.start();
  let guard = 0;
  while (g.phase !== 'gameEnd') {
    assert(guard++ < 100000, 'Endlosschleife?');
    if (g.phase === 'bidding') {
      const p = g.players[g.turnIdx];
      g.placeBid(p.id, botBid(g, g.turnIdx));
    } else if (g.phase === 'playing') {
      const p = g.players[g.turnIdx];
      const cid = botCardId(g, p.id);
      assert(cid, `Kein legaler Zug für ${p.id} (Hand=${p.hand.length})`);
      g.playCard(p.id, cid);
    } else if (g.phase === 'roundEnd') {
      // Wertungsplausibilität: Summe der Stiche == Kartenanzahl
      const sumTricks = g.players.reduce((a, p) => a + p.tricks, 0);
      assert.strictEqual(sumTricks, g.tricksTotal,
        `Stichsumme ${sumTricks} != ${g.tricksTotal}`);
      g.nextRound();
    }
  }
  // erwartete Rundenzahl
  assert.strictEqual(g.roundIndex + 1, buildRoundPlan(n).length, 'Rundenzahl falsch');
  return g.standings();
}

for (let n = 2; n <= 7; n++) {
  for (let rep = 0; rep < 200; rep++) {
    const st = playOneGame(n);
    assert(st.length === n);
  }
  console.log(`OK: ${n} Spieler – 200 Spiele fehlerfrei. Beispiel-Endstand:`,
    playOneGame(n).map(s => `${s.name}:${s.score}`).join('  '));
}
console.log('\nAlle Simulationen bestanden.');
