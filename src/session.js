// Le modèle de session, SANS réseau.
//
// Aucun WebSocket n'entre ici : ce fichier ne manipule que des données. C'est
// ce qui permet de le tester seul (test-session.js) et ce qui garantit qu'un
// socket ne peut pas se retrouver dans un état public par distraction.
//
// ⚠️ CE QUE CE MODULE NE FERA JAMAIS : connaître une règle de jeu, un score, un
// secret, un contenu. Le Hub oriente un groupe vers un serveur de jeu ; c'est
// ce serveur-là qui arbitre. Si un jour une notion de gameplay apparaît dans ce
// fichier, c'est que la frontière a bougé au mauvais endroit.
'use strict';

// Les six états prévus. Cette phase n'en fait vivre que deux — `lobby` et
// `closed` — mais le modèle sait les représenter tous, pour que la phase
// suivante n'ait pas à réécrire la machine.
const STATES = ['lobby', 'drawing', 'launching', 'inGame', 'debrief', 'closed'];

// 12 et pas 8 : c'est le MAX_PLAYERS de precision-server, le plus permissif des
// sept (relevé dans src/server.js). Plafonner le Hub à 8 interdirait une
// session de dix amis qui veulent jouer à Precision. Le filtre par jeu viendra
// du manifest, à la phase du randomizer — pas d'ici.
const MAX_PLAYERS = 12;

// Un joueur déconnecté n'est pas un joueur parti : un téléphone qui se
// verrouille, un tunnel, un rechargement. On le garde visible « absent » le
// temps qu'il revienne.
const GRACE_MS = 60_000;

function createSession(code, options = {}) {
  return {
    // Interne, jamais envoyé au client : le code est la seule poignée publique.
    id: 'hs_' + Math.random().toString(36).slice(2, 12),
    code,
    hostId: null,
    state: 'lobby',
    createdAt: Date.now(),
    players: [],
    // Les sockets vivent À CÔTÉ des joueurs, pas dedans : `players` reste une
    // donnée pure, et le sérialiseur ne peut pas en laisser fuir un par erreur.
    sockets: new Map(),
    // Emplacements structurels, volontairement vides à cette phase. Ils
    // existent pour que le protocole n'ait pas à changer de forme plus tard.
    draw: null,
    history: { played: [], usedContent: {} },
    maxPlayers: options.maxPlayers || MAX_PLAYERS,
    graceMs: options.graceMs == null ? GRACE_MS : options.graceMs,
  };
}

const getPlayer = (s, id) => s.players.find((p) => p.id === id) || null;
const connectedPlayers = (s) => s.players.filter((p) => p.connected);

function addPlayer(s, player) {
  if (s.state !== 'lobby') return { error: 'SESSION_CLOSED' };
  if (getPlayer(s, player.id)) return { error: 'PLAYER_EXISTS' };
  if (s.players.length >= s.maxPlayers) return { error: 'SESSION_FULL' };
  const p = {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    // Préparés pour le randomizer, PAS encore utilisés : aucune logique métier
    // ne les lit à cette phase. Leur forme est fixée ici pour que la phase
    // suivante n'ait pas à migrer des sessions vivantes.
    caps: { mic: false },
    veto: [],
    love: [],
    connected: true,
    since: Date.now(),
  };
  s.players.push(p);
  if (!s.hostId) s.hostId = p.id;
  return { player: p };
}

function removePlayer(s, id) {
  const i = s.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const [p] = s.players.splice(i, 1);
  if (s.hostId === id) electHost(s);
  return p;
}

// Un seul endroit décide qui est hôte. Règle de cette phase : le plus ancien
// joueur ENCORE CONNECTÉ. Pas de vote, pas de permissions — le créateur est
// hôte parce qu'il est arrivé le premier, exactement comme dans les sept jeux.
function electHost(s) {
  const vivants = connectedPlayers(s);
  if (!vivants.length) {
    // On ne met pas hostId à null tant qu'il reste des joueurs absents : ils
    // peuvent revenir, et la session serait sinon sans hôte entre-temps.
    s.hostId = s.players.length ? s.players[0].id : null;
    return s.hostId;
  }
  if (s.hostId && vivants.some((p) => p.id === s.hostId)) return s.hostId;
  vivants.sort((a, b) => a.since - b.since);
  s.hostId = vivants[0].id;
  return s.hostId;
}

module.exports = {
  STATES, MAX_PLAYERS, GRACE_MS,
  createSession, addPlayer, removePlayer, getPlayer, connectedPlayers, electHost,
};
