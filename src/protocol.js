// Le protocole : ce qu'on accepte, ce qu'on renvoie, et les erreurs.
//
// Convention reprise des sept serveurs de jeu, pour n'avoir rien à réapprendre :
// le client envoie `{ action }`, le serveur renvoie `{ type }`, en JSON sur un
// seul WebSocket.
//
// UN AJOUT par rapport aux jeux : les erreurs portent un `code` machine en plus
// du `message` humain. Les jeux n'envoient que `{ type: 'error', message }` —
// suffisant quand un seul écran lit le message, insuffisant pour un Hub qui
// devra distinguer « code inconnu » de « session pleine » afin de proposer la
// bonne suite. Le `message` reste là, au même endroit : un client écrit pour un
// jeu lirait ce message sans rien changer.
'use strict';

// Tout ce qu'un client peut recevoir comme refus. La liste est fermée : un code
// absent d'ici est un bug, pas une nouvelle erreur.
const ERRORS = {
  BAD_JSON: 'message illisible',
  TOO_BIG: 'message trop volumineux',
  UNKNOWN_ACTION: 'action inconnue',
  BAD_PLAYER: 'identité invalide',
  BAD_CODE: 'code de session invalide',
  SESSION_NOT_FOUND: 'aucune session avec ce code',
  SESSION_FULL: 'session complète',
  SESSION_CLOSED: 'cette session est terminée',
  ALREADY_IN_SESSION: 'tu es déjà dans une session',
  NOT_IN_SESSION: 'tu n\'es dans aucune session',
  // Randomizer.
  NOT_HOST: 'seul l\'hôte peut faire ça',
  DRAW_IN_PROGRESS: 'un tirage est déjà en cours',
  NOT_DRAWN: 'aucun tirage à confirmer',
  NO_ELIGIBLE_GAME: 'aucun jeu possible pour ce groupe',
  DRAW_FAILED: 'le tirage a échoué',
  MANIFEST_UNAVAILABLE: 'catalogue des jeux indisponible',
  BAD_PREFS: 'préférences invalides',
  BAD_CAPS: 'capacités invalides',
  BAD_CONSTRAINTS: 'contrainte invalide',
  // Lancement (handoff).
  NOT_LAUNCHING: 'aucun lancement en cours',
  LAUNCH_MISMATCH: 'ce lancement ne correspond pas au tirage en cours',
  LAUNCH_CONSUMED: 'le code de la partie a déjà été déclaré',
  LAUNCH_EXPIRED: 'le lancement a expiré',
  BAD_ROOM_CODE: 'code de partie mal formé',
  WRONG_ROOM: 'ce n\'est pas la partie du groupe',
  // Score de soirée (scores.js).
  BAD_RESULTS: 'classement de partie invalide',
  GAME_MISMATCH: 'ce classement ne vient pas du jeu lancé',
  RESULTS_ALREADY: 'le classement de cette partie est déjà compté',
};

// Pourquoi un lancement échoue (launch.reason) : pas des erreurs de message,
// mais l'issue d'un lancement, que le salon explique à tout le monde.
const LAUNCH_FAILURES = {
  LAUNCH_TIMEOUT: 'l\'hôte n\'a pas créé la partie à temps',
  HOST_LEFT: 'l\'hôte a quitté la session avant de créer la partie',
  UNREACHABLE: 'le serveur du jeu est injoignable',
  SERVER_DOWN: 'le serveur du jeu est indisponible',
  CREATE_FAILED: 'la partie n\'a pas pu être créée',
  CANCELLED: 'l\'hôte a annulé le lancement',
};

// 32 Ko : un `create` porte au pire un avatar image (24 Ko de data-URL, plafond
// du client) plus un pseudo. Rien d'autre n'a besoin de place, et au-delà on
// ferme le socket plutôt que de garder l'octet en mémoire.
const MAX_MESSAGE = 32 * 1024;

// `draw` ne porte RIEN : le client demande « tire le prochain jeu », jamais
// « choisis Passeur ». Un champ `gameId` ou `players` envoyé avec est ignoré.
const ACTIONS = ['create', 'join', 'leave', 'prefs', 'caps', 'constraints', 'draw', 'continue',
  // Lancement : envoyés par la page DU JEU (games/shared/hub-handoff.js).
  'launched', 'entered', 'started', 'ended', 'abort',
  // Score de soirée : le classement final d'une partie, par l'hôte du lancement.
  'results'];

function parse(raw) {
  if (typeof raw !== 'string') raw = String(raw);
  if (raw.length > MAX_MESSAGE) return { error: 'TOO_BIG' };
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return { error: 'BAD_JSON' }; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { error: 'BAD_JSON' };
  if (!ACTIONS.includes(msg.action)) return { error: 'UNKNOWN_ACTION' };
  return { msg };
}

module.exports = { ERRORS, LAUNCH_FAILURES, ACTIONS, MAX_MESSAGE, parse };
