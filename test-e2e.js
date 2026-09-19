// Bout en bout, contre le VRAI serveur — src/server.js, assemblage compris.
//
//   node test-e2e.js
//
// test.js monte le hub à la main pour pouvoir raccourcir le délai de grâce.
// Ici on démarre le serveur tel qu'il tournera en production : si
// src/server.js ne se lance pas, ou si le HTTP ne répond pas, c'est ce fichier
// qui le dit.
//
// Le scénario est celui d'une vraie soirée : deux amis, un code dicté à voix
// haute, puis quelqu'un qui ferme son onglet.
'use strict';

process.env.PORT = process.env.PORT || '8792';
process.env.HUB_QUIET = '1';

// Le catalogue : un fichier local (pas le réseau), au format du vrai manifest.
// Les /health des jeux pointent sur le Hub lui-même — sauf Précision, qui vise
// un port fermé : un serveur de jeu MORT, pour vérifier qu'il n'est jamais tiré.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ICI = `http://127.0.0.1:${process.env.PORT}/health`;
const jeu = (id, min, max, mmax, needs = [], health = ICI) => ({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min, max }, minutes: { min: 1, max: mmax }, needs, categories: ['reflexe'],
  server: `wss://${id}.onrender.com`, health, join: 'v1', content: false, replay: false });
const MANIFEST = path.join(os.tmpdir(), `hub-e2e-manifest-${process.pid}.json`);
fs.writeFileSync(MANIFEST, JSON.stringify({ version: 1, games: [
  jeu('morpion', 2, 2, 5), jeu('imitation', 2, 8, 15, ['mic']), jeu('demicercle', 2, 10, 15),
  jeu('precision', 1, 12, 10, [], 'http://127.0.0.1:9/'), jeu('passeur', 1, 8, 8), jeu('quiment', 3, 8, 15),
] }));
process.env.MANIFEST_FILE = MANIFEST;
process.on('exit', () => { try { fs.unlinkSync(MANIFEST); } catch (_) {} });

const WebSocket = require('ws');
const { hub } = require('./src/server.js');

const BASE = `127.0.0.1:${process.env.PORT}`;
let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(nom) {
  const ws = new WebSocket(`ws://${BASE}`);
  const c = { ws, nom, msgs: [] };
  ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  c.open = new Promise((res) => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  // On attend un ÉTAT qui satisfait une condition, jamais « le prochain
  // message » : une diffusion en retard se ferait passer pour la bonne.
  c.until = (pred, types = ['session', 'created', 'joined'], ms = 4000) =>
    new Promise((resolve, reject) => {
      const fin = Date.now() + ms;
      const voir = () => {
        const m = [...c.msgs].reverse()
          .find((x) => types.includes(x.type) && x.session && pred(x.session));
        if (m) return resolve(m);
        if (Date.now() > fin) return reject(new Error(`${nom} : condition jamais atteinte`));
        setTimeout(voir, 25);
      };
      voir();
    });
  return c;
}

async function health() {
  const r = await fetch(`http://${BASE}/health`);
  return { status: r.status, body: await r.json() };
}

async function main() {
  console.log('Bout en bout — le vrai serveur\n');

  // ── le serveur répond en HTTP avant même qu'on ouvre un socket
  {
    const h = await health();
    t('GET /health répond 200', h.status === 200);
    t('/health dit que le Hub va bien', h.body.ok === true && h.body.service === 'game-hub-server');
    t('/health annonce une version de protocole', h.body.protocolVersion === 1);
    t('/health part de zéro session', h.body.sessions === 0);
    const racine = await fetch(`http://${BASE}/`);
    t('GET / répond aussi', racine.status === 200);
    const perdu = await fetch(`http://${BASE}/nimporte`);
    t('une route inconnue répond 404', perdu.status === 404);
  }

  // ── A crée la session
  const A = client('A'); await A.open;
  A.send({ action: 'create', player: { id: 'p_mathys', name: 'Mathys', avatar: { kind: 'emoji', emoji: '🦊' } } });
  const cree = await A.until((s) => s.players.length === 1);
  const CODE = cree.session.code;
  t('A crée une session et reçoit un code', /^[A-HJ-NP-Z2-9]{5}$/.test(CODE), CODE);
  t('A est hôte', cree.session.hostId === 'p_mathys');

  // ── B rejoint avec ce code
  const B = client('B'); await B.open;
  B.send({ action: 'join', code: CODE, player: { id: 'p_lea', name: 'Léa', avatar: { kind: 'emoji', emoji: '🐼' } } });

  const vuParB = await B.until((s) => s.players.length === 2);
  t('B rejoint avec le code de A', !!vuParB);
  t('B voit A', vuParB.session.players.some((p) => p.id === 'p_mathys' && p.name === 'Mathys'));

  const vuParA = await A.until((s) => s.players.length === 2);
  t('A voit B, sans avoir rien demandé',
    vuParA.session.players.some((p) => p.id === 'p_lea' && p.name === 'Léa'));
  t('les deux voient le même hôte',
    vuParA.session.hostId === 'p_mathys' && vuParB.session.hostId === 'p_mathys');
  t('les deux voient le même code',
    vuParA.session.code === CODE && vuParB.session.code === CODE);

  // ── le tirage, à travers l'assemblage réel (catalogue + santé + hub)
  const pret = await A.until((s) => s.pool && s.pool.catalog === 'ready' && s.pool.health.precision === 'down'
    && s.pool.health.passeur === 'up', ['session'], 8000);
  t('le vrai serveur lit le catalogue et vérifie la santé des jeux', !!pret);
  t('un serveur de jeu mort est dit « down » et exclu, sans casser le reste',
    pret.session.pool.why.precision[0].code === 'SERVER_DOWN' && pret.session.pool.eligible.length === 3,
    pret.session.pool.eligible.join(','));
  B.send({ action: 'prefs', love: ['passeur'], veto: ['morpion'] });
  await A.until((s) => !!s.players.find((p) => p.id === 'p_lea' && p.veto.includes('morpion')));
  A.send({ action: 'draw' });
  const tire = await B.until((s) => s.draw && s.draw.status === 'drawn', ['session'], 8000);
  const g = tire.session.draw.gameId;
  t('A tire : B reçoit le jeu tiré par le serveur', ['demicercle', 'passeur'].includes(g), g);
  t('ni le jeu en veto, ni le serveur mort, ni le jeu à 3 joueurs',
    JSON.stringify(tire.session.draw.eligible) === '["demicercle","passeur"]');
  t('history.played = [jeu tiré]', JSON.stringify(tire.session.history.played) === JSON.stringify([g]));
  A.send({ action: 'continue' });
  const fini = await B.until((s) => s.state === 'debrief');
  t('continuer : la session revient au Hub (debrief), le jeu reste tiré', fini.session.draw.gameId === g);

  {
    const h = await health();
    t('/health compte une session et deux joueurs',
      h.body.sessions === 1 && h.body.players === 2, `${h.body.sessions}/${h.body.players}`);
  }

  // ── A ferme son onglet : B prend la main
  A.ws.close();
  const promu = await B.until((s) => s.hostId === 'p_lea');
  t('A se déconnecte : B devient hôte', promu.session.hostId === 'p_lea');
  t('B est marqué hôte dans la liste',
    promu.session.players.find((p) => p.id === 'p_lea').host === true);
  t('A reste visible, marqué absent',
    promu.session.players.find((p) => p.id === 'p_mathys').connected === false);

  // ── B ferme à son tour : plus personne, la session disparaît
  B.ws.close();
  await sleep(300);
  t('B se déconnecte : la session est supprimée', hub.sessions.size === 0,
    `${hub.sessions.size} session(s)`);
  {
    const h = await health();
    t('/health ne compte plus rien', h.body.sessions === 0 && h.body.players === 0);
  }

  // ── et son code ne sert plus à rien
  const C = client('C'); await C.open;
  C.send({ action: 'join', code: CODE, player: { id: 'p_tom', name: 'Tom', avatar: { kind: 'emoji', emoji: '🐢' } } });
  await sleep(300);
  const err = C.msgs.find((m) => m.type === 'error');
  t('le code d\'une session finie ne répond plus', !!err && err.code === 'SESSION_NOT_FOUND');
  C.ws.close();
}

setTimeout(async () => {
  try { await main(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + e.message); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
}, 300);
