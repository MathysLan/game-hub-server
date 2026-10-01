// SUCCÈS DE JOUEUR (lot J, portfolio, 2026-10-01) — module pur, sans réseau
// ni base.
//
// ⚠️ LE HUB SEUL DÉCIDE. Un succès se déduit des parties de `hub_plays` (des
// classements que le Hub a ACCEPTÉS, voir stats.js) : aucun message client ne
// peut en débloquer un. La table `hub_achievements` (store-pg.js) ne fait que
// RETENIR le premier déblocage, sa date, et si la notification a été montrée.
//
// LE REJEU : les parties du joueur, dans l'ordre (played_at, puis draw_id),
// sont relues une à une ; pour chaque succès on note la PREMIÈRE partie après
// laquelle sa condition est vraie (date + tirage). Tous les succès sont
// monotones (une fois vrais, toujours vrais) : le rejeu donne le même résultat
// que l'on parte de zéro ou que l'on rejoue après chaque partie.
//
// DÉFINITIONS (validées par Mathys, lot J) — celles du lot H pour le reste :
//   victoire    rang 1 ET au moins un classé derrière (stats.isWin) ;
//   compétitive au moins 2 classés : une partie SOLO ne compte pour aucun
//               succès, sauf Touche-à-tout (explorer : on y découvre un jeu) ;
//   soirée      suite de parties compétitives CONSÉCUTIVES du joueur, même code
//               de session, et pas plus de 12 h entre deux (un code de session
//               n'est unique que parmi les sessions vivantes : la garde de 12 h
//               évite de fusionner deux soirées au même code) ;
//   série       « d'affilée » = parmi TES parties compétitives enregistrées de
//               la soirée : une défaite ou un nul du Morpion la casse, un 1er ex
//               æquo devant quelqu'un la continue ; une partie abandonnée (sans
//               classement) ou jouée sans toi n'existe pas pour le Hub.
'use strict';

const { isWin } = require('./stats.js');

// Le catalogue, dans l'ordre d'affichage (du plus accessible au plus rare).
// Les TEXTES sont côté page (games/hub-page.js) ; un test vérifie que les deux
// listes de codes sont les mêmes.
const CODES = ['first-win', 'explorer', 'stalemate', 'shared-throne', 'versatile',
  'marathon', 'night-owl', 'hat-trick', 'crowd-king', 'grand-slam'];

// Les 7 jeux EN LIGNE, figés : ajouter un jeu au catalogue ne doit pas retirer
// le Grand Chelem à qui l'a déjà (Puissance 4, local, n'a jamais de classement).
const GRAND_SLAM = ['morpion', 'imitation', 'demicercle', 'ban', 'precision', 'passeur', 'quiment'];

const SOIREE_MS = 12 * 3600 * 1000;
const EXPLORER = 5, STALEMATE = 3, VERSATILE = 3, MARATHON = 10, HAT_TRICK = 3, CROWD = 6;

// L'heure à Paris (0–23), heure d'été comprise. Oiseau de nuit : 00:00:00 à
// 04:59:59, donc heure < 5.
const PARIS = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' });
const parisHour = (ms) => Number(PARIS.formatToParts(new Date(ms)).find((p) => p.type === 'hour').value);

const isCompetitive = (p) => p.ranked >= 2;
const isStalemate = (p) => p.gameId === 'morpion' && p.rank === 1 && p.ranked === 2 && p.behind === 0;
const isSharedThrone = (p) => p.rank === 1 && p.behind >= 1 && p.behind < p.ranked - 1;

// `plays` : [{ drawId, sessionCode, gameId, rank, ranked, behind, at }] (at en
// ms). Rend [{ code, at, drawId }] dans l'ordre du catalogue : chaque succès
// obtenu, avec la partie qui l'a débloqué.
function unlocks(plays) {
  const tri = (plays || []).slice().sort((a, b) => a.at - b.at || (a.drawId < b.drawId ? -1 : a.drawId > b.drawId ? 1 : 0));
  const got = new Map();
  const gagne = (code, p) => { if (!got.has(code)) got.set(code, { code, at: p.at, drawId: p.drawId }); };
  const joues = new Set(), gagnes = new Set();
  let victoires = 0, nuls = 0;
  let soiree = null;                      // { code, last, n, serie }
  for (const p of tri) {
    joues.add(p.gameId);
    if (joues.size >= EXPLORER) gagne('explorer', p);
    if (!isCompetitive(p)) continue;      // le solo : rien d'autre

    const win = isWin(p);
    if (win) { victoires++; gagnes.add(p.gameId); }
    if (victoires >= 1) gagne('first-win', p);
    if (isStalemate(p) && ++nuls >= STALEMATE) gagne('stalemate', p);
    if (isSharedThrone(p)) gagne('shared-throne', p);
    if (gagnes.size >= VERSATILE) gagne('versatile', p);
    if (parisHour(p.at) < 5) gagne('night-owl', p);
    if (win && p.ranked >= CROWD) gagne('crowd-king', p);
    if (GRAND_SLAM.every((g) => gagnes.has(g))) gagne('grand-slam', p);

    if (!soiree || soiree.code !== p.sessionCode || p.at - soiree.last > SOIREE_MS) soiree = { code: p.sessionCode, n: 0, serie: 0 };
    soiree.last = p.at;
    soiree.n++;
    soiree.serie = win ? soiree.serie + 1 : 0;
    if (soiree.n >= MARATHON) gagne('marathon', p);
    if (soiree.serie >= HAT_TRICK) gagne('hat-trick', p);
  }
  return CODES.filter((c) => got.has(c)).map((c) => got.get(c));
}

// Les 10 succès tels que le joueur les voit, à partir des lignes retenues
// (store.achievements). Aucun calcul : obtenu ou non, depuis quand, par quelle
// partie. `notifiedAt` ne sort pas.
function view(rows) {
  const par = new Map((rows || []).map((r) => [r.code, r]));
  return CODES.map((code) => {
    const r = par.get(code);
    return r ? { code, unlocked: true, at: r.unlockedAt, drawId: r.drawId } : { code, unlocked: false };
  });
}

// Les codes qu'un client dit avoir AFFICHÉS : seulement des codes connus, sans
// doublon. Ça ne débloque rien (le store ne touche que des lignes existantes).
function readSeen(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((c) => typeof c === 'string' && CODES.includes(c)))];
}

module.exports = { CODES, GRAND_SLAM, SOIREE_MS, parisHour, unlocks, view, readSeen, isCompetitive, isStalemate, isSharedThrone };
