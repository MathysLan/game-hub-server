// Cycle de vie d'une session APRÈS une partie : le retour du jeu au Hub.
//
//   node test-debrief.js
//
// Le bug : quitter la page du jeu ferme le socket du Hub. Au debrief d'une
// partie finie, seul (ou tout le groupe au même instant), le Hub voyait zéro
// joueur connecté et fermait la session sur-le-champ → « Ta session précédente
// n'existe plus », score de soirée perdu. Une session vide au debrief d'un
// lancement 'ended' suit maintenant les délais de grâce individuels, comme
// pendant le lancement et la partie.
//
// Deux Hubs : grâce de 3 s (on revient à temps) et de 80 ms (la grâce expire,
// la session doit disparaître — ce n'est pas un stockage permanent). Aucun
// serveur de jeu : les classements sont fabriqués ici, comme dans
// test-scores.js.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { createHub } = require('./src/hub.js');
const { createCatalog } = require('./src/catalog.js');
const { createHealth } = require('./src/health.js');

const PORT = +(process.env.PORT || 8815);

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Deux jeux jouables seul : Le Passeur (lancé par le Hub) et « autre », qui ne
// sait pas être lancé (handoff: false) → debrief SANS partie terminée. Le veto
// d'un joueur choisit lequel sort.
const on = (id, extra = {}) => Object.assign({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min: 1, max: 8 }, minutes: { min: 1, max: 8 }, needs: [], categories: ['reflexe'],
  server: `wss://${id}.example`, health: `http://127.0.0.1:1/${id}`, join: 'v1', content: false, replay: false, handoff: false }, extra);
const FICHIER = path.join(os.tmpdir(), `hub-debrief-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: [on('passeur', { handoff: true }), on('autre')] }));

function monter(port, graceMs) {
  const hub = createHub({ graceMs, heartbeatMs: 0, catalog: createCatalog({ file: FICHIER }), health: createHealth({ timeoutMs: 300 }) });
  const server = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => hub.connection(ws));
  return { hub, server, wss, port, ready: new Promise((res) => server.listen(port, res)) };
}

function client(port, nom) {
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
  c.until = (pred, ms, from) => c.waitFor((m) => m.session && pred(m.session), ms, from).then((m) => m.session);
  c.last = () => { const m = [...c.msgs].reverse().find((x) => x.session); return m && m.session; };
  c.fermer = () => new Promise((res) => { ws.once('close', res); ws.close(); });
  return c;
}
const P = (id, name) => ({ id, name, avatar: { kind: 'emoji', emoji: '🦊' } });
async function entre(port, nom, id, code) {
  const c = client(port, nom); await c.open;
  c.send(code ? { action: 'join', code, player: P(id, nom) } : { action: 'create', player: P(id, nom) });
  const m = await c.waitFor((x) => x.type === 'joined' || x.type === 'created' || x.type === 'error');
  c.reponse = m;
  return c;
}
// Attendre un état côté serveur (le client n'y voit plus rien une fois fermé).
async function attendre(pred, ms = 2000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (pred()) return true; await pause(10); }
  return pred();
}

// Un salon prêt à tirer : tout le monde met son veto sur `veto`.
async function salon(port, ids, veto = 'autre') {
  const [hote, ...autres] = ids;
  const a = await entre(port, hote, 'p_' + hote);
  const code = a.last().code;
  const cs = [a];
  for (const n of autres) cs.push(await entre(port, n, 'p_' + n, code));
  await a.until((s) => s.pool && s.pool.catalog === 'ready' && s.players.length === ids.length, 4000);
  a.send({ action: 'prefs', love: [], veto: [veto] });
  await a.until((s) => s.pool.eligible.length === 1, 3000);
  return { code, cs };
}

async function tirer(a) {
  let m = a.mark();
  a.send({ action: 'draw' });
  const d = (await a.until((s) => s.draw && s.draw.status === 'drawn', 4000, m)).draw;
  return d;
}

// Tirage → room → tout le monde dedans → classement → ended. Rend l'état debrief.
async function partieFinie(cs, classement) {
  const [a, ...autres] = cs;
  const d = await tirer(a);
  let m = a.mark();
  a.send({ action: 'continue' });
  await a.until((s) => s.state === 'launching', 3000, m);
  m = a.mark();
  a.send({ action: 'launched', drawId: d.id, roomCode: 'KQMP', gamePlayerId: 'g0' });
  autres.forEach((c, i) => c.send({ action: 'entered', drawId: d.id, roomCode: 'KQMP', gamePlayerId: 'g' + (i + 1) }));
  await a.until((s) => s.state === 'inGame', 3000, m);
  m = a.mark();
  a.send({ action: 'results', drawId: d.id, gameId: 'passeur', results: classement });
  await a.until((s) => s.history.games.length === 1, 2000, m);
  m = a.mark();
  a.send({ action: 'ended', drawId: d.id });
  return a.until((s) => s.state === 'debrief', 2000, m);
}

const LONG = monter(PORT, 3000);
const COURT = monter(PORT + 1, 80);

async function solo() {
  console.log('Solo — le cas vu en production\n');
  const { hub, port } = LONG;
  const { code, cs: [a] } = await salon(port, ['Ana']);
  const deb = await partieFinie([a], [{ gamePlayerId: 'g0', rank: 1, points: 120 }]);
  t('fin de partie : debrief, +10 de soirée', deb.state === 'debrief' && same(deb.scores, { p_Ana: 10 }), JSON.stringify(deb.scores));
  const avant = { scores: deb.scores, history: deb.history };

  await a.fermer();
  const s = hub.sessions.get(code);
  await attendre(() => s.players[0].connected === false);
  await pause(100);
  t('dernier socket fermé : la session N\'EST PAS supprimée', hub.sessions.get(code) === s && s.state === 'debrief');
  t('… le joueur reste dans la session, absent', s.players.length === 1 && s.players[0].connected === false);

  const a2 = await entre(port, 'Ana', 'p_Ana', code);
  const r = a2.reponse;
  t('retour, même player.id : session retrouvée', r.type === 'joined' && r.you === 'p_Ana' && r.session.code === code, r.type + ' ' + (r.code || ''));
  t('… score de soirée intact (10)', same(r.session.scores, { p_Ana: 10 }), JSON.stringify(r.session.scores));
  t('… history.games intact', same(r.session.history.games, avant.history.games) && r.session.history.games.length === 1);
  t('… history.played intact', same(r.session.history.played, avant.history.played) && r.session.history.played.length === 1);
  t('… toujours en debrief, hôte = lui, un seul joueur', r.session.state === 'debrief' && r.session.hostId === 'p_Ana' && r.session.players.length === 1);

  const d2 = await tirer(a2);
  t('… et il peut tirer une nouvelle partie', !!d2 && d2.n === 2, 'tirage n°' + (d2 && d2.n));
  a2.ws.terminate();
}

async function groupe() {
  console.log('\nGroupe — les trois reviennent du jeu au même instant\n');
  const { hub, port } = LONG;
  const { code, cs } = await salon(port, ['Bea', 'Cyd', 'Dan']);
  const deb = await partieFinie(cs, [
    { gamePlayerId: 'g1', rank: 1, points: 480 }, { gamePlayerId: 'g0', rank: 2, points: 300 }, { gamePlayerId: 'g2', rank: 3, points: 90 },
  ]);
  const attendu = { p_Cyd: 30, p_Bea: 20, p_Dan: 10 };
  t('fin de partie : debrief, 30 / 20 / 10', deb.state === 'debrief' && same(deb.scores, attendu), JSON.stringify(deb.scores));

  await Promise.all(cs.map((c) => c.fermer()));
  const s = hub.sessions.get(code);
  await attendre(() => s.players.every((p) => !p.connected));
  await pause(100);
  t('les trois sockets fermés : la session vit encore', hub.sessions.get(code) === s && s.players.length === 3 && s.state === 'debrief');

  // Un INVITÉ revient d'abord : l'hôte du lancement, absent, garde la main.
  const c2 = await entre(port, 'Cyd', 'p_Cyd', code);
  const r = c2.reponse;
  t('Cyd revient : même session', r.type === 'joined' && r.session.code === code);
  t('… score de soirée intact', same(r.session.scores, attendu), JSON.stringify(r.session.scores));
  t('… historique intact', same(r.session.history, deb.history));
  t('… état debrief, trois joueurs', r.session.state === 'debrief' && r.session.players.length === 3);
  t('… l\'hôte reste celui du lancement (Bea, absente)', r.session.hostId === 'p_Bea');

  const b2 = await entre(port, 'Bea', 'p_Bea', code);
  t('Bea revient : hôte, score intact', b2.reponse.session.hostId === 'p_Bea' && same(b2.reponse.session.scores, attendu));
  // Dan ne revient pas : sa grâce (3 s) l'efface, la session reste aux deux autres.
  await attendre(() => s.players.length === 2, 4500);
  t('Dan jamais revenu : retiré à la fin de SA grâce, la session continue',
    hub.sessions.get(code) === s && same(s.players.map((p) => p.id), ['p_Bea', 'p_Cyd']) && s.scores.p_Dan === 10);
  for (const c of [c2, b2]) c.ws.terminate();
}

async function expiration() {
  console.log('\nGrâce expirée (80 ms) — la session finit bien par disparaître\n');
  const { hub, port } = COURT;
  {
    const { code, cs: [a] } = await salon(port, ['Eve']);
    await partieFinie([a], [{ gamePlayerId: 'g0', rank: 1, points: 5 }]);
    await a.fermer();
    t('solo : juste après la fermeture, la session est gardée', hub.sessions.has(code));
    const partie = await attendre(() => !hub.sessions.has(code), 1500);
    t('solo : grâce écoulée → session supprimée', partie);
    const e = await entre(port, 'Eve', 'p_Eve', code);
    t('solo : revenir trop tard → SESSION_NOT_FOUND', e.reponse.type === 'error' && e.reponse.code === 'SESSION_NOT_FOUND');
    e.ws.terminate();
  }
  {
    const { code, cs } = await salon(port, ['Fay', 'Gus', 'Hal']);
    await partieFinie(cs, [{ gamePlayerId: 'g0', rank: 1, points: 5 }, { gamePlayerId: 'g1', rank: 2, points: 3 }, { gamePlayerId: 'g2', rank: 3, points: 1 }]);
    await Promise.all(cs.map((c) => c.fermer()));
    t('groupe : juste après, la session est gardée', hub.sessions.has(code));
    t('groupe : grâces écoulées → session supprimée', await attendre(() => !hub.sessions.has(code), 1500));
  }
}

async function inchanges() {
  console.log('\nCas inchangés — une session vide ailleurs qu\'au retour d\'une partie\n');
  const { hub, port } = LONG;

  { // A. lobby
    const { code, cs: [a] } = await salon(port, ['Ian']);
    await a.fermer();
    t('lobby vide : fermée tout de suite', await attendre(() => !hub.sessions.has(code), 300));
  }
  { // B. drawing
    const { code, cs: [a] } = await salon(port, ['Jo']);
    await tirer(a);
    t('(tirage affiché : état drawing)', hub.sessions.get(code).state === 'drawing');
    await a.fermer();
    t('drawing vide : fermée tout de suite', await attendre(() => !hub.sessions.has(code), 300));
  }
  { // C. launching
    const { code, cs: [a] } = await salon(port, ['Kim']);
    await tirer(a);
    let m = a.mark(); a.send({ action: 'continue' }); await a.until((s) => s.state === 'launching', 3000, m);
    await a.fermer();
    await pause(150);
    t('launching vide : gardée (handoff, comme avant)', hub.sessions.has(code) && hub.sessions.get(code).state === 'launching');
    hub.sessions.delete(code);
  }
  { // D. inGame
    const { code, cs: [a] } = await salon(port, ['Lou']);
    const d = await tirer(a);
    let m = a.mark(); a.send({ action: 'continue' }); await a.until((s) => s.state === 'launching', 3000, m);
    m = a.mark(); a.send({ action: 'launched', drawId: d.id, roomCode: 'KQMP' }); await a.until((s) => s.state === 'inGame', 3000, m);
    await a.fermer();
    await pause(150);
    t('inGame vide : gardée (handoff, comme avant)', hub.sessions.has(code) && hub.sessions.get(code).state === 'inGame');
    hub.sessions.delete(code);
  }
  { // E. debrief SANS partie terminée : jeu tiré mais pas lançable
    const { code, cs: [a] } = await salon(port, ['Max'], 'passeur');
    await tirer(a);
    const m = a.mark(); a.send({ action: 'continue' });
    const s = await a.until((x) => x.state === 'debrief', 3000, m);
    t('(debrief sans lancement)', !s.launch);
    await a.fermer();
    t('debrief sans partie terminée : fermée tout de suite', await attendre(() => !hub.sessions.has(code), 300));
  }
  { // F. leave au debrief d'une partie finie : départ volontaire, inchangé
    const { code, cs: [a] } = await salon(port, ['Ned']);
    await partieFinie([a], [{ gamePlayerId: 'g0', rank: 1, points: 1 }]);
    a.send({ action: 'leave' });
    t('leave au debrief : fermée tout de suite (onLeave inchangé)', await attendre(() => !hub.sessions.has(code), 300));
    a.ws.terminate();
  }
}

(async () => {
  await Promise.all([LONG.ready, COURT.ready]);
  try { await solo(); await groupe(); await expiration(); await inchanges(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + (e.stack || e.message)); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  for (const h of [LONG, COURT]) { h.hub.stop(); h.wss.close(); h.server.close(); }
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  process.exit(ko ? 1 : 0);
})();
