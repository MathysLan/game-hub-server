// Ce qu'un joueur peut régler pour LUI-MÊME (et ce que l'hôte règle pour la
// session). Tout vient du navigateur, donc tout est relu ici — même règle que
// identity.js : une forme valide ou une raison de refus, jamais d'exception.
//
// ⚠️ Aucune de ces fonctions ne reçoit un identifiant de joueur : `prefs` et
// `caps` s'appliquent à l'ÉMETTEUR du message, désigné par son socket. Un
// client ne peut donc pas écrire les préférences d'un autre, même en le
// demandant.
'use strict';

const { CAPS } = require('./engine.js');

const GAME_ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX_LIST = 32;

// Une liste d'identifiants de jeu : dédoublonnée, bornée, et limitée au
// catalogue quand on le connaît (un id inconnu ne filtrerait rien — autant ne
// pas le garder).
function readIds(raw, known) {
  if (raw == null) return { ids: [] };
  if (!Array.isArray(raw) || raw.length > MAX_LIST) return { error: 'liste de jeux invalide' };
  const ids = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !GAME_ID_RE.test(v)) return { error: 'identifiant de jeu invalide' };
    if (known && !known.includes(v)) continue;
    if (!ids.includes(v)) ids.push(v);
  }
  return { ids };
}

// ❤️ et 🚫 sur un même jeu n'ont pas de sens : le veto l'emporte. C'est le
// choix le plus prudent — un « j'aime » ne doit jamais ramener un jeu refusé.
function readPrefs(msg, known) {
  const love = readIds(msg.love, known);
  if (love.error) return love;
  const veto = readIds(msg.veto, known);
  if (veto.error) return veto;
  return { love: love.ids.filter((id) => !veto.ids.includes(id)), veto: veto.ids };
}

// Capacités DÉCLARÉES (« j'ai un micro »). Le Hub ne teste rien : c'est le jeu
// qui demandera la permission, à l'entrée. Seules les clés du vocabulaire
// fermé sont retenues, et seulement en booléen.
function readCaps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'capacités invalides' };
  const caps = {};
  for (const k of Object.keys(raw)) {
    if (!CAPS.includes(k)) continue;
    if (typeof raw[k] !== 'boolean') return { error: 'capacités invalides' };
    caps[k] = raw[k];
  }
  return { caps };
}

// Contrainte de durée, réglée par l'hôte : null (aucune) ou un plafond en
// minutes. Comparée au `minutes.max` de chaque jeu.
function readConstraints(msg) {
  const m = msg.maxMinutes;
  if (m === null || m === undefined) return { constraints: { maxMinutes: null } };
  if (!Number.isInteger(m) || m < 1 || m > 240) return { error: 'durée invalide' };
  return { constraints: { maxMinutes: m } };
}

module.exports = { GAME_ID_RE, MAX_LIST, readIds, readPrefs, readCaps, readConstraints };
