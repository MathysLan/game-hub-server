// Validation de l'identité envoyée par le client.
//
// Le profil vient du navigateur (games/shared/game-profile.js, phase 2) : il
// est donc NON FIABLE par construction. Tout ce qui entre passe ici, et rien
// n'entre autrement.
//
// Les bornes ne sont pas inventées : elles sont relues dans les six serveurs de
// jeu qui acceptent une identité.
//
//   const cleanName = String(name || '').trim().slice(0, 16);
//   avatar: String(avatar || '🙂').slice(0, 4)
//
// ⚠️ Ce `slice(0, 4)` compte des unités UTF-16, pas des emojis. Un emoji à ZWJ
// (👨‍👩‍👧 = 8 unités) serait coupé en plein milieu par les serveurs de jeu et
// arriverait cassé. On refuse ici, comme le fait déjà le client.
//
// ⚠️ L'IMAGE EST ACCEPTÉE PAR LE HUB, PAS PAR LES JEUX. Une session de Hub
// n'est pas un protocole de jeu : le Hub peut garder l'avatar complet en
// mémoire. Le jour du handoff, c'est l'emoji — et lui seul — qui partira vers
// le serveur du jeu. Voir README, « Ce que le Hub ne fait pas encore ».
'use strict';

const MAX_NAME = 16;
const MAX_EMOJI = 4;          // unités UTF-16, comme le slice des jeux
const MAX_IMAGE_CHARS = 12 * 1024 * 2;   // 12 Ko une fois décodé
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const IMG_RE = /^data:image\/(webp|png);base64,[A-Za-z0-9+/=]+$/;

// L'id est une valeur OPAQUE : on vérifie sa forme, jamais son sens. Il ne
// prouve rien — l'autorité vient du socket, comme dans les sept jeux. Il sert
// uniquement à se reconnaître dans SA session (reconnexion).
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

const validEmoji = (e) =>
  typeof e === 'string' && e.length > 0 && e.length <= MAX_EMOJI && e.trim() === e;

// SVG refusé par construction : il peut porter du script, et le client ne
// produit que du webp/png sorti d'un canvas.
const validImage = (s) =>
  typeof s === 'string' && s.length <= MAX_IMAGE_CHARS && IMG_RE.test(s);

// Rend soit un joueur propre, soit une raison de refus. Jamais d'exception :
// un client bavard ne doit pas faire tomber le serveur.
function readPlayer(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'joueur manquant' };
  if (!validId(raw.id)) return { error: 'identifiant de joueur invalide' };

  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_NAME);
  // Un pseudo vide passerait ici mais serait refusé par quatre serveurs de jeu
  // sur six (« il faut un pseudo »). Autant le dire tout de suite, au moment où
  // le joueur peut encore corriger, plutôt qu'au lancement de la partie.
  if (!name) return { error: 'il faut un pseudo' };

  const a = raw.avatar && typeof raw.avatar === 'object' ? raw.avatar : {};
  if (!validEmoji(a.emoji)) return { error: 'avatar invalide' };

  const avatar = { kind: 'emoji', emoji: a.emoji };
  if (a.kind === 'image' && validImage(a.src)) {
    avatar.kind = 'image';
    avatar.src = a.src;
  }
  // `kind: 'image'` sans src valable retombe silencieusement sur l'emoji :
  // l'emoji est toujours présent, c'est lui le repli.

  return { player: { id: raw.id, name, avatar } };
}

module.exports = {
  MAX_NAME, MAX_EMOJI, MAX_IMAGE_CHARS,
  validId, validEmoji, validImage, readPlayer,
};
