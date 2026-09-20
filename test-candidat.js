// Le tirage ne consulte AUCUN /health — et on le compte.
//
//   node test-candidat.js
//
// Ici, pas de réseau du tout : le vérificateur de santé est remplacé par un
// faux qui enregistre CHAQUE appel. C'est ce compteur qui prouve la règle —
// vérifier le seul résultat final ne dirait pas combien de serveurs ont été
// interrogés au passage.
//
// ⚠️⚠️ LA RÈGLE QUE CE FICHIER GARDE : un serveur de jeu endormi (Render, plan
// gratuit : ~30 s de réveil) ne doit JAMAIS empêcher un tirage. Le Hub tire
// selon les seules règles — joueurs, besoins, veto, durée, cœurs, récence — et
// révèle. Le serveur du jeu se réveille plus tard et tout seul : après
// « continuer », la page du jeu s'y connecte, et c'est elle qui le réveille.
//
// Les deux versions précédentes vérifiaient la santé des sept serveurs avant
// de tirer (ce qui réveillait tout le parc), puis celle du seul candidat (ce
// qui pouvait encore recaler un jeu parfaitement valable). Les deux
// transformaient une soirée en panne. Si un `await health…` réapparaît un jour
// dans onDraw, c'est ce fichier qui le dira.
'use strict';

const { createHub } = require('./src/hub.js');

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Catalogue : trois jeux jouables à trois, sans besoin particulier.
const jeu = (id) => ({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min: 1, max: 8 }, minutes: { min: 1, max: 10 }, needs: [], categories: ['reflexe'],
  server: `wss://${id}.example`, health: `https://${id}.example/`, join: 'v1', content: false, replay: false, handoff: false });
const GAMES = [jeu('passeur'), jeu('imitation'), jeu('precision')];
const catalog = { load: () => Promise.resolve(GAMES), get: () => GAMES, status: () => 'ready' };

// Un faux vérificateur de santé : il compte les appels, et répond ce qu'on lui
// dit. `reponses` sert à rendre des serveurs MORTS — ils doivent quand même
// pouvoir être tirés.
function fausseSante(reponses = {}, delais = {}) {
  const appels = [];
  return {
    appels,
    one: async (game) => { appels.push(game.id); await sleep(delais[game.id] || 0); return reponses[game.id] || 'up'; },
    check: async (game) => { appels.push(game.id); await sleep(delais[game.id] || 0); return reponses[game.id] || 'up'; },
    status: (id) => reponses[id] || 'unknown',
    snapshot: (games) => Object.fromEntries((games || []).map((g) => [g.id, reponses[g.id] || 'unknown'])),
    markDown: () => {},
  };
}

// Un « socket » qui garde ce qu'on lui envoie : le hub ne connaît que cette
// forme-là (readyState, send, on, close).
function faux() {
  const s = { readyState: 1, recu: [], on(ev, fn) { if (ev === 'message') s.onmsg = fn; }, send(x) { s.recu.push(JSON.parse(x)); }, close() {} };
  return s;
}
const P = (id, name) => ({ id, name, avatar: { kind: 'emoji', emoji: '🦊' } });
const dernier = (s) => { const m = [...s.recu].reverse().find((x) => x.session); return m && m.session; };
const erreurs = (s) => s.recu.filter((x) => x.type === 'error');

// Une session de trois joueurs, prête à tirer. Rend { hub, a, code }.
function trio(sante, random) {
  const hub = createHub({ heartbeatMs: 0, catalog, health: sante, random: random || (() => 0.001) });
  const a = faux(); hub.connection(a);
  a.onmsg(JSON.stringify({ action: 'create', player: P('p_aaaa', 'A') }));
  const code = dernier(a).code;
  for (const [id, nom] of [['p_bbbb', 'B'], ['p_cccc', 'C']]) {
    const s = faux(); hub.connection(s);
    s.onmsg(JSON.stringify({ action: 'join', code, player: P(id, nom) }));
  }
  return { hub, a, code };
}
const tire = async (a, ms = 400) => { a.onmsg(JSON.stringify({ action: 'draw' })); await sleep(ms); };

async function main() {
  console.log('Tirage : les règles seules, aucun /health\n');

  // ── 1-2. trois jeux possibles : un jeu tiré, zéro serveur interrogé
  {
    const sante = fausseSante();
    const { hub, a } = trio(sante);
    await tire(a);
    const s = dernier(a);
    t('1. un jeu est tiré', s.draw.status === 'drawn' && GAMES.some((g) => g.id === s.draw.gameId), s.draw.gameId);
    t('1. AUCUN serveur de jeu n\'est interrogé pendant le tirage', sante.appels.length === 0, sante.appels.join(',') || 'aucun appel');
    t('2. historique : le jeu tiré, une seule fois', JSON.stringify(s.history.played) === JSON.stringify([s.draw.gameId]));
    t('2. le salon n\'écarte aucun jeu pour cause de serveur', !Object.values(s.pool.why).flat().some((r) => r.code === 'SERVER_DOWN'));
    t('2. les trois jeux restent éligibles', s.pool.eligible.length === 3);
    hub.stop();
  }

  // ── 3-5. LE CAS QUI COMPTE : les trois serveurs sont morts
  {
    const sante = fausseSante({ passeur: 'down', imitation: 'down', precision: 'down' });
    const { hub, a } = trio(sante, () => 0.001);
    await tire(a);
    const s = dernier(a);
    t('3. trois serveurs morts : un jeu est quand même tiré', s.draw.status === 'drawn' && !!s.draw.gameId, s.draw.gameId);
    t('3. … et aucune erreur n\'est envoyée', erreurs(a).length === 0, erreurs(a).map((e) => e.code).join(','));
    t('4. … toujours aucun serveur interrogé', sante.appels.length === 0, sante.appels.join(',') || 'aucun appel');
    t('5. … l\'historique retient le jeu tiré', JSON.stringify(s.history.played) === JSON.stringify([s.draw.gameId]));
    t('5. … la session est en « drawing », prête pour « continuer »', s.state === 'drawing');
    hub.stop();
  }

  // ── 6. un seul jeu possible, son serveur mort : c'est LUI qui sort
  {
    const sante = fausseSante({ passeur: 'down', imitation: 'down', precision: 'down' });
    const { hub, a } = trio(sante, () => 0.001);
    a.onmsg(JSON.stringify({ action: 'prefs', love: [], veto: ['imitation', 'precision'] }));
    await sleep(20);
    await tire(a);
    const s = dernier(a);
    t('6. seul Passeur est possible, son serveur est mort : Passeur est tiré',
      s.draw.gameId === 'passeur' && s.draw.status === 'drawn', s.draw.gameId);
    t('6. … sans le moindre appel de santé', sante.appels.length === 0, sante.appels.join(',') || 'aucun appel');
    hub.stop();
  }

  // ── 7. aucun jeu POSSIBLE : ça, c'est une vraie raison de refuser
  {
    const sante = fausseSante();
    const { hub, a } = trio(sante, () => 0.001);
    a.onmsg(JSON.stringify({ action: 'prefs', love: [], veto: ['passeur', 'imitation', 'precision'] }));
    await sleep(20);
    await tire(a);
    const s = dernier(a);
    const err = erreurs(a).pop();
    t('7. tous les jeux en veto : aucun tirage', s.draw === null || s.draw.status !== 'drawn');
    t('7. … erreur NO_ELIGIBLE_GAME (le GROUPE, pas les serveurs)', !!err && err.code === 'NO_ELIGIBLE_GAME', err && err.code);
    t('7. … chaque jeu garde sa raison', !!err && Object.keys(err.why || {}).length === 3);
    t('7. … l\'historique reste vide', JSON.stringify(s.history.played) === '[]');
    t('7. … la session revient au salon', s.state === 'lobby');
    hub.stop();
  }

  // ── 8-9. règles inchangées : cœurs, récence, veto
  {
    const sante = fausseSante();
    const { hub, a } = trio(sante, () => 0.999);           // le dernier de la roue
    const s0 = dernier(a);
    t('8. poids : cœurs et récence toujours calculés par le moteur', s0.pool.weights.passeur === 1 && s0.pool.eligible.length === 3);
    a.onmsg(JSON.stringify({ action: 'prefs', love: ['precision'], veto: ['imitation'] }));
    const s1 = dernier(a);
    t('9. veto : le jeu sort de la liste, avec sa raison', !s1.pool.eligible.includes('imitation') && s1.pool.why.imitation[0].code === 'VETO');
    t('8. cœur : le poids monte à 1,5', s1.pool.weights.precision === 1.5);
    await tire(a);
    const s2 = dernier(a);
    t('9. le jeu en veto n\'est jamais tiré', s2.draw.gameId !== 'imitation', s2.draw.gameId);
    a.onmsg(JSON.stringify({ action: 'continue' }));
    await sleep(20);
    await tire(a);
    const s3 = dernier(a);
    t('8. récence : le jeu du tirage précédent pèse moins', s3.pool.weights[s2.draw.gameId] < 1, JSON.stringify(s3.pool.weights));
    t('8. deux tirages : deux entrées dans l\'historique', s3.history.played.length === 2);
    t('8. … et toujours aucun appel de santé', sante.appels.length === 0, sante.appels.join(',') || 'aucun appel');
    hub.stop();
  }

  // ── 10. deux tirages simultanés : toujours un seul
  {
    const sante = fausseSante();
    const { hub, a } = trio(sante, () => 0.001);
    a.onmsg(JSON.stringify({ action: 'draw' }));
    a.onmsg(JSON.stringify({ action: 'draw' }));
    await sleep(300);
    const s = dernier(a);
    t('10. deux draw simultanés : un seul tirage, le second refusé',
      erreurs(a).some((e) => e.code === 'DRAW_IN_PROGRESS') && s.draw.status === 'drawn');
    t('10. … et une seule entrée d\'historique', s.history.played.length === 1);
    hub.stop();
  }

  // ── 11. le tirage est IMMÉDIAT — c'est ça, la correction
  {
    // Un vérificateur de santé qui met 5 s à répondre : s'il était encore dans
    // le chemin du tirage, la révélation arriverait 5 s trop tard.
    const sante = fausseSante({}, { passeur: 5000, imitation: 5000, precision: 5000 });
    const { hub, a } = trio(sante, () => 0.001);
    const t0 = Date.now();
    a.onmsg(JSON.stringify({ action: 'draw' }));
    await sleep(30);
    const ms = Date.now() - t0;
    const s = dernier(a);
    t('11. le jeu est révélé tout de suite, même avec une santé très lente',
      s.draw.status === 'drawn' && !!s.draw.gameId && ms < 500, `${ms} ms, ${s.draw.gameId}`);
    t('11. … et la santé n\'a pas été sollicitée du tout', sante.appels.length === 0, sante.appels.join(',') || 'aucun appel');
    hub.stop();
  }

  // ── 12. une session qui se crée ne réveille rien non plus
  {
    const sante = fausseSante();
    const { hub } = trio(sante);
    await sleep(150);
    t('12. création de session : aucun serveur de jeu réveillé', sante.appels.length === 0, sante.appels.join(',') || 'aucun appel');
    hub.stop();
  }
}

main().then(() => {
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
}, (e) => { console.log('KO   EXCEPTION — ' + (e.stack || e.message)); process.exit(1); });
