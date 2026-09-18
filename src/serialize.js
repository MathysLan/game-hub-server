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

function publicSession(s) {
  return {
    code: s.code,
    state: s.state,
    hostId: s.hostId,
    maxPlayers: s.maxPlayers,
    players: s.players.map((p) => publicPlayer(p, s.hostId)),
    // Emplacements structurels : vides à cette phase, mais présents pour que le
    // client n'ait pas à gérer deux formes de message quand ils se rempliront.
    draw: s.draw,
    history: s.history,
  };
}

module.exports = { publicPlayer, publicSession };
