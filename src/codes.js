// Codes de salle du Hub.
//
// ⚠️ LE HUB A SON PROPRE ALPHABET, ET SA PROPRE LONGUEUR — délibérément.
//
// Relevé dans les sept serveurs de jeu : cinq (morpion, imitation, demicercle,
// ban, precision) tirent 4 caractères dans 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
// (31 signes), passeur et qui-ment tirent 4 lettres dans un alphabet de 23.
// Rien n'oblige le Hub à les imiter, et il y a une bonne raison de ne pas le
// faire : un joueur aura bientôt DEUX codes en main, celui de la session et
// celui de la partie. Un code de Hub à 5 caractères ne se confond jamais avec
// un code de jeu à 4 — on sait tout de suite lequel on tient.
//
// L'alphabet reprend en revanche celui des cinq : ni I, ni L, ni O, ni 0, ni 1.
// C'est ce qui compte quand on dicte un code à voix haute.
//
//   31^5 = 28 629 151 combinaisons. Avec 200 sessions vivantes, une collision
//   au premier tirage arrive une fois sur 143 000 — et on retire de toute
//   façon tant que le code est pris.
'use strict';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 5;

// `estPris` dit si un code est déjà attribué. On l'injecte plutôt que de lire
// une Map globale : ce module ne connaît rien au stockage des sessions, ce qui
// le rend testable seul.
function newCode(estPris, random = Math.random) {
  // Bornée : au-delà, c'est que `estPris` est cassé (il répond toujours oui),
  // et une boucle infinie serait pire qu'une erreur franche.
  for (let essai = 0; essai < 1000; essai++) {
    let c = '';
    for (let i = 0; i < LENGTH; i++) {
      c += ALPHABET[Math.floor(random() * ALPHABET.length)];
    }
    if (!estPris(c)) return c;
  }
  throw new Error('impossible de tirer un code libre');
}

// Ce qu'on accepte d'un humain : les minuscules et les espaces autour sont
// pardonnés, le reste non. On ne « corrige » pas un O en 0 : deviner à la place
// du joueur, c'est le faire entrer dans la mauvaise session sans le prévenir.
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  if (c.length !== LENGTH) return null;
  for (const ch of c) if (!ALPHABET.includes(ch)) return null;
  return c;
}

module.exports = { ALPHABET, LENGTH, newCode, normalizeCode };
