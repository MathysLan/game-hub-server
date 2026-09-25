// Score de soirée : le module pur (scores.js), puis le protocole `results` sur
// de VRAIES connexions WebSocket, contre le Hub seul.
//
//   node test-scores.js
//
// Le serveur du jeu n'est pas là, comme dans test-handoff.js : le Hub ne lui
// parle jamais. Les classements sont fabriqués ici. La partie réelle (vraie
// room du Passeur, classement venu de passeur-server) est vérifiée côté
// portfolio, par tests/hub-score.mjs.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const S = require('./src/session.js');
const L = require('./src/launch.js');
const SC = require('./src/scores.js');
const { publicSession } = require('./src/serialize.js');
const { createHub } = require('./src/hub.js');
const { createCatalog } = require('./src/catalog.js');
const { createHealth } = require('./src/health.js');

const PORT = +(process.env.PORT || 8805);

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═══════════════════════════════════════════════════════════ module pur
console.log('Score de soirée — module pur\n');

t('conversion : 10 × (classés − rang + 1) — à trois : 30 / 20 / 10',
  SC.sessionPoints(1, 3) === 30 && SC.sessionPoints(2, 3) === 20 && SC.sessionPoints(3, 3) === 10);
t('conversion : seul, on marque 10 (avoir joué)', SC.sessionPoints(1, 1) === 10);

{
  const R = (list) => SC.readResults(list);
  const row = (id, rank, points) => ({ gamePlayerId: id, rank, points });
  t('forme : un classement valide passe', same(R([row('a', 1, 90), row('b', 2, 40)]).rows, [{ seat: 'a', rank: 1, points: 90 }, { seat: 'b', rank: 2, points: 40 }]));
  t('forme : ex æquo acceptés (1, 1, 3)', !R([row('a', 1, 5), row('b', 1, 5), row('c', 3, 1)]).error);
  const refus = [
    ['pas un tableau', { a: 1 }], ['vide', []], ['17 lignes', Array.from({ length: 17 }, (_, i) => row('p' + i, 1, 0))],
    ['place en double', [row('a', 1, 1), row('a', 2, 0)]], ['place mal formée', [row('a b', 1, 1)]],
    ['place absente', [{ rank: 1, points: 1 }]], ['rang 0', [row('a', 0, 1)]], ['rang > classés', [row('a', 1, 1), row('b', 3, 0)]],
    ['rang décimal', [row('a', 1.5, 1)]], ['points texte', [row('a', 1, '99')]], ['points NaN', [row('a', 1, NaN)]],
    ['points démesurés', [row('a', 1, 1e9)]], ['aucun premier', [row('a', 2, 1), row('b', 2, 1)]], ['ligne nulle', [null]],
  ];
  for (const [nom, list] of refus) t('forme : refus — ' + nom, R(list).error === 'BAD_RESULTS');
}

function scene() {
  const s = S.createSession('ABCDE', { graceMs: 0 });
  for (const [id, name] of [['p_aaaa', 'Ana'], ['p_bbbb', 'Bob'], ['p_cccc', 'Cam']]) S.addPlayer(s, { id, name, avatar: { kind: 'emoji', emoji: '🦊' } });
  const draw = { id: 'd_1', n: 1 };
  const l = L.create(s, draw, { id: 'passeur', url: 'games/passeur/' }, 1000);
  s.launch = l;
  return { s, l };
}

{
  const s = S.createSession('ABCDE');
  t('session neuve : score vide, aucune partie', same(s.scores, {}) && same(s.history.games, []));
  const { l } = scene();
  t('lancement neuf : aucune place, pas encore compté', same(l.seats, {}) && l.scored === false);
}

{
  const { l } = scene();
  t('place : chacun déclare la sienne', SC.seat(l, 'p_aaaa', 'g1') && SC.seat(l, 'p_bbbb', 'g2') && same(l.seats, { p_aaaa: 'g1', p_bbbb: 'g2' }));
  t('place : prendre celle d\'un autre est refusé', SC.seat(l, 'p_cccc', 'g1') === false && !('p_cccc' in l.seats) && l.seats.p_aaaa === 'g1');
  t('place : la sienne peut changer (retour au salon du jeu)', SC.seat(l, 'p_aaaa', 'g9') && l.seats.p_aaaa === 'g9');
  t('place : forme refusée', SC.seat(l, 'p_cccc', '<script>') === false && SC.seat(l, 'p_cccc', 42) === false);
}

{
  const { s, l } = scene();
  SC.seat(l, 'p_aaaa', 'ga'); SC.seat(l, 'p_bbbb', 'gb'); SC.seat(l, 'p_cccc', 'gc');
  const rows = SC.readResults([
    { gamePlayerId: 'gc', rank: 3, points: 120 },
    { gamePlayerId: 'ga', rank: 1, points: 480 },
    { gamePlayerId: 'gx', rank: 4, points: 20 },       // entré sans le Hub
    { gamePlayerId: 'gb', rank: 1, points: 480 },      // ex æquo
  ]).rows;
  const e = SC.apply(s, l, rows, 5000);
  t('apply : 4 classés, ex æquo en tête → 40 / 40 / 20 (Cam), l\'inconnu ne marque rien',
    same(s.scores, { p_aaaa: 40, p_bbbb: 40, p_cccc: 20 }), JSON.stringify(s.scores));
  t('apply : historique dans l\'ordre du classement, points du jeu gardés tels quels',
    same(e.results.map((r) => [r.name, r.rank, r.gamePoints, r.points]), [['Ana', 1, 480, 40], ['Bob', 1, 480, 40], ['Cam', 3, 120, 20]]));
  t('apply : entrée numérotée, jeu et tirage notés, lancement marqué compté',
    e.n === 1 && e.gameId === 'passeur' && e.drawId === 'd_1' && e.players === 4 && l.scored === true && s.history.games.length === 1);

  // Deuxième partie : les points s'additionnent.
  const l2 = L.create(s, { id: 'd_2', n: 2 }, { id: 'passeur', url: 'games/passeur/' }, 6000);
  SC.seat(l2, 'p_aaaa', 'ha'); SC.seat(l2, 'p_cccc', 'hc');
  S.removePlayer(s, 'p_bbbb');                              // Bob est parti de la session entre-temps
  SC.seat(l2, 'p_bbbb', 'hb');
  SC.apply(s, l2, SC.readResults([{ gamePlayerId: 'hc', rank: 1, points: 300 }, { gamePlayerId: 'ha', rank: 2, points: 200 }, { gamePlayerId: 'hb', rank: 3, points: 1 }]).rows, 7000);
  t('2e partie : les points s\'additionnent (Ana 40+20, Cam 20+30)', s.scores.p_aaaa === 60 && s.scores.p_cccc === 50, JSON.stringify(s.scores));
  t('2e partie : un joueur parti de la session ne marque plus', s.scores.p_bbbb === 40 && s.history.games[1].results.length === 2);

  const pub = publicSession(s, null);
  t('public : scores et parties diffusés', same(pub.scores, s.scores) && pub.history.games.length === 2 && pub.history.games[0].results[0].points === 40);
  t('public : les places (identifiants de jeu) ne sortent JAMAIS', !JSON.stringify(pub).includes('"ga"') && !JSON.stringify(pub).includes('seats'));
  t('public : les scores sont une copie', (pub.scores.p_aaaa = 999, s.scores.p_aaaa === 60));
  t('nouvelle session : repart de zéro', same(S.createSession('FGHJK').scores, {}));
}

// ═══════════════════════════════════════════════════ protocole, vraies connexions
const on = (id, min, max, extra = {}) => Object.assign({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min, max }, minutes: { min: 1, max: 8 }, needs: [], categories: ['reflexe'],
  server: `wss://${id}.example`, health: `http://127.0.0.1:1/${id}`, join: 'v1', content: false, replay: false, handoff: false }, extra);
const FICHIER = path.join(os.tmpdir(), `hub-scores-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: [on('passeur', 1, 8, { handoff: true }), on('demicercle', 2, 10)] }));

const catalog = createCatalog({ file: FICHIER });
// Santé : jamais consultée par le tirage ; seul le lancement lit status().
const health = createHealth({ timeoutMs: 300 });
const hub = createHub({ graceMs: 3000, heartbeatMs: 0, catalog, health });
const server = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => hub.connection(ws));

function client(nom) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
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
  return c;
}
const P = (id, name) => ({ id, name, avatar: { kind: 'emoji', emoji: '🦊' } });
async function entre(nom, id, code) {
  const c = client(nom); await c.open;
  c.send(code ? { action: 'join', code, player: P(id, nom) } : { action: 'create', player: P(id, nom) });
  await c.waitFor((m) => m.type === 'joined' || m.type === 'created');
  return c;
}

// Tirer (seul Le Passeur est possible), confirmer, créer la room, faire entrer
// tout le monde avec sa place. Rend le drawId.
async function partie(a, b, c, places, room) {
  let m = a.mark();
  a.send({ action: 'draw' });
  const d = (await a.until((s) => s.draw && s.draw.status === 'drawn', 4000, m)).draw;
  m = a.mark();
  a.send({ action: 'continue' });
  await a.until((s) => s.state === 'launching', 3000, m);
  a.send({ action: 'launched', drawId: d.id, roomCode: room, gamePlayerId: places[0] });
  await b.until((s) => s.launch && s.launch.stage === 'join', 3000);
  b.send({ action: 'entered', drawId: d.id, roomCode: room, gamePlayerId: places[1] });
  m = a.mark();
  c.send({ action: 'entered', drawId: d.id, roomCode: room, gamePlayerId: places[2] });
  await a.until((s) => s.state === 'inGame', 3000, m);
  return d.id;
}

async function protocole() {
  console.log('\nScore de soirée — protocole `results`, vraies connexions\n');
  const a = await entre('Ana', 'p_ana1');
  const code = a.last().code;
  const b = await entre('Bob', 'p_bob1', code);
  const c = await entre('Cam', 'p_cam1', code);
  await a.until((s) => s.pool && s.pool.catalog === 'ready' && s.players.length === 3, 4000);
  b.send({ action: 'prefs', love: [], veto: ['demicercle'] });
  await a.until((s) => same(s.pool.eligible, ['passeur']), 3000);
  t('salon : le score existe dès le départ, vide, chez tout le monde', same(a.last().scores, {}) && same(c.last().scores, {}) && same(a.last().history.games, []));

  // Avant que la partie soit lancée : refus.
  let m = a.mark();
  a.send({ action: 'draw' });
  const d0 = (await a.until((s) => s.draw && s.draw.status === 'drawn', 4000, m)).draw;
  m = a.mark(); a.send({ action: 'continue' }); await a.until((s) => s.state === 'launching', 3000, m);
  m = a.mark();
  a.send({ action: 'results', drawId: d0.id, gameId: 'passeur', results: [{ gamePlayerId: 'x1', rank: 1, points: 1 }] });
  t('refus : pas avant que la partie soit lancée (NOT_LAUNCHING)', !!(await a.error('NOT_LAUNCHING', 2000, m)));
  a.send({ action: 'abort', drawId: d0.id, reason: 'CANCELLED' });
  await a.until((s) => s.state === 'lobby', 2000);

  const drawId = await partie(a, b, c, ['ga', 'gb', 'gc'], 'KQMP');
  t('lancement : trois places déclarées, invisibles dans l\'état public', !JSON.stringify(a.last()).includes('"gb"'));

  // Cam essaie de s'asseoir à la place de Bob : ignoré, Bob garde la sienne.
  c.send({ action: 'entered', drawId, roomCode: 'KQMP', gamePlayerId: 'gb' });

  const classement = [
    { gamePlayerId: 'gb', rank: 1, points: 480 },
    { gamePlayerId: 'ga', rank: 2, points: 350 },
    { gamePlayerId: 'gc', rank: 3, points: 90 },
  ];
  m = b.mark();
  b.send({ action: 'results', drawId, gameId: 'passeur', results: classement });
  t('refus : un invité ne rapporte pas le classement (NOT_HOST)', !!(await b.error('NOT_HOST', 2000, m)));
  m = a.mark();
  a.send({ action: 'results', drawId: 'd_autre', gameId: 'passeur', results: classement });
  t('refus : autre tirage (LAUNCH_MISMATCH)', !!(await a.error('LAUNCH_MISMATCH', 2000, m)));
  m = a.mark();
  a.send({ action: 'results', drawId, gameId: 'demicercle', results: classement });
  t('refus : autre jeu que celui lancé (GAME_MISMATCH)', !!(await a.error('GAME_MISMATCH', 2000, m)));
  m = a.mark();
  a.send({ action: 'results', drawId, gameId: 'passeur', results: [{ gamePlayerId: 'ga', rank: 0, points: 1 }] });
  t('refus : classement mal formé (BAD_RESULTS)', !!(await a.error('BAD_RESULTS', 2000, m)));
  t('… et aucun refus n\'a touché au score', same(a.last().scores, {}));

  m = c.mark();
  a.send({ action: 'results', drawId, gameId: 'passeur', results: classement });
  const s1 = await c.until((s) => Object.keys(s.scores).length === 3, 2000, m);
  t('classement reçu : Bob 30, Ana 20, Cam 10 — diffusé à tout le monde',
    same(s1.scores, { p_bob1: 30, p_ana1: 20, p_cam1: 10 }), JSON.stringify(s1.scores));
  t('… la tentative de Cam sur la place de Bob n\'a rien changé', s1.scores.p_cam1 === 10 && s1.scores.p_bob1 === 30);
  t('historique : la partie est notée, points du jeu gardés', s1.history.games.length === 1
    && same(s1.history.games[0].results.map((r) => [r.playerId, r.gamePoints, r.points]), [['p_bob1', 480, 30], ['p_ana1', 350, 20], ['p_cam1', 90, 10]]));
  t('lancement : marqué compté, la partie continue (inGame)', s1.launch.scored === true && s1.state === 'inGame');

  m = a.mark();
  a.send({ action: 'results', drawId, gameId: 'passeur', results: classement });
  t('une revanche dans la même room ne compte pas deux fois (RESULTS_ALREADY)', !!(await a.error('RESULTS_ALREADY', 2000, m)));

  m = a.mark();
  a.send({ action: 'ended', drawId });
  const deb = await a.until((s) => s.state === 'debrief', 2000, m);
  t('ended → debrief : le score reste', same(deb.scores, { p_bob1: 30, p_ana1: 20, p_cam1: 10 }));

  // Bob se reconnecte (même id) : il retrouve ses points.
  b.ws.close();
  await a.until((s) => s.players.find((p) => p.id === 'p_bob1').connected === false, 2000);
  const b2 = await entre('Bob', 'p_bob1', code);
  t('reconnexion : Bob retrouve ses points', b2.last().scores.p_bob1 === 30);

  // ── deuxième tirage, deuxième partie : ça s'additionne
  const drawId2 = await partie(a, b2, c, ['ha', 'hb', 'hc'], 'WXYZ');
  t('2e tirage : autre lancement', drawId2 !== drawId);
  m = a.mark();
  a.send({ action: 'results', drawId, gameId: 'passeur', results: classement });
  t('refus : le classement de la partie PRÉCÉDENTE (LAUNCH_MISMATCH)', !!(await a.error('LAUNCH_MISMATCH', 2000, m)));
  m = a.mark();
  a.send({ action: 'results', drawId: drawId2, gameId: 'passeur', results: [
    { gamePlayerId: 'hc', rank: 1, points: 500 }, { gamePlayerId: 'ha', rank: 2, points: 410 }, { gamePlayerId: 'hb', rank: 2, points: 410 },
  ] });
  const s2 = await a.until((s) => s.history.games.length === 2, 2000, m);
  t('2e partie : les points s\'additionnent (Bob 30+20, Ana 20+20, Cam 10+30)',
    same(s2.scores, { p_bob1: 50, p_ana1: 40, p_cam1: 40 }), JSON.stringify(s2.scores));
  a.send({ action: 'ended', drawId: drawId2 });
  await a.until((s) => s.state === 'debrief', 2000);

  // ── un jeu qui ne déclare pas de places : lancé pareil, aucun point
  m = a.mark();
  a.send({ action: 'draw' });
  const d3 = (await a.until((s) => s.draw && s.draw.status === 'drawn' && s.draw.n === 4, 4000, m)).draw;
  m = a.mark(); a.send({ action: 'continue' }); await a.until((s) => s.state === 'launching', 3000, m);
  a.send({ action: 'launched', drawId: d3.id, roomCode: 'BCDF' });
  b2.send({ action: 'entered', drawId: d3.id, roomCode: 'BCDF' });
  m = a.mark();
  c.send({ action: 'entered', drawId: d3.id, roomCode: 'BCDF' });
  await a.until((s) => s.state === 'inGame', 3000, m);
  m = a.mark();
  a.send({ action: 'results', drawId: d3.id, gameId: 'passeur', results: [{ gamePlayerId: 'zz', rank: 1, points: 9 }] });
  const s3 = await a.until((s) => s.history.games.length === 3, 2000, m);
  t('jeu sans places déclarées : partie notée, personne ne marque', same(s3.scores, s2.scores) && s3.history.games[2].results.length === 0);

  // ── nouvelle session : zéro
  const n = await entre('Ana', 'p_ana2');
  t('nouvelle session : le score repart de zéro', same(n.last().scores, {}) && same(n.last().history.games, []));

  for (const k of [a, b, b2, c, n]) { try { k.ws.terminate(); } catch (_) {} }
}

server.listen(PORT, async () => {
  try { await protocole(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + (e.stack || e.message)); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  hub.stop(); wss.close(); server.close();
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  process.exit(ko ? 1 : 0);
});
