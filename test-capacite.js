// La CAPACITÉ d'une session : 16 joueurs, de VRAIES connexions.
//
//   node test-capacite.js
//
// Le Hub héberge jusqu'à 16 joueurs (S.MAX_PLAYERS) : c'est le maximum d'un
// jeu du portfolio (Roquette Party, roquette-server). Les autres jeux gardent
// leur propre plafond dans le manifest — le tirage les écarte seuls au-delà
// (engine.js, TOO_MANY). Ce fichier vérifie, socket par socket :
//   - 12 joueurs : comme avant ; 13, 14, 15, 16 acceptés ; le 17e refusé
//     (SESSION_FULL) et laissé sans session ;
//   - l'état diffusé porte bien les 16 joueurs, chez chacun ;
//   - un absent (socket coupé) garde sa place et la reprend, session pleine ;
//   - un départ libère une place, que le 17e prend ;
//   - un groupe de 16 tire (jeu à 16 retenu, jeu à 12 écarté), lance, annule ;
//   - tout le monde part : la session disparaît ;
//   - le classement de soirée accepte 16 lignes, pas 17 (scores.js, inchangé).
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
const S = require('./src/session.js');
const SC = require('./src/scores.js');

const PORT = +(process.env.PORT || 8797);
const HPORT = PORT + 1;
const GRACE = 3000;

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── le catalogue : un jeu à 16 (handoff), un jeu à 12 ───────────────────────
const santeSrv = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
const on = (id, max, extra = {}) => ({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min: 2, max }, minutes: { min: 1, max: 8 }, needs: [], categories: ['reflexe'],
  server: `wss://${id}-server.onrender.com`, health: `http://127.0.0.1:${HPORT}/${id}`, join: 'v1',
  content: false, replay: false, ...extra });
const FICHIER = path.join(os.tmpdir(), `hub-capacite-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: [on('grand', 16, { handoff: true }), on('precision', 12)] }));
const catalog = createCatalog({ file: FICHIER });
const health = createHealth({ timeoutMs: 600 });

const hub = createHub({ graceMs: GRACE, heartbeatMs: 0, catalog, health });
const server = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => hub.connection(ws));

// Un client minimal (même forme que test.js).
function client(nom) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, nom, msgs: [], closed: false };
  ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  ws.on('close', () => { c.closed = true; });
  c.open = new Promise((res) => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const fin = Date.now() + ms;
    const voir = () => {
      const m = [...c.msgs].reverse().find(pred);
      if (m) return resolve(m);
      if (Date.now() > fin) return reject(new Error(`${nom} : rien de ce qui était attendu`));
      setTimeout(voir, 20);
    };
    voir();
  });
  c.etat = (pred, ms) => c.wait((m) => ['session', 'joined', 'created'].includes(m.type) && m.session && pred(m.session), ms);
  c.erreur = (code, ms) => c.wait((m) => m.type === 'error' && m.code === code, ms);
  return c;
}
const P = (i) => ({ id: `p_cap${String(i).padStart(2, '0')}`, name: `J${i}`, avatar: { kind: 'emoji', emoji: '🦊' } });
const nb = (n) => (s) => s.players.length === n;

async function entrer(i, code) {
  const c = client('J' + i);
  await c.open;
  c.send({ action: 'join', code, player: P(i) });
  return c;
}

(async () => {
  await new Promise((r) => santeSrv.listen(HPORT, '127.0.0.1', r));
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const tous = [];
  try {
    t('plafond du Hub : 16 joueurs (S.MAX_PLAYERS)', S.MAX_PLAYERS === 16, String(S.MAX_PLAYERS));

    // ── l'hôte crée, les autres entrent un à un ──────────────────────────────
    const hote = client('J1');
    await hote.open;
    hote.send({ action: 'create', player: P(1) });
    const cree = await hote.wait((m) => m.type === 'created' || m.type === 'session');
    const CODE = (cree.session || cree).code || (await hote.etat(() => true)).session.code;
    tous.push(hote);
    t('session créée', /^[A-Z2-9]{5}$/.test(CODE), CODE);
    t('la session annonce 16 places', (await hote.etat(() => true)).session.maxPlayers === 16);

    for (let i = 2; i <= 16; i++) {
      const c = await entrer(i, CODE);
      tous.push(c);
      await c.etat(nb(i));
      if (i >= 12) t(`${i} joueurs : le ${i}e est accepté`, true);
    }
    // l'état diffusé : 16 joueurs, chez chacun
    const vus = await Promise.all(tous.map((c) => c.etat(nb(16)).then(() => true, () => false)));
    t('les 16 reçoivent un état à 16 joueurs', vus.every(Boolean), `${vus.filter(Boolean).length}/16`);
    const etat16 = (await hote.etat(nb(16))).session;
    t('les 16 sont connectés, ids distincts', etat16.players.every((p) => p.connected !== false)
      && new Set(etat16.players.map((p) => p.id)).size === 16);

    // ── le 17e ───────────────────────────────────────────────────────────────
    const j17 = await entrer(17, CODE);
    await j17.erreur('SESSION_FULL').then(() => t('17e : SESSION_FULL', true), (e) => t('17e : SESSION_FULL', false, e.message));
    await sleep(150);
    t('17e : aucune session reçue', !j17.msgs.some((m) => m.type === 'session' || m.type === 'joined'));
    t('les autres : toujours 16', (await hote.etat(() => true)).session.players.length === 16);

    // ── un absent garde sa place, session pleine ──────────────────────────────
    tous[4].ws.close();
    await hote.etat((s) => s.players.length === 16 && s.players.some((p) => p.id === P(5).id && p.connected === false));
    t('J5 coupé : absent, mais toujours compté (16)', true);
    const j17b = await entrer(17, CODE);
    await j17b.erreur('SESSION_FULL').then(() => t('session pleine avec un absent : le 17e reste refusé', true),
      (e) => t('session pleine avec un absent : le 17e reste refusé', false, e.message));
    const j5 = await entrer(5, CODE);       // même player.id : la reprise
    tous[4] = j5;
    await j5.etat((s) => s.players.length === 16 && s.players.find((p) => p.id === P(5).id).connected !== false)
      .then(() => t('J5 revient (même id), session pleine : reprise acceptée, toujours 16', true),
        (e) => t('J5 revient (même id), session pleine : reprise acceptée, toujours 16', false, e.message));

    // ── un départ libère une place ────────────────────────────────────────────
    tous[15].send({ action: 'leave' });
    await hote.etat(nb(15));
    t('J16 part : 15 joueurs', true);
    const j17c = await entrer(17, CODE);
    await j17c.etat(nb(16)).then(() => t('la place libérée : le 17e entre (16 joueurs)', true),
      (e) => t('la place libérée : le 17e entre (16 joueurs)', false, e.message));
    tous[15] = j17c;
    const j18 = await entrer(18, CODE);
    await j18.erreur('SESSION_FULL').then(() => t('de nouveau pleine : le suivant est refusé', true),
      (e) => t('de nouveau pleine : le suivant est refusé', false, e.message));

    // ── un groupe de 16 traverse les phases ───────────────────────────────────
    hote.send({ action: 'draw' });
    const tire = await hote.etat((s) => s.draw && s.draw.status === 'drawn', 8000).then((m) => m.session, () => null);
    t('tirage à 16 : un jeu est tiré', !!tire, tire && tire.draw.gameId);
    t('tirage à 16 : le jeu à 16 est retenu', !!tire && tire.draw.gameId === 'grand');
    const exclu = tire && tire.pool && tire.pool.why && tire.pool.why.precision;
    t('tirage à 16 : le jeu plafonné à 12 est écarté (TOO_MANY)', !!exclu && JSON.stringify(exclu).includes('TOO_MANY'),
      exclu ? JSON.stringify(exclu).slice(0, 120) : JSON.stringify(tire && tire.pool).slice(0, 160));
    hote.send({ action: 'continue' });
    const lance = await hote.etat((s) => s.state === 'launching').then((m) => m.session, () => null);
    t('lancement : les 16 sont attendus', !!lance && lance.launch.expected.length === 16, lance && String(lance.launch.expected.length));
    hote.send({ action: 'abort', drawId: lance.launch.drawId, reason: 'CANCELLED' });
    await hote.etat((s) => s.state === 'lobby').then(() => t('lancement annulé : retour au salon à 16', true),
      (e) => t('lancement annulé : retour au salon à 16', false, e.message));

    // ── tout le monde part : la session disparaît ────────────────────────────
    for (const c of tous) c.send({ action: 'leave' });
    await sleep(400);
    const apres = await entrer(1, CODE);
    await apres.erreur('SESSION_NOT_FOUND').then(() => t('les 16 partis : la session est supprimée', true),
      (e) => t('les 16 partis : la session est supprimée', false, e.message));
    tous.push(j17, j17b, j18, apres);

    // ── le classement de soirée : 16 lignes, pas 17 (contrat inchangé) ───────
    const lignes = (n) => Array.from({ length: n }, (_, i) => ({ gamePlayerId: `g${i}`, rank: i + 1, points: 0 }));
    t('scores : 16 lignes acceptées', !SC.readResults(lignes(16)).error);
    t('scores : 17 lignes refusées (BAD_RESULTS)', SC.readResults(lignes(17)).error === 'BAD_RESULTS');
    t('scores : à 16, le 1er marque 160 et le 16e 10', SC.sessionPoints(1, 16) === 160 && SC.sessionPoints(16, 16) === 10);
  } catch (e) {
    t('déroulé sans exception', false, e.stack);
  } finally {
    for (const c of tous) try { c.ws.close(); } catch (_) {}
    try { fs.unlinkSync(FICHIER); } catch (_) {}
    hub.close && hub.close();
    wss.close(); server.close(); santeSrv.close();
    console.log(`\n${ok} OK, ${ko} KO`);
    process.exit(ko ? 1 : 0);
  }
})();
