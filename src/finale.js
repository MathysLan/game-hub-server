// Le podium FINAL d'une soirée, SANS réseau (testé seul, test-finale.js).
//
// ⚠️ AUCUN CALCUL DE POINTS NOUVEAU. Les points sont ceux de `session.scores`,
// tenus par scores.js à partir des classements rendus par les jeux. Ce module
// ne fait que les RANGER, une fois, au moment où l'hôte termine la soirée — et
// le résultat est figé : la page l'affiche tel quel, chez tout le monde.
'use strict';

const { publicGame } = require('./serialize.js');

// Rangs « de compétition » : 70, 70, 50, 30 → 1, 1, 3, 4. Un ex æquo garde son
// rang, sans départage inventé. À points égaux, l'ordre d'arrivée dans la
// session, puis l'ordre de départ pour ceux qui sont partis.
//
// Qui figure au podium :
//   - tous les joueurs encore dans la session (même à 0, même absents) ;
//   - ceux qui l'ont QUITTÉE après avoir marqué (une entrée dans `scores`) :
//     ils ont joué la soirée, leurs points comptent. Nom et avatar viennent de
//     `departed`, gardés à leur départ. `present: false`.
function ranking(session) {
  const sc = session.scores || {};
  const lignes = session.players.map((p) => ({
    playerId: p.id, name: p.name, avatar: p.avatar, points: sc[p.id] || 0, present: true,
  }));
  const dedans = new Set(lignes.map((l) => l.playerId));
  for (const id of Object.keys(sc)) {
    if (dedans.has(id)) continue;
    const d = (session.departed || {})[id] || {};
    lignes.push({ playerId: id, name: d.name || '?', avatar: d.avatar || null, points: sc[id], present: false });
  }
  lignes.forEach((l, i) => { l.i = i; });
  lignes.sort((a, b) => b.points - a.points || a.i - b.i);
  return lignes.map((l) => ({
    playerId: l.playerId, name: l.name, avatar: l.avatar, points: l.points, present: l.present,
    rank: 1 + lignes.filter((x) => x.points > l.points).length,
  }));
}

// La finale telle qu'elle part sur le fil, et telle qu'elle est rendue à qui
// revient ensuite. `games` = les parties comptées (même forme que l'état de
// session), pour que la page puisse raconter la soirée partie par partie.
function build(session, byId, now) {
  return {
    code: session.code,
    at: now,
    by: byId,
    played: session.history.played.length,
    games: (session.history.games || []).map(publicGame),
    ranking: ranking(session),
  };
}

module.exports = { ranking, build };
