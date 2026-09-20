// Le moteur de tirage : QUI peut jouer à QUOI, et avec quelle chance.
//
// Module PUR : ni réseau, ni horloge, ni hasard caché. On lui passe une
// session et le catalogue (le manifest) ; il rend une réponse. Le hasard est
// injecté (`rand`), ce qui rend chaque tirage rejouable dans un test.
//
// Trois étapes, dans cet ordre, et jamais mélangées :
//
//   1. FILTRER   — un jeu impossible pour CE groupe sort de la liste
//                  (nombre de joueurs, mode, capacités, veto, durée).
//   2. PONDÉRER  — parmi les jeux possibles, un cœur penche, la récence freine.
//   3. TIRER     — au hasard, selon les poids.
//
// ⚠️ LA SANTÉ DES SERVEURS N'EST PAS DANS CE MODULE. Elle ne dit pas si un jeu
// convient au groupe, seulement si son serveur est réveillé — et sur Render, un
// serveur endormi met ~20 s à répondre. La vérifier pour les sept jeux avant de
// tirer réveillait tout le parc et pouvait écarter des jeux parfaitement
// valables (constaté en production). Le Hub vérifie donc UNIQUEMENT le serveur
// du candidat tiré, après le tirage (hub.js → onDraw).
//
// ⚠️ Un veto EXCLUT, un cœur PENCHE. `love` n'entre jamais dans le filtre, et
// un veto n'est jamais un simple malus : personne ne se fait imposer un jeu.
// ⚠️ La récence RÉDUIT la chance d'un jeu déjà joué, elle ne l'interdit pas :
// à deux jeux possibles, un groupe alternerait sinon mécaniquement.
//
// Ce module ne connaît aucune règle de jeu. Il ne lit que le manifest, dont il
// respecte les valeurs telles quelles (players.min/max, minutes.max, needs,
// mode) — il n'en invente aucune.
'use strict';

// Un cœur ajoute la moitié du poids d'un jeu neutre. Trois cœurs sur cinq
// joueurs donnent 2,5× : assez pour se sentir écouté, pas assez pour que la
// caisse devienne une formalité. (Valeur du design review, section I.)
const LOVE_BONUS = 0.5;

// Facteur de récence selon l'ancienneté du DERNIER passage du jeu :
// tiré au tirage précédent → ×0,15 ; deux tirages avant → ×0,4 ; trois → ×0,7 ;
// au-delà → ×1. Jamais zéro : c'est un frein, pas une interdiction.
const RECENCY = [0.15, 0.4, 0.7];

// Les capacités qu'un joueur peut déclarer. Même vocabulaire fermé que le
// manifest (tools/build.mjs, NEEDS).
const CAPS = ['mic', 'cam', 'consent'];

const has = (arr, v) => Array.isArray(arr) && arr.includes(v);

// Ancienneté du dernier passage d'un jeu : 1 = le tirage précédent, 2 = celui
// d'avant… 0 = jamais joué dans cette session.
function ago(gameId, played) {
  const list = Array.isArray(played) ? played : [];
  const i = list.lastIndexOf(gameId);
  return i < 0 ? 0 : list.length - i;
}

function recency(gameId, played) {
  const a = ago(gameId, played);
  return a === 0 ? 1 : (RECENCY[a - 1] == null ? 1 : RECENCY[a - 1]);
}

// ── 1. FILTRE ─────────────────────────────────────────────────────────────
// Toutes les raisons qui écartent un jeu, pas seulement la première : l'écran
// doit pouvoir dire « il faut 3 joueurs ET Léa l'a mis en veto ». Liste vide =
// le jeu est possible.
//
function reasons(game, session) {
  const players = session.players || [];
  const n = players.length;
  const out = [];

  if (game.mode === 'local') {
    // Un jeu local tourne dans UN navigateur : il n'a de sens qu'en solo.
    if (n > 1) out.push({ code: 'LOCAL_ONLY', count: n });
  } else if (game.mode !== 'online') {
    out.push({ code: 'BAD_MODE' });
  }

  if (n < game.players.min) out.push({ code: 'TOO_FEW', min: game.players.min, count: n });
  if (n > game.players.max) out.push({ code: 'TOO_MANY', max: game.players.max, count: n });

  // Une capacité doit être déclarée par TOUS : un seul joueur sans micro rend
  // Imitation impossible. Absente = non déclarée = false : on ne suppose
  // jamais une capacité.
  for (const need of game.needs || []) {
    const sans = players.filter((p) => !(p.caps && p.caps[need] === true)).map((p) => p.id);
    if (sans.length) out.push({ code: 'NEEDS', need, players: sans });
  }

  // Le veto d'UN joueur suffit, et personne ne peut le lever à sa place.
  const vetos = players.filter((p) => has(p.veto, game.id)).map((p) => p.id);
  if (vetos.length) out.push({ code: 'VETO', players: vetos });

  // La durée compare le MAX de la fourchette (règle 2 du manifest) : un
  // « ≤ 10 min » écarte un jeu qui peut durer 15.
  const limit = session.constraints && session.constraints.maxMinutes;
  if (limit && game.minutes.max > limit) out.push({ code: 'TOO_LONG', max: game.minutes.max, limit });

  return out;
}

// ── 2. POIDS ──────────────────────────────────────────────────────────────
function weight(game, session) {
  const players = session.players || [];
  const loves = players.filter((p) => has(p.love, game.id)).length;
  const played = session.history && session.history.played;
  const w = (1 + LOVE_BONUS * loves) * recency(game.id, played);
  return Math.round(w * 10000) / 10000;
}

// Le catalogue entier évalué pour une session : ce que le salon affiche en
// permanence, et ce que le tirage relit au moment de tirer.
// `exclure` : des jeux écartés POUR CE TIRAGE seulement (un serveur qui n'a pas
// répondu). Ils n'entrent ni dans la liste ni dans les poids, mais rien n'est
// retenu contre eux au tirage suivant.
function evaluate(session, games, opts = {}) {
  const exclure = opts.exclure || [];
  const out = { games: [], eligible: [], why: {}, weights: {} };
  for (const g of games || []) {
    out.games.push(g.id);
    const r = exclure.includes(g.id) ? [{ code: 'SERVER_DOWN' }] : reasons(g, session);
    if (r.length) { out.why[g.id] = r; continue; }
    out.eligible.push(g.id);
    out.weights[g.id] = weight(g, session);
  }
  return out;
}

// ── 3. TIRAGE ─────────────────────────────────────────────────────────────
// `rand` renvoie un réel dans [0, 1). Le serveur passe un hasard
// cryptographique ; un test passe une suite fixée.
function pickWeighted(ids, weights, rand) {
  const total = ids.reduce((s, id) => s + (weights[id] > 0 ? weights[id] : 0), 0);
  if (!(total > 0)) return null;
  let x = rand() * total;
  for (const id of ids) {
    const w = weights[id] > 0 ? weights[id] : 0;
    if (x < w) return id;
    x -= w;
  }
  return ids[ids.length - 1];   // arrondi flottant : le dernier ferme la roue
}

// Filtrer, pondérer, tirer UN candidat. Le résultat porte tout ce qu'il faut
// pour l'expliquer : la liste éligible et les poids AU MOMENT du tirage.
// Le serveur du candidat n'est vérifié qu'après, par le Hub ; s'il ne répond
// pas, on rappelle cette fonction avec le candidat dans `exclure`.
function draw(session, games, rand, opts = {}) {
  const ev = evaluate(session, games, opts);
  if (!ev.eligible.length) return { error: 'NO_ELIGIBLE_GAME', why: ev.why };
  const gameId = pickWeighted(ev.eligible, ev.weights, rand);
  return { gameId, eligible: ev.eligible, weights: ev.weights, why: ev.why };
}

module.exports = { LOVE_BONUS, RECENCY, CAPS, ago, recency, reasons, weight, evaluate, pickWeighted, draw };
