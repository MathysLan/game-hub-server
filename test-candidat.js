// Le tirage ne réveille QUE le serveur du candidat — et on le compte.
//
//   node test-candidat.js
//
// Ici, pas de réseau du tout : le vérificateur de santé est remplacé par un
// faux qui enregistre CHAQUE appel. C'est ce compteur qui prouve la règle —
// vérifier le seul résultat final ne dirait pas combien de serveurs ont été
// réveillés au passage.
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
// dit (avec le délai qu'on veut, pour observer l'état « réveil en cours »).
function fausseSante(reponses = {}, delais = {}) {
  const appels = [];
  return {
    appels,
    one: async (game) => { appels.push(game.id); await sleep(delais[game.id] || 0); return reponses[game.id] || 'up'; },
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

// Une session de trois joueurs, prête à tirer. Rend { hub, a, session }.
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
const tire = async (a, ms = 800) => { a.onmsg(JSON.stringify({ action: 'draw' })); await sleep(ms); };

async function main() {
  console.log('Tirage : un candidat, un seul serveur réveillé\n');

  // ── 1-2. trois jeux possibles, le premier candidat répond : UN seul appel
  {
    const sante = fausseSante();
    const { hub, a } = trio(sante);
    await tire(a);
    const s = dernier(a);
    t('1. trois jeux éligibles : UN seul serveur est vérifié', sante.appels.length === 1, sante.appels.join(',') || 'aucun');
    t('1. … celui du jeu tiré, et lui seul', sante.appels[0] === s.draw.gameId, `${sante.appels[0]} / ${s.draw.gameId}`);
    t('2. candidat disponible : aucune vérification de plus', sante.appels.length === 1 && s.draw.status === 'drawn');
    t('2. historique : le jeu confirmé, une seule fois', JSON.stringify(s.history.played) === JSON.stringify([s.draw.gameId]));
    t('2. le salon n\'écarte aucun jeu pour cause de serveur', !Object.values(s.pool.why).flat().some((r) => r.code === 'SERVER_DOWN'));
    hub.stop();
  }

  // ── 3-5. le premier candidat ne répond pas : on passe au suivant
  {
    // Hasard fixé : le premier candidat est le premier de la liste éligible.
    const sante = fausseSante({ passeur: 'down' });
    const { hub, a } = trio(sante, () => 0.001);
    await tire(a);
    const s = dernier(a);
    t('3. premier candidat indisponible : un deuxième est vérifié', sante.appels.length === 2 && sante.appels[0] === 'passeur', sante.appels.join(' → '));
    t('4. le deuxième répond : c\'est lui le résultat', s.draw.status === 'drawn' && s.draw.gameId === sante.appels[1], s.draw.gameId);
    t('4. … et il n\'a pas fallu vérifier le troisième', sante.appels.length === 2);
    t('4. … et la caisse ne fait pas défiler le jeu recalé',
      !s.draw.eligible.includes('passeur') && s.draw.eligible.length === 2, s.draw.eligible.join(','));
    t('5. le candidat KO n\'entre PAS dans l\'historique', JSON.stringify(s.history.played) === JSON.stringify([s.draw.gameId]) && !s.history.played.includes('passeur'));
    t('5. … et il n\'est pas pénalisé par la récence au tirage suivant', s.pool.weights.passeur === 1, JSON.stringify(s.pool.weights));
    hub.stop();
  }

  // ── 6. un seul disponible, après plusieurs échecs
  {
    const sante = fausseSante({ passeur: 'down', imitation: 'down' });
    const { hub, a } = trio(sante, () => 0.001);
    await tire(a);
    const s = dernier(a);
    t('6. deux serveurs muets : le troisième est tiré, trois vérifications en tout',
      s.draw.status === 'drawn' && s.draw.gameId === 'precision' && sante.appels.length === 3, sante.appels.join(' → '));
    t('6. historique : uniquement le jeu confirmé', JSON.stringify(s.history.played) === JSON.stringify(['precision']));
    hub.stop();
  }

  // ── 7. tous les candidats KO
  {
    const sante = fausseSante({ passeur: 'down', imitation: 'down', precision: 'down' });
    const { hub, a } = trio(sante, () => 0.001);
    await tire(a);
    const s = dernier(a);
    const err = erreurs(a).pop();
    t('7. tous les serveurs muets : aucun tirage confirmé', s.draw === null || s.draw.status !== 'drawn');
    t('7. … erreur explicite NO_SERVER_AVAILABLE', !!err && err.code === 'NO_SERVER_AVAILABLE', err && err.code);
    t('7. … l\'historique reste vide', JSON.stringify(s.history.played) === '[]');
    t('7. … la session revient au salon', s.state === 'lobby');
    t('7. … chaque jeu a été essayé une fois, pas plus', sante.appels.length === 3, sante.appels.join(' → '));
    hub.stop();
  }

  // ── 8-9. love, récence, veto : inchangés
  {
    const sante = fausseSante();
    const { hub, a } = trio(sante, () => 0.999);           // le dernier de la roue
    const s0 = dernier(a);
    t('8. poids : love et récence toujours calculés par le moteur', s0.pool.weights.passeur === 1 && s0.pool.eligible.length === 3);
    a.onmsg(JSON.stringify({ action: 'prefs', love: ['precision'], veto: ['imitation'] }));
    const s1 = dernier(a);
    t('9. veto : le jeu sort de la liste, avec sa raison', !s1.pool.eligible.includes('imitation') && s1.pool.why.imitation[0].code === 'VETO');
    t('8. love : le poids monte à 1,5', s1.pool.weights.precision === 1.5);
    await tire(a);
    const s2 = dernier(a);
    t('9. le jeu en veto n\'est jamais tiré ni vérifié', s2.draw.gameId !== 'imitation' && !sante.appels.includes('imitation'), sante.appels.join(','));
    a.onmsg(JSON.stringify({ action: 'continue' }));
    await sleep(50);
    await tire(a);
    const s3 = dernier(a);
    t('8. récence : le jeu du tirage précédent pèse 0,15 fois moins', s3.pool.weights[s2.draw.gameId] < 1, JSON.stringify(s3.pool.weights));
    t('8. deux tirages : deux entrées dans l\'historique', s3.history.played.length === 2);
    hub.stop();
  }

  // ── 10. deux tirages simultanés : toujours un seul
  {
    const sante = fausseSante({}, { passeur: 300, imitation: 300, precision: 300 });
    const { hub, a } = trio(sante, () => 0.001);
    a.onmsg(JSON.stringify({ action: 'draw' }));
    a.onmsg(JSON.stringify({ action: 'draw' }));
    await sleep(700);
    const s = dernier(a);
    t('10. deux draw simultanés : un seul tirage, un seul serveur réveillé',
      erreurs(a).some((e) => e.code === 'DRAW_IN_PROGRESS') && sante.appels.length === 1 && s.draw.status === 'drawn', sante.appels.join(','));
    t('10. … et une seule entrée d\'historique', s.history.played.length === 1);
    hub.stop();
  }

  // ── le client est prévenu qu'un réveil est en cours, SANS savoir de quel jeu
  {
    const sante = fausseSante({}, { passeur: 400, imitation: 400, precision: 400 });
    const { hub, a } = trio(sante, () => 0.001);
    a.onmsg(JSON.stringify({ action: 'draw' }));
    await sleep(150);
    const s = dernier(a);
    t('réveil : le client sait qu\'on réveille un serveur…', s.draw.status === 'pending' && s.draw.waking === true);
    t('… mais PAS lequel : la caisse n\'est pas éventée', s.draw.gameId === null);
    await sleep(600);
    t('réveil : une fois confirmé, le drapeau retombe', dernier(a).draw.waking === false && dernier(a).draw.status === 'drawn');
    hub.stop();
  }

  // ── une session qui se crée ne réveille RIEN
  {
    const sante = fausseSante();
    const { hub } = trio(sante);
    await sleep(200);
    t('création de session : aucun serveur de jeu n\'est réveillé (0 appel)', sante.appels.length === 0, sante.appels.join(','));
    hub.stop();
  }
}

main().then(() => {
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
}, (e) => { console.log('KO   EXCEPTION — ' + (e.stack || e.message)); process.exit(1); });
