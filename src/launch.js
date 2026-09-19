// Le LANCEMENT d'un jeu tiré (le « handoff ») — module pur, sans réseau.
//
// Le Hub n'ouvre JAMAIS de WebSocket vers un serveur de jeu. Il orchestre des
// navigateurs, qui eux parlent au jeu :
//
//   1. l'hôte confirme le tirage          → launch.stage = 'create'
//   2. la page du jeu de l'hôte crée une room par le protocole NORMAL du jeu,
//      reçoit son code, et le déclare     → `launched` → stage 'join'
//   3. chaque invité voit « Rejoindre », ouvre le jeu, rejoint CE code, et le
//      déclare                            → `entered`
//   4. tout le monde est entré (ou l'hôte lance, ou le délai expire)
//                                         → stage 'playing'
//   5. la partie se termine               → `ended` → stage 'ended'
//   Échec à tout moment                   → stage 'failed' (retour au salon)
//
// Ce que le Hub SAIT du jeu : son id, son URL (manifest), qui est l'hôte, le
// code de room déclaré. RIEN de ses règles. Il ne peut pas vérifier qu'une
// room existe : c'est le serveur du jeu qui le dira au premier invité, et
// l'invité le rapporte (`abort`).
//
// ⚠️ PAS DE JETON SECRET, et c'est délibéré. L'autorité vient du SOCKET (celui
// de l'hôte désigné au lancement), comme partout dans le Hub. Le lancement est
// lié au tirage courant par `drawId`, borné dans le temps (`deadline`) et à
// usage unique (le stage passe à 'join' au premier `launched` valide). Un
// jeton n'ajouterait rien que ces trois règles ne garantissent déjà.
'use strict';

// 90 s pour créer la room : réveil Render (~30 s), chargement de la page,
// connexion. Au-delà, l'hôte ne le fera plus — on libère le groupe.
const CREATE_MS = 90_000;
// 120 s pour que les invités entrent. Au-delà, on considère la partie lancée
// avec ceux qui sont là ; les autres sont « manqués » (et le disent).
const JOIN_MS = 120_000;

// Le code d'une room de jeu : le Hub ne connaît pas l'alphabet de chaque jeu
// (4 lettres pour les sept actuels). Il n'accepte qu'une forme sobre — des
// capitales et des chiffres, 4 à 8 signes — sans jamais le deviner.
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;
const normalizeRoomCode = (raw) => {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(c) ? c : null;
};

const sans = (list, ids) => list.filter((id) => !ids.includes(id));

function create(session, draw, game, now, opts = {}) {
  return {
    drawId: draw.id,
    gameId: game.id,
    url: game.url,
    stage: 'create',
    hostId: session.hostId,              // L'hôte DU LANCEMENT, figé ici
    roomCode: null,
    expected: session.players.map((p) => p.id),
    entered: [],
    missed: [],
    failed: {},                          // playerId → raison (un invité qui n'a pas pu entrer)
    reason: null,                        // raison d'échec du lancement entier
    createdAt: now,
    deadline: now + (opts.createMs || CREATE_MS),
  };
}

// Qui est encore attendu dans la room.
const waiting = (l) => sans(sans(sans(l.expected, l.entered), l.missed), Object.keys(l.failed));

// L'hôte déclare le code de SA room. Refus si : pas d'hôte, pas le bon tirage,
// déjà fait, expiré, ou code mal formé. Rend { error } ou { code }.
function checkLaunched(l, playerId, msg, now) {
  if (!l || l.stage === 'failed' || l.stage === 'ended') return { error: 'NOT_LAUNCHING' };
  if (playerId !== l.hostId) return { error: 'NOT_HOST' };
  if (!msg || msg.drawId !== l.drawId) return { error: 'LAUNCH_MISMATCH' };
  if (l.stage !== 'create') return { error: 'LAUNCH_CONSUMED' };
  if (now > l.deadline) return { error: 'LAUNCH_EXPIRED' };
  const code = normalizeRoomCode(msg.roomCode);
  if (!code) return { error: 'BAD_ROOM_CODE' };
  return { code };
}

function applyLaunched(l, code, now, opts = {}) {
  l.roomCode = code;
  l.stage = 'join';
  l.entered = [l.hostId];                 // l'hôte est dans sa propre room
  l.deadline = now + (opts.joinMs || JOIN_MS);
}

// Un joueur déclare être entré. Le code doit être CELUI du lancement : un
// invité ne peut ni en proposer un autre, ni rediriger le groupe.
function checkEntered(l, playerId, msg) {
  if (!l || (l.stage !== 'join' && l.stage !== 'playing')) return { error: 'NOT_LAUNCHING' };
  if (!msg || msg.drawId !== l.drawId) return { error: 'LAUNCH_MISMATCH' };
  if (normalizeRoomCode(msg.roomCode) !== l.roomCode) return { error: 'WRONG_ROOM' };
  return { ok: true };
}

function applyEntered(l, playerId) {
  if (!l.expected.includes(playerId)) l.expected.push(playerId);   // arrivé au Hub après le tirage
  if (!l.entered.includes(playerId)) l.entered.push(playerId);
  l.missed = l.missed.filter((id) => id !== playerId);
  delete l.failed[playerId];
}

// La partie est lancée : ceux qui ne sont pas là sont « manqués ».
function applyPlaying(l) {
  l.missed = l.missed.concat(waiting(l));
  l.stage = 'playing';
}

// Un joueur quitte la session pendant le lancement : il n'est plus attendu.
function forget(l, playerId) {
  l.expected = l.expected.filter((id) => id !== playerId);
  l.entered = l.entered.filter((id) => id !== playerId);
  l.missed = l.missed.filter((id) => id !== playerId);
  delete l.failed[playerId];
}

function fail(l, reason) {
  l.stage = 'failed';
  l.reason = reason;
}

// Ce qui part vers les clients : champ par champ, comme tout le reste.
function publicLaunch(l, now) {
  if (!l) return null;
  return {
    drawId: l.drawId,
    gameId: l.gameId,
    url: l.url,
    stage: l.stage,
    hostId: l.hostId,
    roomCode: l.roomCode,
    expected: l.expected.slice(),
    entered: l.entered.slice(),
    waiting: waiting(l),
    missed: l.missed.slice(),
    failed: Object.assign({}, l.failed),
    reason: l.reason,
    expiresInMs: (l.stage === 'create' || l.stage === 'join') ? Math.max(0, l.deadline - now) : null,
  };
}

module.exports = {
  CREATE_MS, JOIN_MS, ROOM_CODE_RE, normalizeRoomCode,
  create, waiting, checkLaunched, applyLaunched, checkEntered, applyEntered, applyPlaying, forget, fail, publicLaunch,
};
