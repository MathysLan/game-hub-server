// L'état PUBLIC d'une session — le seul objet qui part vers les clients.
//
// ⚠️ LISTE BLANCHE, PAS LISTE NOIRE. On construit un objet neuf champ par
// champ ; on ne prend jamais la session pour en retirer des morceaux. La
// différence compte le jour où on ajoute un champ interne au modèle : avec une
// liste noire il partirait tout seul sur le fil, sans que rien ne le signale.
//
// Ce qui ne sort JAMAIS :
//   - `sockets` (la Map des connexions),
//   - `id` (l'identifiant interne de session — le CODE est la poignée publique),
//   - `since`, `graceMs`, les minuteries, et tout ce qui viendra après.
'use strict';

const { publicLaunch } = require('./launch.js');

// L'avatar part en entier, image comprise : une session de Hub n'est pas un
// protocole de jeu, et c'est le Hub qui affichera les photos. Le jour du
// handoff, seul l'emoji partira vers le serveur du jeu — ce n'est pas le même
// message, et ce ne sera pas ce sérialiseur-là.
function publicPlayer(p, hostId) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    caps: p.caps,
    veto: p.veto,
    love: p.love,
    connected: p.connected,
    host: p.id === hostId,
  };
}

// Le tirage, champ par champ lui aussi. `gameId` reste null tant que le serveur
// n'a pas tiré : le client n'a rien à animer avant d'avoir le vrai résultat.
function publicDraw(d) {
  if (!d) return null;
  return {
    id: d.id,
    n: d.n,
    status: d.status,              // 'pending' | 'drawn' | 'confirmed'
    by: d.by,
    gameId: d.gameId || null,
    eligible: (d.eligible || []).slice(),
    weights: Object.assign({}, d.weights || {}),
    requestedAt: d.requestedAt,
    drawnAt: d.drawnAt || null,
  };
}

// Une partie terminée, telle que le Hub l'a comptée. Pas les identifiants de
// jeu (`seats`) : ils ne servent qu'à relier, pas à afficher.
function publicGame(g) {
  return {
    n: g.n, drawId: g.drawId, gameId: g.gameId, at: g.at, players: g.players,
    results: g.results.map((r) => ({ playerId: r.playerId, name: r.name, rank: r.rank, gamePoints: r.gamePoints, points: r.points })),
  };
}

// `pool` : ce que le moteur dit du catalogue POUR CE GROUPE, recalculé à
// chaque diffusion (voir hub.js). Il voyage en permanence, pour que chacun
// voie pourquoi un jeu est exclu sans avoir à tirer.
function publicSession(s, pool) {
  return {
    code: s.code,
    state: s.state,
    hostId: s.hostId,
    maxPlayers: s.maxPlayers,
    players: s.players.map((p) => publicPlayer(p, s.hostId)),
    constraints: { maxMinutes: s.constraints ? s.constraints.maxMinutes : null },
    draw: publicDraw(s.draw),
    history: { played: s.history.played.slice(), usedContent: s.history.usedContent,
      games: (s.history.games || []).map(publicGame) },
    scores: Object.assign({}, s.scores || {}),
    launch: publicLaunch(s.launch, Date.now()),
    pool: pool || null,
  };
}

module.exports = { publicPlayer, publicDraw, publicGame, publicSession };
