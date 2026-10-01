// STATISTIQUES DE JOUEUR, d'une soirée à l'autre — module pur, sans réseau ni
// base (la base est derrière une interface : store-pg.js, store-memory.js).
//
// ⚠️ LA SOURCE DE VÉRITÉ EST LE HUB. Une ligne de stats n'existe que parce que
// le Hub a ACCEPTÉ un classement (`results`, voir scores.js et hub.js →
// onResults) : jamais parce qu'un client la déclare. Le client ne fait que
// demander SES agrégats (`{ action: 'stats' }`), et ne peut rien écrire.
//
// L'IDENTITÉ : le player.id du profil local (`p_…`). Il n'est PAS secret (il
// part dans l'état public de chaque session) : il est donc accompagné d'une
// CLÉ, 32 à 64 caractères aléatoires qui ne quittent que le navigateur du
// joueur et ce serveur, où seule son empreinte (sha256) est gardée. Premier
// passage d'un id : l'empreinte est enregistrée ; ensuite, même id + autre clé
// = ni écriture ni lecture pour ce socket (on joue quand même).
//
// LES DÉFINITIONS (validées au lot H, portfolio, 2026-09-30) :
//   partie   une partie CLASSÉE par le Hub où le joueur a une place (solo compris) ;
//   solo     une partie à un seul classé ;
//   victoire rang 1 ET au moins un classé derrière soi — un solo n'en est pas
//            une, un nul du Morpion (1 / 1) non plus ; ex æquo 1, 1, 3 : deux ;
//   podium   rang ≤ 3 dans une partie à 2 classés ou plus ;
//   meilleure place  le plus petit rang, parties à 2 classés ou plus ;
//   points   les points de soirée de la partie (scores.js), gardés, pas affichés.
// Le RANG est celui du jeu, tel que le Hub l'a reçu : aucun classement n'est
// recalculé ici (ex æquo compris).
'use strict';

const crypto = require('node:crypto');
const { sessionPoints } = require('./scores.js');

const KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;
const readKey = (k) => (typeof k === 'string' && KEY_RE.test(k) ? k : null);
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

// Les lignes à enregistrer pour une partie que le Hub vient d'accepter.
// `rows` = le classement relu (scores.readResults), `seats` = les places
// déclarées par chacun (launch.seats), `verified(playerId)` = la clé de ce
// joueur a été vérifiée. ⚠️ Un joueur PARTI de la session compte : il a joué,
// sa place le prouve (choix du lot H) — c'est la seule différence avec le
// score de soirée, qui ne crédite que les présents.
function playsFor(rows, seats, verified) {
  const n = rows.length;
  const parSiege = {};
  for (const id of Object.keys(seats || {})) parSiege[seats[id]] = id;
  const out = [];
  for (const r of rows) {
    const playerId = parSiege[r.seat];
    if (!playerId || !verified(playerId)) continue;
    out.push({
      playerId,
      rank: r.rank,
      ranked: n,
      behind: rows.filter((x) => x.rank > r.rank).length,
      points: sessionPoints(r.rank, n),
    });
  }
  return out;
}

// Une partie vue par les définitions : les mêmes règles pour le stockage en
// mémoire (ici) et pour Postgres (store-pg.js, en SQL — tests/test-stats.js
// vérifie que les deux disent la même chose).
const isSolo = (p) => p.ranked === 1;
const isWin = (p) => p.rank === 1 && p.behind > 0;
const isPodium = (p) => p.rank <= 3 && p.ranked >= 2;

// Agrégats par jeu, à partir des parties d'UN joueur.
function perGame(plays) {
  const par = {};
  for (const p of plays) {
    const g = par[p.gameId] || (par[p.gameId] = { gameId: p.gameId, played: 0, solo: 0, wins: 0, podiums: 0, best: null, points: 0 });
    g.played++;
    if (isSolo(p)) g.solo++;
    if (isWin(p)) g.wins++;
    if (isPodium(p)) g.podiums++;
    if (!isSolo(p) && (g.best == null || p.rank < g.best)) g.best = p.rank;
    g.points += p.points;
  }
  return Object.values(par);
}

// Le total, à partir des agrégats par jeu. Aucune partie : des zéros ici, mais
// le client montre « Aucune partie jouée », pas une rangée de zéros.
function summarize(games) {
  const jeux = (games || []).filter((g) => g && g.played > 0)
    .sort((a, b) => b.played - a.played || (a.gameId < b.gameId ? -1 : 1));
  if (!jeux.length) return { played: 0, solo: 0, wins: 0, podiums: 0, best: null, games: [], records: null };
  const somme = (k) => jeux.reduce((s, g) => s + g[k], 0);
  const bests = jeux.map((g) => g.best).filter((b) => b != null);
  const s = {
    played: somme('played'), solo: somme('solo'), wins: somme('wins'), podiums: somme('podiums'),
    best: bests.length ? Math.min(...bests) : null,
    games: jeux.map((g) => ({ gameId: g.gameId, played: g.played, solo: g.solo, wins: g.wins, podiums: g.podiums, best: g.best })),
  };
  s.records = records(s);
  return s;
}

// RECORDS PERSONNELS (lot I, portfolio, 2026-10-01) — dérivés du résumé
// ci-dessus, donc des MÊMES lignes et des MÊMES définitions : aucune table,
// aucune requête de plus, et mémoire = Postgres par construction.
//   best        meilleure place à plusieurs (= résumé ; null : que du solo) ;
//   wins        victoires (= résumé ; null tant qu'il n'y en a aucune) ;
//   mostPlayed  { games, played } : le(s) jeu(x) le(s) plus joué(s), solo compris ;
//   mostWins    { games, wins } : le(s) jeu(x) aux plus de victoires (null : aucune).
// ⚠️ ÉGALITÉ = TOUS les jeux à égalité dans `games` (ordre du résumé : le plus
// joué, puis l'id) : on ne départage jamais. Un record absent vaut null — le
// client ne montre pas « 0 victoire » comme un record. `null` en entier :
// aucune partie.
function records(s) {
  if (!s || !s.played) return null;
  const tete = (k) => {
    const max = Math.max(...s.games.map((g) => g[k]));
    return max > 0 ? { games: s.games.filter((g) => g[k] === max).map((g) => g.gameId), [k]: max } : null;
  };
  return { best: s.best, wins: s.wins || null, mostPlayed: tete('played'), mostWins: tete('wins') };
}

module.exports = { KEY_RE, readKey, hashKey, playsFor, perGame, summarize, records, isSolo, isWin, isPodium };
