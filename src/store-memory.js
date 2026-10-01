// Stockage des statistiques EN MÉMOIRE : même interface que store-pg.js.
// Pour les tests et le développement local (HUB_STATS=memory) — jamais pour la
// production : tout disparaît au redémarrage, comme les sessions.
//
// `options.down()` : rend vrai pour simuler une base injoignable (tests).
// `options.now()`  : l'horloge des parties (tests : Oiseau de nuit, soirées).
'use strict';

const { perGame } = require('./stats.js');

function createMemoryStore(options = {}) {
  const players = new Map();   // playerId → empreinte de la clé
  const plays = new Map();     // `drawId/playerId` → partie
  const succes = new Map();    // `playerId/code` → { code, unlockedAt, drawId, notifiedAt }
  const now = options.now || Date.now;
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
      const at = now();
      for (const p of list) {
        const k = drawId + '/' + p.playerId;
        if (plays.has(k) || !players.has(p.playerId)) continue;
        plays.set(k, { drawId, sessionCode, gameId, playerId: p.playerId, rank: p.rank, ranked: p.ranked, behind: p.behind, points: p.points, at });
        n++;
      }
      return n;
    },
    async perGame(playerId) {
      panne();
      return perGame([...plays.values()].filter((p) => p.playerId === playerId));
    },
    // ── Succès (lot J) — mêmes contrats que store-pg.js ──
    // Les parties d'un joueur, pour le rejeu (achievements.js trie lui-même).
    async plays(playerId) {
      panne();
      return [...plays.values()].filter((p) => p.playerId === playerId)
        .map((p) => ({ drawId: p.drawId, sessionCode: p.sessionCode, gameId: p.gameId, rank: p.rank, ranked: p.ranked, behind: p.behind, at: p.at }));
    },
    // Rend les codes RÉELLEMENT ajoutés : un succès ne s'insère qu'une fois.
    // `silent` : déjà notifié (rattrapage : jamais de notification rétroactive).
    async unlock(playerId, list, silent = false) {
      panne();
      const neufs = [];
      if (!players.has(playerId)) return neufs;
      for (const u of list) {
        const k = playerId + '/' + u.code;
        if (succes.has(k)) continue;
        succes.set(k, { code: u.code, unlockedAt: u.at, drawId: u.drawId, notifiedAt: silent ? u.at : null });
        neufs.push(u.code);
      }
      return neufs;
    },
    async achievements(playerId) {
      panne();
      return [...succes.entries()].filter(([k]) => k.startsWith(playerId + '/')).map(([, v]) => ({ ...v }));
    },
    // Notification montrée : seulement des lignes existantes, pas encore notifiées.
    async markSeen(playerId, codes) {
      panne();
      const faits = [];
      for (const c of codes) {
        const s = succes.get(playerId + '/' + c);
        if (s && s.notifiedAt == null) { s.notifiedAt = now(); faits.push(c); }
      }
      return faits;
    },
    async close() {},
    // Tests seulement.
    _size: () => plays.size,
  };
}

module.exports = { createMemoryStore };
