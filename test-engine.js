// Moteur de tirage — module pur, sans réseau.
//
//   node test-engine.js
//
// Le catalogue utilisé ici a EXACTEMENT les valeurs du manifest réel du
// portfolio (data/games.manifest.json, 2026-09-19) : bornes de joueurs,
// fourchettes de durée, besoins, modes. On ne teste pas un moteur contre des
// jeux imaginaires. La santé des serveurs, elle, n'est plus ici du tout : le
// Hub vérifie le serveur du seul candidat tiré (voir test-draw.js).
'use strict';

const E = require('./src/engine.js');
const S = require('./src/session.js');
const { readPrefs, readCaps, readConstraints } = require('./src/prefs.js');
const { readManifest } = require('./src/catalog.js');

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};

const on = (id, min, max, mmin, mmax, needs = []) => ({ id, title: id, mode: 'online', players: { min, max }, minutes: { min: mmin, max: mmax },
  needs, categories: [], server: `wss://${id}.example`, health: `https://${id}.example/`, join: 'v1', content: false, replay: false });
const GAMES = readManifest({ version: 1, games: [
  on('morpion', 2, 2, 1, 5),
  on('imitation', 2, 8, 6, 15, ['mic']),
  on('demicercle', 2, 10, 2, 15),
  { id: 'puissance4', title: 'Puissance 4', mode: 'local', players: { min: 1, max: 1 }, minutes: { min: 2, max: 6 }, needs: [], categories: [] },
  on('ban', 2, 10, 5, 12, ['consent']),
  on('precision', 1, 12, 3, 10),
  on('passeur', 1, 8, 3, 8),
  on('quiment', 3, 8, 8, 15),
] });


// Une session du vrai modèle, avec n joueurs.
function session(n, tweak) {
  const s = S.createSession('ABCDE');
  for (let i = 0; i < n; i++) S.addPlayer(s, { id: 'p_' + i + 'xxx', name: 'J' + i, avatar: { kind: 'emoji', emoji: '🦊' } });
  if (tweak) tweak(s);
  return s;
}
const elig = (s, opts) => E.evaluate(s, GAMES, opts).eligible;
const why = (s, id) => (E.evaluate(s, GAMES).why[id] || []).map((r) => r.code);
// Hasard rejouable : une suite de réels fixée.
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
// Hasard pseudo-aléatoire reproductible (mulberry32) pour les grands nombres.
function prng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}

console.log('Moteur de tirage — filtre, poids, tirage\n');

// ── le catalogue lui-même
t('catalogue : les 8 jeux du manifest réel sont lus', GAMES.length === 8, GAMES.map((g) => g.id).join(','));
t('catalogue : version de schéma inconnue refusée en bloc', (() => { try { readManifest({ version: 2, games: [] }); return false; } catch (_) { return true; } })());
t('catalogue : un jeu mal formé est écarté, pas les autres',
  readManifest({ version: 1, games: [on('passeur', 1, 8, 3, 8), { id: 'x', mode: 'online', players: { min: 3, max: 2 } }] }).length === 1);

// ── 1. min players
t('1. min : Qui Ment ? (min 3) exclu à 2 joueurs', !elig(session(2)).includes('quiment') && why(session(2), 'quiment').includes('TOO_FEW'));
t('1. min : Qui Ment ? possible à 3 joueurs', elig(session(3)).includes('quiment'));
const tf = E.evaluate(session(2), GAMES).why.quiment.find((r) => r.code === 'TOO_FEW');
t('1. min : la raison dit combien il en faut et combien on est', tf.min === 3 && tf.count === 2);

// ── 2. max players
t('2. max : Morpion (max 2) exclu à 3 joueurs', why(session(3), 'morpion').includes('TOO_MANY'));
t('2. max : Morpion possible à 2 joueurs', elig(session(2)).includes('morpion'));
t('2. max : Passeur (max 8) exclu à 9 joueurs, Précision (max 12) possible',
  why(session(9), 'passeur').includes('TOO_MANY') && elig(session(9)).includes('precision'));
t('2. max : Puissance 4 (local, 1 joueur) exclu dès 2 — mode ET borne',
  why(session(2), 'puissance4').includes('LOCAL_ONLY') && why(session(2), 'puissance4').includes('TOO_MANY'));
t('2. max : Puissance 4 possible en solo', elig(session(1)).includes('puissance4'));

// Plusieurs tailles de groupe, contre le manifest réel.
const attendu = {
  1: ['puissance4', 'precision', 'passeur'],
  2: ['morpion', 'demicercle', 'precision', 'passeur'],
  3: ['demicercle', 'precision', 'passeur', 'quiment'],
  8: ['demicercle', 'precision', 'passeur', 'quiment'],
  9: ['demicercle', 'precision'],
  11: ['precision'],
  12: ['precision'],
};
for (const [n, liste] of Object.entries(attendu)) {
  const e = elig(session(+n));
  t(`groupe de ${n} (sans micro ni consentement) : ${liste.join(', ')}`, JSON.stringify(e) === JSON.stringify(liste), e.join(','));
}

// ── 3. min/max duration
const dur = (m) => session(3, (s) => { s.constraints = { maxMinutes: m }; });
t('3. durée : ≤ 10 min écarte Demi-Cercle (max 15) et Qui Ment ? (max 15)',
  why(dur(10), 'demicercle').includes('TOO_LONG') && why(dur(10), 'quiment').includes('TOO_LONG'));
t('3. durée : ≤ 10 min garde Précision (max 10) — la borne est incluse', elig(dur(10)).includes('precision'));
t('3. durée : c\'est le MAX qui compte — Passeur (3–8) passe à 8, pas à 7',
  elig(dur(8)).includes('passeur') && why(dur(7), 'passeur').includes('TOO_LONG'));
t('3. durée : le MIN n\'entre pas en jeu — Qui Ment ? (8–15) exclu à 10 bien que son min soit 8', why(dur(10), 'quiment').includes('TOO_LONG'));
t('3. durée : sans contrainte, rien n\'est écarté pour la durée', !Object.values(E.evaluate(session(3), GAMES).why).flat().some((r) => r.code === 'TOO_LONG'));
const tl = E.evaluate(dur(10), GAMES).why.demicercle.find((r) => r.code === 'TOO_LONG');
t('3. durée : la raison dit le max du jeu et la limite', tl.max === 15 && tl.limit === 10);

// ── 4. needs
const micro = (lesquels) => session(3, (s) => s.players.forEach((p, i) => { p.caps = { mic: lesquels.includes(i) }; }));
t('4. needs : Imitation exclue si UN joueur n\'a pas de micro', why(micro([0, 1]), 'imitation').includes('NEEDS'));
t('4. needs : la raison nomme le joueur sans micro',
  JSON.stringify(E.evaluate(micro([0, 1]), GAMES).why.imitation.find((r) => r.code === 'NEEDS').players) === '["p_2xxx"]');
t('4. needs : Imitation possible quand TOUS ont un micro', elig(micro([0, 1, 2])).includes('imitation'));
t('4. needs : une capacité absente vaut false (jamais supposée)', why(session(3, (s) => { s.players.forEach((p) => { p.caps = {}; }); }), 'imitation').includes('NEEDS'));
t('4. needs : le Ban demande le consentement de chacun',
  why(session(3, (s) => s.players.forEach((p, i) => { p.caps = { consent: i < 2 }; })), 'ban').includes('NEEDS')
  && elig(session(3, (s) => s.players.forEach((p) => { p.caps = { consent: true }; }))).includes('ban'));

// ── 5. veto
const veto = session(3, (s) => { s.players[1].veto = ['passeur']; });
t('5. veto : UN veto suffit à exclure', why(veto, 'passeur').includes('VETO') && !elig(veto).includes('passeur'));
t('5. veto : la raison nomme qui', JSON.stringify(E.evaluate(veto, GAMES).why.passeur.find((r) => r.code === 'VETO').players) === '["p_1xxx"]');
const vetoHote = session(3, (s) => { s.players[1].veto = ['passeur']; s.players[0].love = ['passeur']; s.players[2].love = ['passeur']; });
t('5. veto : les cœurs de l\'hôte et des autres ne le lèvent pas', !elig(vetoHote).includes('passeur'));
t('5. veto : jamais tiré, sur 2 000 tirages', (() => {
  const r = prng(7);
  for (let i = 0; i < 2000; i++) if (E.draw(veto, GAMES, r).gameId === 'passeur') return false;
  return true;
})());

// ── 6. love
const love = session(3, (s) => { s.players[0].love = ['passeur']; s.players[1].love = ['passeur']; });
const ev = E.evaluate(love, GAMES);
t('6. love : deux cœurs = poids 2 (1 + 0,5 × 2), un jeu neutre = 1', ev.weights.passeur === 2 && ev.weights.precision === 1);
t('6. love : n\'entre PAS dans le filtre — un cœur ne rend pas possible un jeu impossible',
  why(session(2, (s) => { s.players.forEach((p) => { p.love = ['quiment']; }); }), 'quiment').includes('TOO_FEW'));
t('6. love : le jeu aimé sort plus souvent, sans être systématique', (() => {
  const r = prng(11); let n = 0;
  for (let i = 0; i < 5000; i++) if (E.draw(love, GAMES, r).gameId === 'passeur') n++;
  // 4 jeux éligibles, poids 2+1+1+1 = 5 → attendu 40 %
  return n > 1800 && n < 2200;
})());
t('6. love + veto sur le même jeu : le veto l\'emporte (prefs)', (() => {
  const r = readPrefs({ love: ['passeur', 'ban'], veto: ['passeur'] }, null);
  return JSON.stringify(r.love) === '["ban"]' && JSON.stringify(r.veto) === '["passeur"]';
})());

// ── 7. récence
const rec = (played) => session(3, (s) => { s.history.played = played; });
t('7. récence : le jeu du tirage précédent pèse 0,15', E.evaluate(rec(['passeur']), GAMES).weights.passeur === 0.15);
t('7. récence : deux tirages avant → 0,4 ; trois → 0,7 ; quatre → 1',
  E.recency('passeur', ['passeur', 'quiment']) === 0.4 && E.recency('passeur', ['passeur', 'a', 'b']) === 0.7 && E.recency('passeur', ['passeur', 'a', 'b', 'c']) === 1);
t('7. récence : c\'est le DERNIER passage qui compte', E.recency('passeur', ['passeur', 'quiment', 'passeur']) === 0.15);
t('7. récence : réduit, n\'interdit pas — le jeu reste éligible', elig(rec(['passeur'])).includes('passeur'));
t('7. récence : à deux jeux possibles, le même peut retomber (rarement)', (() => {
  // 2 joueurs, micro/consent absents, Morpion en veto → demicercle, precision, passeur. On en exclut un de plus.
  const s = session(2, (x) => { x.players[0].veto = ['morpion', 'demicercle']; x.history.played = ['passeur']; });
  const r = prng(3); let meme = 0;
  for (let i = 0; i < 4000; i++) if (E.draw(s, GAMES, r).gameId === 'passeur') meme++;
  // poids : precision 1, passeur 0,15 → 13 % attendus
  return meme > 350 && meme < 700;
})());
t('7. récence × cœur : les deux se multiplient', E.evaluate(session(3, (s) => { s.players[0].love = ['passeur']; s.history.played = ['passeur']; }), GAMES).weights.passeur === 0.225);

// ── 8. la santé n'est PLUS dans le moteur
// Elle ne dit pas si un jeu convient au groupe, seulement si son serveur est
// réveillé — et elle n'intervient plus NULLE PART dans le tirage : le serveur
// d'un jeu se réveille tout seul quand la page du jeu s'y connecte, après
// « continuer » (test-candidat.js garde cette règle).
t('8. le moteur ne connaît pas la santé : aucun jeu n\'est écarté pour un serveur',
  !Object.values(E.evaluate(session(3), GAMES).why).flat().some((r) => r.code === 'SERVER_DOWN'));
t('8. évaluer ne prend que la session et le catalogue ; tirer, le hasard en plus',
  E.evaluate.length === 2 && E.draw.length === 3);
// ⚠️ Plus aucun moyen d'écarter un jeu au tirage pour une raison qui ne vienne
// pas des RÈGLES : l'option `exclure`, qui servait à recaler un candidat dont
// le serveur ne répondait pas, a disparu avec la boucle qui l'utilisait.
t('8. un serveur muet ne peut plus retirer un jeu du tirage (plus d\'échappatoire)', (() => {
  const ev = E.evaluate(session(3), GAMES, { exclure: ['passeur'] });   // option morte : ignorée
  return ev.eligible.includes('passeur') && ev.weights.passeur === 1 && !ev.why.passeur;
})());
t('8. … et le tirage garde toutes ses chances de tomber dessus', (() => {
  const r = prng(4);
  for (let i = 0; i < 500; i++) if (E.draw(session(3), GAMES, r, { exclure: ['passeur'] }).gameId === 'passeur') return true;
  return false;
})());

// ── 9. aucun jeu disponible
const vide = session(2, (s) => { s.players[0].veto = ['morpion', 'demicercle', 'precision', 'passeur']; });
const d9 = E.draw(vide, GAMES, prng(1));
t('9. aucun jeu : erreur explicite, pas de repli silencieux', d9.error === 'NO_ELIGIBLE_GAME' && !d9.gameId);
t('9. aucun jeu : chaque jeu garde sa raison', Object.keys(d9.why).length === 8, Object.keys(d9.why).join(','));
t('9. aucun jeu : pickWeighted sur une liste vide rend null', E.pickWeighted([], {}, () => 0.5) === null);

// ── 10. tirage pondéré
t('10. pondéré : la roue suit les poids (bornes exactes)',
  E.pickWeighted(['a', 'b', 'c'], { a: 1, b: 2, c: 1 }, seq(0)) === 'a'
  && E.pickWeighted(['a', 'b', 'c'], { a: 1, b: 2, c: 1 }, seq(0.25)) === 'b'
  && E.pickWeighted(['a', 'b', 'c'], { a: 1, b: 2, c: 1 }, seq(0.74)) === 'b'
  && E.pickWeighted(['a', 'b', 'c'], { a: 1, b: 2, c: 1 }, seq(0.75)) === 'c'
  && E.pickWeighted(['a', 'b', 'c'], { a: 1, b: 2, c: 1 }, seq(0.9999999)) === 'c');
t('10. pondéré : le résultat appartient TOUJOURS à la liste éligible', (() => {
  const r = prng(5); const s = session(3, (x) => { x.players[2].veto = ['quiment']; });
  for (let i = 0; i < 3000; i++) { const d = E.draw(s, GAMES, r); if (!d.eligible.includes(d.gameId) || d.gameId === 'quiment') return false; }
  return true;
})());
t('10. pondéré : sans préférence, répartition uniforme (±3 %)', (() => {
  const r = prng(9); const c = {}; const s = session(3);
  for (let i = 0; i < 8000; i++) { const g = E.draw(s, GAMES, r).gameId; c[g] = (c[g] || 0) + 1; }
  return Object.values(c).length === 4 && Object.values(c).every((v) => v > 1760 && v < 2240);
})());
t('10. l\'ordre est FILTRER → PONDÉRER → TIRER : un jeu exclu n\'a pas de poids',
  !('quiment' in E.evaluate(session(2), GAMES).weights));

// ── 11-13. history.played, tirages successifs, nouvelle session
const soir = session(3);
const suite = [];
const r13 = seq(0.1, 0.6, 0.9, 0.3);
for (let i = 0; i < 4; i++) {
  const d = E.draw(soir, GAMES, r13);
  suite.push(d.gameId);
  soir.history.played.push(d.gameId);   // ce que fait hub.js après un tirage
}
t('11. history.played : chaque tirage s\'ajoute, rien n\'est effacé',
  JSON.stringify(soir.history.played) === JSON.stringify(suite) && soir.history.played.length === 4, suite.join(' → '));
{
  // Poids attendus après la soirée, recalculés à la main depuis l'historique.
  const w = E.evaluate(soir, GAMES).weights;
  const attendu = (id) => E.recency(id, soir.history.played);
  t('12. tirages successifs : chaque poids suit l\'historique complet',
    w[suite[3]] === 0.15 && Object.keys(w).every((id) => w[id] === attendu(id)), JSON.stringify(w));
}
t('13. nouvelle session : historique vide', S.createSession('ZZZZZ').history.played.length === 0
  && S.createSession('ZZZZY').history.played !== soir.history.played);
t('13. nouvelle session : aucun frein de récence', Object.values(E.evaluate(session(3), GAMES).weights).every((w) => w === 1));

// ── 14-15. hôte et concurrence : ils vivent dans hub.js (le moteur ne connaît
// ni socket ni hôte) et sont testés sur de vraies connexions par test-draw.js.
t('14-15. le moteur est pur : même entrée + même hasard = même sortie', (() => {
  const a = E.draw(session(3), GAMES, seq(0.42));
  const b = E.draw(session(3), GAMES, seq(0.42));
  return a.gameId === b.gameId && JSON.stringify(a.eligible) === JSON.stringify(b.eligible);
})());
t('14-15. le moteur ne modifie pas la session (history reste au Hub)', (() => {
  const s = session(3); E.draw(s, GAMES, seq(0.5)); return s.history.played.length === 0;
})());

// ── entrées du client (prefs.js)
t('prefs : un id de jeu inconnu du catalogue est ignoré', readPrefs({ love: ['nimporte'] }, ['passeur']).love.length === 0);
t('prefs : forme invalide refusée', !!readPrefs({ veto: 'passeur' }).error && !!readPrefs({ love: [42] }).error);
t('caps : seul le vocabulaire fermé passe, en booléen', JSON.stringify(readCaps({ mic: true, root: true }).caps) === '{"mic":true}' && !!readCaps({ mic: 'oui' }).error);
t('constraints : null ou 1..240 minutes', readConstraints({ maxMinutes: null }).constraints.maxMinutes === null
  && readConstraints({ maxMinutes: 10 }).constraints.maxMinutes === 10 && !!readConstraints({ maxMinutes: 0 }).error && !!readConstraints({ maxMinutes: '10' }).error);

console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
