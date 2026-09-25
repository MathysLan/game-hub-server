// Le SCORE DE SOIRÉE — module pur, sans réseau.
//
// Deux autorités, et elles ne se mélangent pas :
//   - le JEU reste seul maître de sa partie : qui a gagné, avec combien de
//     points. Le Hub ne recalcule rien de ce qui s'est passé dans la room ;
//   - le HUB est seul maître de la soirée : il reçoit le classement final d'une
//     partie, le relie à SES joueurs, le convertit en points de soirée et les
//     additionne. Aucune page ne peut écrire un score de soirée.
//
// ⚠️ Le Hub ne connaît toujours AUCUNE règle de jeu. Ce qu'il lit d'une partie
// se limite à un rang (1 = premier) et au nombre de points que le jeu annonce,
// gardé tel quel dans l'historique pour qu'on puisse le relire.
//
// LE CONTRAT (message `results`, envoyé par l'hôte du lancement, voir hub.js) :
//
//   { action: 'results', drawId, gameId,
//     results: [ { gamePlayerId, rank, points } ] }
//
// `gamePlayerId` est l'identifiant du joueur DANS LA ROOM DU JEU (le `you.id`
// du Passeur), pas son player.id du Hub : l'hôte ne connaît pas l'identifiant
// de jeu des autres. Chaque joueur a déclaré LE SIEN en entrant dans la room
// (`launched` / `entered`, champ `gamePlayerId`) : c'est cette table — remplie
// joueur par joueur, chacun pour soi — qui relie une ligne du classement à un
// joueur du Hub. L'hôte ne peut donc pas attribuer des points à quelqu'un
// d'autre qu'au joueur qui s'est lui-même assis à cette place.
//
// ⚠️ LIMITE ASSUMÉE : le serveur du jeu ne parle pas au Hub (règle du projet),
// donc le classement passe par le navigateur de l'hôte. Un hôte qui trafique
// sa page peut mentir sur les RANGS de sa propre partie. C'est la même
// confiance que pour le code de room ; entre amis, ça suffit. Le jour où ça ne
// suffira plus, c'est le serveur du jeu qui devra signer ce message.
'use strict';

// LA CONVERSION, et il n'y en a qu'une, commune à tous les jeux :
//
//   points de soirée = 10 × (nombre de classés − rang + 1)
//
// Soit « 10 points par joueur battu, plus 10 pour avoir joué ». À trois : 30 /
// 20 / 10. Un ex æquo partage le rang, donc les points.
//
// Pourquoi le RANG et pas les points du jeu : les points d'un jeu ne se
// comparent pas à ceux d'un autre (Le Passeur va de 0 à 100 par manche, et le
// MJ choisit de 3 à 12 manches : une partie longue pèserait quatre fois plus
// qu'une courte), et certains jeux n'en ont pas du tout (le Morpion : gagné,
// perdu, nul). Un classement, TOUS les jeux en ont un.
const POINTS_PER_PLACE = 10;
const sessionPoints = (rank, n) => POINTS_PER_PLACE * (n - rank + 1);

// Un classement de 16 lignes au plus : les sept jeux plafonnent à 12 joueurs.
const MAX_ROWS = 16;
const SEAT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const readSeat = (v) => (typeof v === 'string' && SEAT_RE.test(v) ? v : null);

// Relu comme tout ce qui arrive du réseau : forme exacte, sinon refus entier.
// Un classement à moitié valide n'est pas « à moitié compté » — il est faux.
function readResults(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_ROWS) return { error: 'BAD_RESULTS' };
  const rows = [];
  const vus = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object') return { error: 'BAD_RESULTS' };
    const seat = readSeat(r.gamePlayerId);
    if (!seat || vus.has(seat)) return { error: 'BAD_RESULTS' };
    if (!Number.isInteger(r.rank) || r.rank < 1 || r.rank > list.length) return { error: 'BAD_RESULTS' };
    if (typeof r.points !== 'number' || !Number.isFinite(r.points) || Math.abs(r.points) > 1e6) return { error: 'BAD_RESULTS' };
    vus.add(seat);
    rows.push({ seat, rank: r.rank, points: r.points });
  }
  // Un classement a toujours un premier.
  if (!rows.some((r) => r.rank === 1)) return { error: 'BAD_RESULTS' };
  return { rows };
}

// La place d'un joueur dans la room, déclarée par LUI. Une place déjà prise
// par un autre joueur du Hub est refusée (on garde le premier) ; la sienne peut
// changer (reconnexion au salon du jeu = nouvel identifiant de jeu).
function seat(launch, playerId, value) {
  const s = readSeat(value);
  if (!s) return false;
  const pris = Object.keys(launch.seats).find((id) => id !== playerId && launch.seats[id] === s);
  if (pris) return false;
  launch.seats[playerId] = s;
  return true;
}

// Additionne une partie au score de la soirée. Rend l'entrée d'historique.
// Seules comptent les lignes reliées à un joueur ENCORE dans la session ; les
// autres (quelqu'un entré dans la room sans passer par le Hub, un joueur parti
// de la session) occupent leur rang — ils ont joué — mais ne marquent rien ici.
function apply(session, launch, rows, now) {
  const n = rows.length;
  const parSiege = {};
  for (const id of Object.keys(launch.seats)) parSiege[launch.seats[id]] = id;
  const lignes = [];
  for (const r of rows.slice().sort((a, b) => a.rank - b.rank)) {
    const playerId = parSiege[r.seat];
    const p = playerId && session.players.find((x) => x.id === playerId);
    if (!p) continue;
    const pts = sessionPoints(r.rank, n);
    session.scores[p.id] = (session.scores[p.id] || 0) + pts;
    // Le nom est figé ici : l'historique reste lisible si le joueur part.
    lignes.push({ playerId: p.id, name: p.name, rank: r.rank, gamePoints: r.points, points: pts });
  }
  const entry = { n: session.history.games.length + 1, drawId: launch.drawId, gameId: launch.gameId, at: now, players: n, results: lignes };
  session.history.games.push(entry);
  launch.scored = true;
  return entry;
}

module.exports = { POINTS_PER_PLACE, MAX_ROWS, sessionPoints, readResults, readSeat, seat, apply };
