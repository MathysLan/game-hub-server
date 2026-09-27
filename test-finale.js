// Fin de soirée : le module pur (finale.js), puis l'action `finish` sur de
// VRAIES connexions WebSocket, contre le Hub seul.
//
//   node test-finale.js
//
// Comme test-scores.js : aucun serveur de jeu, les classements sont fabriqués
// ici et passent par le vrai protocole (`launched` / `entered` / `results` /
// `ended`). C'est le Hub qui calcule les scores ; ce test vérifie que la
// finale les reprend tels quels, et que la soirée ne peut plus continuer.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const S = require('./src/session.js');
const F = require('./src/finale.js');
const { createHub } = require('./src/hub.js');
const { createCatalog } = require('./src/catalog.js');
const { createHealth } = require('./src/health.js');

const PORT = +(process.env.PORT || 8825);

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════ module pur
console.log('Fin de soirée — module pur\n');
{
  const s = S.createSession('ABCDE');
  const av = (e) => ({ kind: 'emoji', emoji: e });
  for (const [id, name, e] of [['p_a', 'Ana', '🦊'], ['p_b', 'Bob', '🐼'], ['p_c', 'Cam', '😎'], ['p_d', 'Dan', '🤖']]) S.addPlayer(s, { id, name, avatar: av(e) });
  s.scores = { p_a: 70, p_b: 70, p_c: 50, p_d: 30 };
  S.removePlayer(s, 'p_d');                        // Dan part, ses points restent
  const r = F.ranking(s);
  t('ex æquo au même rang, sans départage : 70, 70, 50, 30 → 1, 1, 3, 4', same(r.map((l) => [l.name, l.points, l.rank]), [['Ana', 70, 1], ['Bob', 70, 1], ['Cam', 50, 3], ['Dan', 30, 4]]));
  t('joueur parti : gardé, avec son nom ET son avatar, marqué absent de la session', r[3].present === false && same(r[3].avatar, av('🤖')) && r.slice(0, 3).every((l) => l.present));
  const s2 = S.createSession('FGHJK');
  S.addPlayer(s2, { id: 'p_x', name: 'Xia', avatar: av('🦊') });
  S.addPlayer(s2, { id: 'p_y', name: 'Yan', avatar: av('🦊') });
  t('personne n\'a marqué : tout le monde à 0, rang 1', same(F.ranking(s2).map((l) => [l.points, l.rank]), [[0, 1], [0, 1]]));
  S.removePlayer(s2, 'p_y');
  t('parti SANS avoir marqué : pas au podium', F.ranking(s2).length === 1);
  const f = F.build(s, 'p_a', 123);
  t('build : code, auteur, heure, parties, podium', f.code === 'ABCDE' && f.by === 'p_a' && f.at === 123 && same(f.games, []) && f.ranking.length === 4);
  t('build : n\'emporte rien d\'interne (sockets, departed, seats)', !/sockets|departed|seats/.test(JSON.stringify(f)));
  t('l\'état finished existe, et n\'est pas « ouvert »', S.STATES.includes('finished') && !S.OPEN_STATES.includes('finished') && same(S.FINISHABLE_STATES, ['lobby', 'debrief']));
}

// ═══════════════════════════════════════════════════ protocole, vraies connexions
const on = (id, min, max, extra = {}) => Object.assign({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min, max }, minutes: { min: 1, max: 8 }, needs: [], categories: ['reflexe'],
  server: `wss://${id}.example`, health: `http://127.0.0.1:1/${id}`, join: 'v1', content: false, replay: false, handoff: false }, extra);
const FICHIER = path.join(os.tmpdir(), `hub-finale-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: [on('passeur', 1, 8, { handoff: true })] }));

// Deux Hubs : l'un normal, l'autre aux délais courts (grâce, pierre tombale).
function monter(port, opts) {
  const hub = createHub(Object.assign({ heartbeatMs: 0, catalog: createCatalog({ file: FICHIER }), health: createHealth({ timeoutMs: 300 }) }, opts));
  const server = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => hub.connection(ws));
  return { hub, server, wss, port, ready: new Promise((res) => server.listen(port, res)) };
}
const H1 = monter(PORT, { graceMs: 3000 });
const H2 = monter(PORT + 1, { graceMs: 150, finaleKeepMs: 600 });

function client(port, nom) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, nom, msgs: [], closeCode: null };
  ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  ws.on('close', (code) => { c.closeCode = code; });
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
  c.finales = () => c.msgs.filter((m) => m.type === 'finale');
  c.fermer = () => new Promise((res) => { if (c.ws.readyState === 3) return res(); c.ws.once('close', res); c.ws.close(); });
  return c;
}
const P = (id, name, emoji = '🦊') => ({ id, name, avatar: { kind: 'emoji', emoji } });
async function entre(port, nom, id, code, emoji) {
  const c = client(port, nom); await c.open;
  c.send(code ? { action: 'join', code, player: P(id, nom, emoji) } : { action: 'create', player: P(id, nom, emoji) });
  c.rep = await c.waitFor((m) => m.type === 'joined' || m.type === 'created' || m.type === 'error');
  return c;
}
// Une partie comptée : tirage, lancement, chacun s'assoit, classement, ended.
async function partie(hote, autres, rangs) {
  await hote.until((s) => s.pool && s.pool.catalog === 'ready', 4000);
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
  m = hote.mark();
  hote.send({ action: 'results', drawId: d.id, gameId: 'passeur', results: [hote, ...autres].map((c) => ({ gamePlayerId: 'g-' + c.nom, rank: rangs[c.nom], points: 9 })) });
  await hote.until((s) => s.history.games.some((g) => g.drawId === d.id), 3000, m);
  m = hote.mark(); hote.send({ action: 'ended', drawId: d.id });
  return hote.until((s) => s.state === 'debrief', 3000, m);
}

async function principal() {
  console.log('\nFin de soirée — protocole `finish`, vraies connexions\n');
  const { hub, port } = H1;
  const A = await entre(port, 'Ana', 'p_ana', null, '🦊');
  const code = A.rep.session.code;
  const B = await entre(port, 'Bob', 'p_bob', code, '🐼');
  const C = await entre(port, 'Cam', 'p_cam', code, '😎');
  const D = await entre(port, 'Dan', 'p_dan', code, '🤖');
  // 4 classés : Ana 1, Bob 1 (ex æquo), Cam 3, Dan 4 → 40 / 40 / 20 / 10.
  const deb = await partie(A, [B, C, D], { Ana: 1, Bob: 1, Cam: 3, Dan: 4 });
  t('préparation : le Hub a compté 40 / 40 / 20 / 10', same(deb.scores, { p_ana: 40, p_bob: 40, p_cam: 20, p_dan: 10 }), JSON.stringify(deb.scores));
  let m = A.mark();
  D.send({ action: 'leave' });                               // Dan quitte : lui seul
  await A.until((s) => s.players.length === 3, 3000, m);
  t('un joueur qui QUITTE ne ferme pas la session : les autres continuent', hub.sessions.get(code).state === 'debrief');

  // Non-hôte : refusé.
  m = B.mark(); B.send({ action: 'finish' });
  t('non-hôte : `finish` refusé (NOT_HOST)', !!(await B.error('NOT_HOST', 2000, m)) && hub.sessions.get(code).state === 'debrief');

  // Pendant un tirage / un lancement : refusé.
  m = A.mark(); A.send({ action: 'draw' });
  await A.until((s) => s.draw && s.draw.status === 'drawn' && s.state === 'drawing', 4000, m);
  m = A.mark(); A.send({ action: 'finish' });
  t('pendant un tirage : refusé (FINISH_NOT_ALLOWED)', !!(await A.error('FINISH_NOT_ALLOWED', 2000, m)) && hub.sessions.get(code).state === 'drawing');
  m = A.mark(); A.send({ action: 'continue' }); const lan = await A.until((s) => s.state === 'launching', 3000, m);
  m = A.mark(); A.send({ action: 'finish' });
  t('pendant un lancement : refusé (FINISH_NOT_ALLOWED)', !!(await A.error('FINISH_NOT_ALLOWED', 2000, m)) && hub.sessions.get(code).state === 'launching');
  m = A.mark(); A.send({ action: 'abort', drawId: lan.launch.drawId, reason: 'CANCELLED' });
  await A.until((s) => s.state === 'lobby', 3000, m);

  // L'hôte termine — et double-clique.
  const avantMarks = [A, B, C].map((c) => c.mark());
  A.send({ action: 'finish' });
  A.send({ action: 'finish' });
  const fins = await Promise.all([A, B, C].map((c, i) => c.waitFor((x) => x.type === 'finale', 3000, avantMarks[i])));
  const f = fins[0].finale;
  t('l\'hôte termine : les trois connectés reçoivent la MÊME finale', fins.every((x) => same(x.finale, f)));
  t('podium = scores du Hub, ex æquo au même rang : Ana 40 (1), Bob 40 (1), Cam 20 (3), Dan 10 (4)',
    same(f.ranking.map((l) => [l.name, l.points, l.rank]), [['Ana', 40, 1], ['Bob', 40, 1], ['Cam', 20, 3], ['Dan', 10, 4]]), JSON.stringify(f.ranking.map((l) => [l.name, l.points, l.rank])));
  t('Dan, parti avant la fin : au podium avec ses points et son avatar, `present: false`', f.ranking[3].present === false && f.ranking[3].avatar.emoji === '🤖' && f.ranking.slice(0, 3).every((l) => l.present));
  t('finale : code, auteur (l\'hôte), parties comptées et tirées', f.code === code && f.by === 'p_ana' && f.games.length === 1 && f.played === 2);
  const s = hub.sessions.get(code);
  t('la session passe à `finished`, podium figé côté serveur', s.state === 'finished' && same(s.finale, f));
  await pause(300);
  t('double clic : une seule clôture — la finale n\'a pas bougé, les copies sont identiques', same(hub.sessions.get(code).finale, f) && A.finales().every((x) => same(x.finale, f)), `${A.finales().length} finale(s) reçue(s) par l'hôte`);
  t('les sockets sont fermés par le serveur (4002)', [A, B, C].every((c) => c.closeCode === 4002), JSON.stringify([A, B, C].map((c) => c.closeCode)));
  t('plus personne n\'est connecté, et plus rien ne tourne (joueurs figés)', s.players.every((p) => !p.connected) && s.sockets.size === 0 && s.players.length === 3);

  // Revenir : jamais de reprise.
  const A2 = await entre(port, 'Ana', 'p_ana', code);
  t('l\'hôte recharge : SESSION_CLOSED — et il retrouve le podium', A2.rep.type === 'error' && A2.rep.code === 'SESSION_CLOSED' && same(A2.rep.finale, f));
  const D2 = await entre(port, 'Dan', 'p_dan', code);
  t('Dan (parti avant la fin) revient : SESSION_CLOSED + podium', D2.rep.code === 'SESSION_CLOSED' && same(D2.rep.finale, f));
  const X = await entre(port, 'Xia', 'p_xia', code);
  t('un inconnu avec le code : SESSION_CLOSED, SANS le podium', X.rep.code === 'SESSION_CLOSED' && !('finale' in X.rep));
  m = X.mark(); X.send({ action: 'draw' });
  t('aucun tirage possible après la fin (NOT_IN_SESSION)', !!(await X.error('NOT_IN_SESSION', 2000, m)) && hub.sessions.get(code).state === 'finished');
  m = X.mark(); X.send({ action: 'finish' });
  t('un `finish` hors session : NOT_IN_SESSION, aucune clôture en plus', !!(await X.error('NOT_IN_SESSION', 2000, m)) && same(hub.sessions.get(code).finale, f));
  const N = await entre(port, 'Ana', 'p_ana', null);
  t('une NOUVELLE session se crée normalement, avec un autre code, score vide', N.rep.type === 'created' && N.rep.session.code !== code && same(N.rep.session.scores, {}));
  for (const c of [A, B, C, D, A2, D2, X, N]) { try { c.ws.terminate(); } catch (_) {} }
}

async function hoteParti() {
  console.log('\nHôte déconnecté, grâces, pierre tombale (Hub aux délais courts)\n');
  const { hub, port } = H2;
  // L'hôte perd sa connexion en lobby : l'hôte passe au plus ancien connecté
  // (règle unique d'electHost). Le NOUVEL hôte peut terminer.
  const A = await entre(port, 'Ana', 'p_ana', null);
  const code = A.rep.session.code;
  const B = await entre(port, 'Bob', 'p_bob', code);
  const C = await entre(port, 'Cam', 'p_cam', code);
  await A.fermer();
  const s0 = await B.until((s) => s.hostId === 'p_bob', 2000);
  t('l\'hôte se déconnecte : Bob devient hôte (règle existante)', s0.hostId === 'p_bob');
  let m = C.mark(); C.send({ action: 'finish' });
  t('… Cam, lui, ne peut toujours pas terminer', !!(await C.error('NOT_HOST', 2000, m)));
  m = B.mark(); B.send({ action: 'finish' });
  const f = (await B.waitFor((x) => x.type === 'finale', 2000, m)).finale;
  t('le nouvel hôte termine : finale reçue, Ana (absente) y figure', f.by === 'p_bob' && f.ranking.some((l) => l.playerId === 'p_ana'));
  await pause(300);                                          // > grâce de 150 ms
  t('les grâces sont annulées : Ana n\'a pas été retirée après la fin', hub.sessions.get(code).players.some((p) => p.id === 'p_ana') && same(hub.sessions.get(code).finale, f));
  const A2 = await entre(port, 'Ana', 'p_ana', code);
  t('Ana revient pendant la pierre tombale : SESSION_CLOSED + podium, pas de reprise', A2.rep.code === 'SESSION_CLOSED' && same(A2.rep.finale, f));
  await pause(600);
  const A3 = await entre(port, 'Ana', 'p_ana', code);
  t('pierre tombale expirée : la session n\'existe plus (SESSION_NOT_FOUND)', A3.rep.code === 'SESSION_NOT_FOUND' && !hub.sessions.has(code));

  // Pas de finish au milieu d'une partie, même seul.
  const S1 = await entre(port, 'Sol', 'p_sol', null);
  await S1.until((s) => s.pool && s.pool.catalog === 'ready', 4000);
  m = S1.mark(); S1.send({ action: 'draw' });
  const d = (await S1.until((s) => s.draw && s.draw.status === 'drawn', 4000, m)).draw;
  m = S1.mark(); S1.send({ action: 'continue' }); await S1.until((s) => s.state === 'launching', 3000, m);
  m = S1.mark(); S1.send({ action: 'launched', drawId: d.id, roomCode: 'KQMP' }); await S1.until((s) => s.state === 'inGame', 3000, m);
  m = S1.mark(); S1.send({ action: 'finish' });
  t('en pleine partie (inGame) : refusé (FINISH_NOT_ALLOWED)', !!(await S1.error('FINISH_NOT_ALLOWED', 2000, m)));
  m = S1.mark(); S1.send({ action: 'results', drawId: d.id, gameId: 'passeur', results: [{ gamePlayerId: 'zz', rank: 1, points: 1 }] });
  await S1.until((s) => s.history.games.length === 1, 2000, m);
  m = S1.mark(); S1.send({ action: 'ended', drawId: d.id }); await S1.until((s) => s.state === 'debrief', 2000, m);
  m = S1.mark(); S1.send({ action: 'finish' });
  const fs1 = (await S1.waitFor((x) => x.type === 'finale', 2000, m)).finale;
  t('solo, au debrief : la finale part, une ligne au podium', fs1.ranking.length === 1 && fs1.ranking[0].rank === 1 && fs1.games.length === 1);
  for (const c of [A, B, C, A2, A3, S1]) { try { c.ws.terminate(); } catch (_) {} }
}

Promise.all([H1.ready, H2.ready]).then(async () => {
  try { await principal(); await hoteParti(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + (e.stack || e.message)); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  for (const h of [H1, H2]) { h.hub.stop(); h.wss.close(); h.server.close(); }
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  process.exit(ko ? 1 : 0);
});
