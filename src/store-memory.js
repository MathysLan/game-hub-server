// Stockage des statistiques EN MÉMOIRE : même interface que store-pg.js.
// Pour les tests et le développement local (HUB_STATS=memory) — jamais pour la
// production : tout disparaît au redémarrage, comme les sessions.
//
// `options.down()` : rend vrai pour simuler une base injoignable (tests).
'use strict';

const { perGame } = require('./stats.js');

function createMemoryStore(options = {}) {
  const players = new Map();   // playerId → empreinte de la clé
  const plays = new Map();     // `drawId/playerId` → partie
  const panne = () => { if (options.down && options.down()) throw new Error('stockage injoignable (simulé)'); };
  return {
    kind: 'memory',
    // 'new' (premier passage), 'ok' (même clé), 'mismatch' (autre clé).
    async register(playerId, keyHash) {
      panne();
      const h = players.get(playerId);
      if (!h) { players.set(playerId, keyHash); return 'new'; }
      return h === keyHash ? 'ok' : 'mismatch';
    },
    // Idempotent : une partie (drawId) ne compte qu'une fois par joueur.
    // Rend le nombre de lignes réellement ajoutées.
    async record(drawId, sessionCode, gameId, list) {
      panne();
      let n = 0;
      for (const p of list) {
        const k = drawId + '/' + p.playerId;
        if (plays.has(k) || !players.has(p.playerId)) continue;
        plays.set(k, { drawId, sessionCode, gameId, playerId: p.playerId, rank: p.rank, ranked: p.ranked, behind: p.behind, points: p.points });
        n++;
      }
      return n;
    },
    async perGame(playerId) {
      panne();
      return perGame([...plays.values()].filter((p) => p.playerId === playerId));
    },
    async close() {},
    // Tests seulement.
    _size: () => plays.size,
  };
}

module.exports = { createMemoryStore };
