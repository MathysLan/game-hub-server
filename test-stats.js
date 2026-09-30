// Statistiques de joueur (lot H) : les définitions (stats.js), le stockage
// (store-memory.js, et store-pg.js si une base de test est donnée), puis le
// protocole sur de VRAIES connexions WebSocket.
//
//   node test-stats.js
//   TEST_DATABASE_URL=postgres://… node test-stats.js   + le même scénario en SQL
//
// ⚠️ La base de TEST est vidée (ses tables hub_*) : jamais celle de production.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const ST = require('./src/stats.js');
const SC = require('./src/scores.js');
const { createMemoryStore } = require('./src/store-memory.js');
const { createHub } = require('./src/hub.js');
const { createCatalog } = require('./src/catalog.js');
const { createHealth } = require('./src/health.js');

const PORT = +(process.env.PORT || 8807);
let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════ définitions
console.log('Statistiques de joueur — définitions (stats.js)\n');
// Un classement comme le Hub le relit, et les places déclarées par chacun.
const rows = (...r) => r.map(([seat, rank]) => ({ seat, rank, points: 0 }));
const tous = () => true;
{
  const seats = { p_a: 'a', p_b: 'b', p_c: 'c' };
  const l = ST.playsFor(rows(['c', 3], ['a', 1], ['b', 1]), seats, tous);
  const de = (id) => l.find((p) => p.playerId === id);
  t('ex æquo 1, 1, 3 : les rangs du jeu, tels quels, et combien derrière', same([de('p_a'), de('p_b'), de('p_c')].map((p) => [p.rank, p.ranked, p.behind]), [[1, 3, 1], [1, 3, 1], [3, 3, 0]]));
  t('ex æquo 1, 1, 3 : les deux 1ers gagnent, le 3e est au podium', ST.isWin(de('p_a')) && ST.isWin(de('p_b')) && !ST.isWin(de('p_c')) && ST.isPodium(de('p_c')));
  t('points : les points de soirée de la partie (même conversion que scores.js)', de('p_a').points === SC.sessionPoints(1, 3) && de('p_c').points === 10);
}
{
  const l = ST.playsFor(rows(['a', 1]), { p_a: 'a' }, tous);
  t('solo : une partie, pas une victoire, pas un podium', l.length === 1 && ST.isSolo(l[0]) && !ST.isWin(l[0]) && !ST.isPodium(l[0]));
}
{
  const l = ST.playsFor(rows(['a', 1], ['b', 2]), { p_a: 'a', p_b: 'b' }, tous);
  t('2 joueurs : 1er = victoire + podium ; 2e = podium, pas victoire', ST.isWin(l[0]) && ST.isPodium(l[0]) && !ST.isWin(l[1]) && ST.isPodium(l[1]));
  const nul = ST.playsFor(rows(['x', 1], ['o', 1]), { p_x: 'x', p_o: 'o' }, tous);
  t('nul du Morpion (1 / 1) : personne derrière → ni l\'un ni l\'autre ne gagne, mais podium', nul.every((p) => !ST.isWin(p) && ST.isPodium(p)));
}
{
  const n9 = Array.from({ length: 9 }, (_, i) => ['s' + i, i + 1]);
  const seats = Object.fromEntries(n9.map(([s]) => ['p_' + s, s]));
  const l = ST.playsFor(rows(...n9), seats, tous);
  const r = (k) => l.find((p) => p.rank === k);
  t('9 joueurs : 3e au podium, 4e ni podium ni victoire, 9e rien', ST.isPodium(r(3)) && !ST.isPodium(r(4)) && !ST.isWin(r(4)) && !ST.isPodium(r(9)) && r(1).behind === 8);
}
{
  // Une place inconnue du Hub (entré sans passer par lui) occupe son rang ;
  // un joueur sans clé vérifiée n'est pas enregistré ; un PARTI l'est.
  const l = ST.playsFor(rows(['a', 1], ['inconnu', 2], ['b', 3]), { p_a: 'a', p_b: 'b', p_sansCle: 'z' }, (id) => id !== 'p_sansCle');
  t('place inconnue : elle compte dans les classés, pas de ligne pour elle', l.length === 2 && l.every((p) => p.ranked === 3) && l.find((p) => p.playerId === 'p_b').rank === 3);
  const v = ST.playsFor(rows(['a', 1], ['z', 2]), { p_a: 'a', p_sansCle: 'z' }, (id) => id !== 'p_sansCle');
  t('clé non vérifiée : aucune ligne pour ce joueur', v.length === 1 && v[0].playerId === 'p_a');
}
{
  const g = ST.perGame([
    { gameId: 'passeur', rank: 1, ranked: 3, behind: 2, points: 30 },
    { gameId: 'passeur', rank: 2, ranked: 3, behind: 1, points: 20 },
    { gameId: 'passeur', rank: 1, ranked: 1, behind: 0, points: 10 },      // solo
    { gameId: 'morpion', rank: 1, ranked: 2, behind: 0, points: 20 },      // nul
    { gameId: 'morpion', rank: 4, ranked: 5, behind: 1, points: 20 },
  ]);
  const s = ST.summarize(g);
  t('résumé : 5 parties dont 1 solo, 1 victoire, 3 podiums, meilleure place 1', s.played === 5 && s.solo === 1 && s.wins === 1 && s.podiums === 3 && s.best === 1, JSON.stringify(s));
  const p = s.games.find((x) => x.gameId === 'passeur'), m = s.games.find((x) => x.gameId === 'morpion');
  t('par jeu : Passeur 3 (1 solo, 1 victoire, 2 podiums, 1er) ; Morpion 2 (0 victoire, 1 podium, 1er)',
    same([p.played, p.solo, p.wins, p.podiums, p.best], [3, 1, 1, 2, 1]) && same([m.played, m.solo, m.wins, m.podiums, m.best], [2, 0, 0, 1, 1]));
  t('par jeu : le plus joué d\'abord ; les points ne sortent pas', s.games[0].gameId === 'passeur' && !JSON.stringify(s).includes('points'));
  const solo = ST.summarize(ST.perGame([{ gameId: 'precision', rank: 1, ranked: 1, behind: 0, points: 10 }]));
  t('que du solo : meilleure place absente (aucun adversaire), 0 victoire', solo.best === null && solo.wins === 0 && solo.played === 1 && solo.solo === 1);
  t('aucune partie : un résumé vide (pas de liste de jeux)', same(ST.summarize([]), { played: 0, solo: 0, wins: 0, podiums: 0, best: null, games: [] }));
}
{
  t('clé : 32 à 64 caractères [A-Za-z0-9_-], rien d\'autre', !!ST.readKey('a'.repeat(32)) && !!ST.readKey('Az09_-'.repeat(8)) && !ST.readKey('a'.repeat(31))
    && !ST.readKey('a'.repeat(65)) && !ST.readKey('<script>'.repeat(5)) && !ST.readKey(42) && !ST.readKey(null));
  t('clé : seule son empreinte (sha256) est gardée', ST.hashKey('k'.repeat(32)).length === 64 && ST.hashKey('k'.repeat(32)) !== 'k'.repeat(32));
}

// ═══════════════════════════════════════════════════════════ stockage
async function scenarioStore(store, nom) {
  const r1 = await store.register('p_st1', 'h1'), r2 = await store.register('p_st1', 'h1'), r3 = await store.register('p_st1', 'h2');
  t(`${nom} : 1er passage « new », même clé « ok », autre clé « mismatch »`, same([r1, r2, r3], ['new', 'ok', 'mismatch']));
  await store.register('p_st2', 'h2');
  const partie = [{ playerId: 'p_st1', rank: 1, ranked: 2, behind: 1, points: 20 }, { playerId: 'p_st2', rank: 2, ranked: 2, behind: 0, points: 10 }];
  const n1 = await store.record('d_st1', 'ABCDE', 'passeur', partie);
  const n2 = await store.record('d_st1', 'ABCDE', 'passeur', partie);
  t(`${nom} : une partie enregistrée deux fois ne compte qu'une fois (clé tirage + joueur)`, n1 === 2 && n2 === 0, `${n1} puis ${n2}`);
  const n3 = await store.record('d_st2', 'ABCDE', 'passeur', [{ playerId: 'p_inconnu', rank: 1, ranked: 1, behind: 0, points: 10 }]);
  t(`${nom} : un id jamais enregistré n'écrit rien`, n3 === 0);
  await store.record('d_st3', 'FGHJK', 'morpion', [{ playerId: 'p_st1', rank: 1, ranked: 2, behind: 0, points: 20 }]);
  await store.record('d_st4', 'FGHJK', 'precision', [{ playerId: 'p_st1', rank: 1, ranked: 1, behind: 0, points: 10 }]);
  const g = (await store.perGame('p_st1')).sort((a, b) => (a.gameId < b.gameId ? -1 : 1));
  return g;
}

// ═══════════════════════════════════════════════════════ protocole, vraies connexions
const on = (id) => ({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online', players: { min: 1, max: 12 }, minutes: { min: 1, max: 8 },
  needs: [], categories: ['reflexe'], server: `wss://${id}.example`, health: `http://127.0.0.1:1/${id}`, join: 'v1', content: false, replay: false, handoff: true });
const JEUX = ['passeur', 'demicercle', 'precision'];
const FICHIER = path.join(os.tmpdir(), `hub-stats-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: JEUX.map(on) }));

let panne = false;
const store = createMemoryStore({ down: () => panne });
const catalog = createCatalog({ file: FICHIER });
const hub = createHub({ graceMs: 3000, heartbeatMs: 0, catalog, health: createHealth({ timeoutMs: 300 }), statsStore: store, statsRetryMs: [150, 400] });
// Un second Hub, SANS stockage : la soirée doit y marcher comme avant.
const hubSans = createHub({ graceMs: 3000, heartbeatMs: 0, catalog, health: createHealth({ timeoutMs: 300 }) });
const serveur = (h) => { const s = createServer((_q, r) => { r.writeHead(200); r.end('ok'); }); new WebSocketServer({ server: s }).on('connection', (ws) => h.connection(ws)); return s; };
const server = serveur(hub), serverSans = serveur(hubSans);

function client(nom, port = PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, nom, msgs: [] };
  ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  ws.on('error', () => {});
  c.open = new Promise((res) => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.mark = () => c.msgs.length;
  c.waitFor = (pred, ms = 3000, from = 0) => new Promise((resolve, reject) => {
    const fin = Date.now() + ms;
    const voir = () => {
      const m = c.msgs.slice(from).reverse().find(pred);
      if (m) return resolve(m);
      if (Date.now() > fin) return reject(new Error(`${nom} : condition non atteinte en ${ms} ms`));
      setTimeout(voir, 10);
    };
    voir();
  });
  c.until = (pred, ms, from) => c.waitFor((m) => m.type === 'session' && pred(m.session), ms, from).then((m) => m.session);
  c.error = (code, ms, from) => c.waitFor((m) => m.type === 'error' && m.code === code, ms, from);
  c.last = () => { const m = [...c.msgs].reverse().find((x) => x.session); return m && m.session; };
  // SES statistiques, demandées au Hub.
  c.stats = async () => { const m = c.mark(); c.send({ action: 'stats' }); return c.waitFor((x) => x.type === 'stats', 3000, m); };
  c.fermer = () => new Promise((res) => { if (ws.readyState === ws.CLOSED) return res(); ws.once('close', res); ws.close(); });
  return c;
}
const cle = (lettre) => (lettre + 'k').repeat(20);          // 40 caractères, une clé par joueur
const P = (id, name, key) => Object.assign({ id, name, avatar: { kind: 'emoji', emoji: '🦊' } }, key ? { key } : {});
async function entre(nom, id, code, key, port) {
  const c = client(nom, port); await c.open;
  const player = P(id, nom, key);
  c.send(code ? { action: 'join', code, player } : { action: 'create', player });
  c.accueil = await c.waitFor((m) => m.type === 'joined' || m.type === 'created' || m.type === 'error');
  await sleep(30);                                          // la vérification de la clé est asynchrone
  return c;
}
// Une partie : l'hôte force le jeu (veto sur les autres), tire, lance ; chacun
// s'assoit à SA place ; `rangs` = { nom: rang }. `avantResultats` s'exécute
// quand tout le monde est assis (un départ, par exemple). Rend le drawId.
async function partie(hote, autres, gameId, rangs, avantResultats) {
  hote.send({ action: 'prefs', love: [], veto: JEUX.filter((g) => g !== gameId) });
  await hote.until((s) => s.pool && same(s.pool.eligible, [gameId]), 3000);
  let m = hote.mark();
  hote.send({ action: 'draw' });
  const d = (await hote.until((s) => s.draw && s.draw.status === 'drawn', 4000, m)).draw;
  m = hote.mark(); hote.send({ action: 'continue' }); await hote.until((s) => s.state === 'launching', 3000, m);
  hote.send({ action: 'launched', drawId: d.id, roomCode: 'KQMP', gamePlayerId: 'g-' + hote.nom });
  for (const c of autres) {
    await c.until((s) => s.launch && s.launch.drawId === d.id && s.launch.stage === 'join', 3000);
    c.send({ action: 'entered', drawId: d.id, roomCode: 'KQMP', gamePlayerId: 'g-' + c.nom });
  }
  await hote.until((s) => s.state === 'inGame', 3000);
  if (avantResultats) await avantResultats();
  const results = [hote, ...autres].map((c) => ({ gamePlayerId: 'g-' + c.nom, rank: rangs[c.nom], points: 100 - rangs[c.nom] }));
  m = hote.mark();
  hote.send({ action: 'results', drawId: d.id, gameId, results });
  await hote.until((s) => s.history.games.some((g) => g.drawId === d.id), 3000, m);
  hote.derniers = results;
  m = hote.mark(); hote.send({ action: 'ended', drawId: d.id }); await hote.until((s) => s.state === 'debrief', 3000, m);
  await sleep(40);                                          // l'écriture des stats est asynchrone
  return d.id;
}
const S = (x) => x.stats;
const resume = (s) => s && [s.played, s.wins, s.podiums, s.best];

async function protocole() {
  console.log('\nStatistiques de joueur — protocole, vraies connexions\n');
  const a = await entre('Ana', 'p_ana1', null, cle('a'));
  const code = a.last().code;
  t('created : le Hub annonce qu\'il sait répondre aux statistiques', a.accueil.stats === true);
  const b = await entre('Bob', 'p_bob1', code, cle('b'));
  const c = await entre('Cam', 'p_cam1', code, cle('c'));
  const d = await entre('Dan', 'p_dan1', code, cle('d'));
  const x = await entre('Xav', 'p_xav1', code);             // ancien client : aucune clé
  t('joined : annoncé aussi aux invités (et à un client sans clé)', b.accueil.stats === true && x.accueil.type === 'joined' && x.accueil.stats === true);
  t('la clé ne part JAMAIS dans l\'état public de la session', !JSON.stringify(a.last()).includes(cle('b')) && !JSON.stringify(a.msgs).includes('kbkbkb'));
  const s0 = await a.stats();
  t('A. nouveau joueur : aucune partie, un résumé vide', same(S(s0), { played: 0, solo: 0, wins: 0, podiums: 0, best: null, games: [] }), JSON.stringify(s0));
  t('sans clé : UNVERIFIED (la soirée continue, sans statistiques)', (await x.stats()).reason === 'UNVERIFIED');

  // B–F. Une partie à cinq : 1 Ana, 2 Bob, 3 Cam, 4 Dan, 5 Xav.
  await a.until((s) => s.pool && s.pool.catalog === 'ready' && s.players.length === 5, 4000);
  await partie(a, [b, c, d, x], 'passeur', { Ana: 1, Bob: 2, Cam: 3, Dan: 4, Xav: 5 });
  const sa = S(await a.stats()), sb = S(await b.stats()), sc = S(await c.stats()), sd = S(await d.stats());
  t('B/C. 1re place : 1 partie, 1 victoire, 1 podium, meilleure place 1', same(resume(sa), [1, 1, 1, 1]), JSON.stringify(sa));
  t('D. 2e place : 1 podium, pas de victoire, meilleure place 2', same(resume(sb), [1, 0, 1, 2]), JSON.stringify(sb));
  t('E. 3e place : 1 podium', same(resume(sc), [1, 0, 1, 3]));
  t('F. 4e place : ni victoire ni podium, meilleure place 4', same(resume(sd), [1, 0, 0, 4]));
  t('le score de soirée n\'a pas changé de règle (5 classés : 50 / 40 / 30 / 20 / 10)',
    same(a.last().scores, { p_ana1: 50, p_bob1: 40, p_cam1: 30, p_dan1: 20, p_xav1: 10 }), JSON.stringify(a.last().scores));
  // Xav (sans clé) a joué sans statistiques ; il s'en va (sinon les parties
  // suivantes attendraient son entrée jusqu'à l'échéance du lancement).
  t('client sans clé : sa partie ne laisse aucune ligne', same(await store.perGame('p_xav1'), []));
  x.send({ action: 'leave' });
  await a.until((s) => !s.players.some((p) => p.id === 'p_xav1'), 2000);

  // I. Le classement renvoyé : refusé par le Hub, et rien de recompté.
  const lignes = store._size();
  let m = a.mark();
  const dernier = a.last().history.games[0].drawId;
  a.send({ action: 'results', drawId: dernier, gameId: 'passeur', results: a.derniers });
  const refus = await a.waitFor((y) => y.type === 'error', 2000, m);
  t('I. results renvoyé : refusé (le lancement est terminé), aucune ligne de plus', ['RESULTS_ALREADY', 'LAUNCH_MISMATCH', 'NOT_LAUNCHING'].includes(refus.code) && store._size() === lignes, refus.code);

  // J + L. Reconnexion de Bob, sous un AUTRE pseudo : mêmes statistiques.
  await b.fermer();
  const b2 = await entre('Bobby', 'p_bob1', code, cle('b'));
  t('J/L. reconnexion (même id, même clé, pseudo changé) : mêmes statistiques', same(S(await b2.stats()), sb));

  // Quelqu'un reprend l'id de Bob avec une AUTRE clé : ni lecture ni écriture.
  const intrus = await entre('Bob', 'p_bob1', code, cle('z'));
  const vu = await intrus.stats();
  t('clé d\'un autre : UNVERIFIED — les stats de Bob ne se lisent pas', vu.stats === null && vu.reason === 'UNVERIFIED');
  await intrus.fermer();
  const b3 = await entre('Bob', 'p_bob1', code, cle('b'));
  await b3.until((s) => s.players.find((p) => p.id === 'p_bob1').connected, 2000);

  // G. Ex æquo en tête, sur un autre jeu : Ana et Bob gagnent tous les deux.
  // H. Cam part de la session APRÈS s'être assise : sa partie compte quand même.
  await partie(a, [b3, c, d], 'demicercle', { Ana: 1, Bob: 1, Cam: 3, Dan: 4 }, async () => {
    c.send({ action: 'leave' });
    await a.until((s) => !s.players.some((p) => p.id === 'p_cam1'), 2000);
  });
  const ga = S(await a.stats()), gb = S(await b3.stats()), gd = S(await d.stats());
  t('G. ex æquo 1er : les DEUX 1ers ont une victoire de plus', ga.wins === 2 && gb.wins === 1, `${ga.wins} / ${gb.wins}`);
  t('H. Cam, partie de la session : pas de points de soirée…', !('p_cam1' in a.last().scores) || a.last().scores.p_cam1 === 30);
  const cam = await store.perGame('p_cam1');
  t('H. … mais sa partie est comptée dans SES statistiques (3e, podium)', same(cam.map((g) => [g.gameId, g.played, g.podiums]).sort(), [['demicercle', 1, 1], ['passeur', 1, 1]]), JSON.stringify(cam));
  t('K. plusieurs jeux : ventilées par jeu (Ana : Passeur 1, Demi-Cercle 1)',
    same(ga.games.map((g) => [g.gameId, g.played, g.wins]).sort(), [['demicercle', 1, 1], ['passeur', 1, 1]]) && ga.played === 2, JSON.stringify(ga.games));
  t('K. Dan : 4e deux fois, jamais au podium', same(resume(gd), [2, 0, 0, 4]));

  // M. Stockage injoignable : la soirée continue, le score de soirée est juste,
  // et la ligne arrive dès que la base revient (nouvelle tentative).
  panne = true;
  const avant = store._size();
  const scoreAvant = a.last().scores.p_ana1;
  await partie(a, [b3, d], 'precision', { Ana: 2, Bob: 1, Dan: 3 });
  t('M. base en panne : la partie et le score de soirée passent quand même', a.last().scores.p_ana1 === scoreAvant + 20, `${scoreAvant} → ${a.last().scores.p_ana1}`);
  const enPanne = await a.stats();
  t('M. base en panne : les stats répondent UNAVAILABLE (jamais un faux zéro)', enPanne.stats === null && enPanne.reason === 'UNAVAILABLE');
  panne = false;
  await sleep(700);
  t('M. la base revient : la partie est enregistrée par une nouvelle tentative, une seule fois', store._size() === avant + 3, `${avant} → ${store._size()}`);
  const pa = S(await a.stats());
  t('M. … et apparaît dans les stats (Précision : 1 partie, 2e)', pa.played === 3 && same(pa.games.find((g) => g.gameId === 'precision').best, 2));

  // Solo : une partie, pas une victoire, pas de meilleure place.
  const solo = await entre('Sol', 'p_sol1', null, cle('s'));
  await solo.until((s) => s.pool && s.pool.catalog === 'ready', 4000);
  await partie(solo, [], 'precision', { Sol: 1 });
  const ss = S(await solo.stats());
  t('solo : 1 partie « dont 1 en solo », 0 victoire, 0 podium, pas de meilleure place', same([ss.played, ss.solo, ss.wins, ss.podiums, ss.best], [1, 1, 0, 0, null]), JSON.stringify(ss));

  // 9 joueurs dans une même partie.
  const n9 = [solo];
  for (let i = 2; i <= 9; i++) n9.push(await entre('N' + i, 'p_nn' + i, solo.last().code, cle(String(i))));
  await solo.until((s) => s.players.length === 9, 3000);
  await partie(solo, n9.slice(1), 'passeur', Object.fromEntries(n9.map((c2, i) => [c2.nom, i + 1])));
  const s4 = S(await n9[3].stats()), s9 = S(await n9[8].stats()), s3 = S(await n9[2].stats());
  t('9 joueurs : 3e au podium ; 4e et 9e ni victoire ni podium', s3.podiums === 1 && s4.podiums === 0 && s4.wins === 0 && s9.best === 9 && s9.podiums === 0);
  t('9 joueurs : le solo et la partie à 9 sont bien séparés pour Sol (2 parties, 1 victoire, 1 solo)', same(resume(S(await solo.stats())), [2, 1, 1, 1]));

  // Un Hub SANS stockage : la soirée marche comme avant, les stats le disent.
  const z = await entre('Zoé', 'p_zoe1', null, cle('z'), PORT + 1);
  t('Hub sans stockage : created annonce stats: false, la session marche', z.accueil.type === 'created' && z.accueil.stats === false);
  t('Hub sans stockage : stats → UNAVAILABLE', (await z.stats()).reason === 'UNAVAILABLE');

  // Hors session : refus propre.
  const seul = client('Seul'); await seul.open;
  m = seul.mark(); seul.send({ action: 'stats' });
  t('hors session : NOT_IN_SESSION', !!(await seul.error('NOT_IN_SESSION', 2000, m)));
  for (const k of [a, b2, b3, c, d, x, solo, z, seul, ...n9.slice(1)]) await k.fermer();
}

(async () => {
  // Stockage en mémoire.
  console.log('\nStatistiques de joueur — stockage\n');
  const mem = await scenarioStore(createMemoryStore(), 'mémoire');
  t('mémoire : agrégats par jeu (morpion : nul → 0 victoire, 1 podium ; passeur : 1 victoire ; précision : solo)',
    same(mem.map((g) => [g.gameId, g.played, g.solo, g.wins, g.podiums, g.best]),
      [['morpion', 1, 0, 0, 1, 1], ['passeur', 1, 0, 1, 1, 1], ['precision', 1, 1, 0, 0, null]]), JSON.stringify(mem));
  const enPanne = createMemoryStore({ down: () => true });
  let jette = false; try { await enPanne.record('d', 'C', 'g', []); } catch (_) { jette = true; }
  t('mémoire : une base injoignable JETTE (le Hub le traite, voir M)', jette);

  // Postgres : le MÊME scénario, et les MÊMES agrégats, calculés en SQL.
  if (process.env.TEST_DATABASE_URL) {
    const { createPgStore } = require('./src/store-pg.js');
    const pg = createPgStore({ url: process.env.TEST_DATABASE_URL });
    const { Pool } = require('pg');
    const brut = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await brut.query('drop table if exists hub_plays; drop table if exists hub_players;');
    const sql = await scenarioStore(pg, 'postgres');
    t('postgres : les agrégats SQL = ceux de stats.js (mémoire), champ par champ', same(sql, mem), JSON.stringify(sql));
    const vide = await pg.perGame('p_personne');
    t('postgres : un id sans partie → aucune ligne', same(vide, []));
    await brut.query('drop table if exists hub_plays; drop table if exists hub_players;');
    await brut.end(); await pg.close();
  } else {
    console.log('(postgres sauté : TEST_DATABASE_URL absent)');
  }

  await new Promise((r) => server.listen(PORT, r));
  await new Promise((r) => serverSans.listen(PORT + 1, r));
  try { await protocole(); } catch (e) { t('EXCEPTION', false, e.message); }
  hub.stop(); hubSans.stop();
  server.close(); serverSans.close();
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
})();
