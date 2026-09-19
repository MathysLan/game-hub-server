// Randomizer sur de VRAIES connexions WebSocket : préférences, capacités,
// contrainte, tirage, confirmation, concurrence, reconnexion, sécurité.
//
//   node test-draw.js
//
// Montage :
//   - le catalogue passe par le VRAI lecteur (src/catalog.js), sur un fichier
//     qui reprend les valeurs du manifest réel du portfolio ;
//   - seules les URL `health` pointent vers un faux serveur HTTP local, pour
//     pouvoir rendre un jeu malade, lent ou mort à volonté. Le Hub ne fait
//     qu'un GET dessus — c'est exactement ce qu'on vérifie aussi.
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

const PORT = +(process.env.PORT || 8793);
const HPORT = PORT + 1;

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── faux serveurs de jeu : seulement leur /health ──────────────────────────
const sante = {};            // gameId → { code, delay }
const appels = [];           // { id, method, upgrade }
const santeSrv = createServer((req, res) => {
  const id = req.url.replace(/^\//, '').split('?')[0];
  appels.push({ id, method: req.method, upgrade: !!req.headers.upgrade });
  // `seq` : une suite de codes, un par requête (un serveur qui se réveille).
  const c = sante[id] || { code: 200, delay: 0 };
  if (Array.isArray(c.seq)) c.code = c.seq.length > 1 ? c.seq.shift() : c.seq[0];
  setTimeout(() => { res.writeHead(c.code); res.end(c.code === 200 ? 'ok' : 'ko'); }, c.delay);
});

// Le catalogue : les valeurs du manifest réel, santé redirigée en local.
const on = (id, title, emoji, min, max, mmin, mmax, needs = []) => ({ id, title, emoji, url: `games/${id}/`, mode: 'online',
  players: { min, max }, minutes: { min: mmin, max: mmax }, needs, categories: ['reflexe'],
  server: `wss://${id}-server.onrender.com`, health: `http://127.0.0.1:${HPORT}/${id}`, join: 'v1', content: false, replay: false });
const MANIFEST = { version: 1, games: [
  on('morpion', 'Morpion', '⭕', 2, 2, 1, 5),
  on('imitation', 'Imitation', '🎤', 2, 8, 6, 15, ['mic']),
  on('demicercle', 'Demi-Cercle', '🎯', 2, 10, 2, 15),
  { id: 'puissance4', title: 'Puissance 4', emoji: '🔴', action: 'connect4', mode: 'local', players: { min: 1, max: 1 }, minutes: { min: 2, max: 6 }, needs: [], categories: ['solo'], content: false, replay: false },
  on('ban', 'Le Jeu du Ban', '🚫', 2, 10, 5, 12, ['consent']),
  on('precision', 'Précision', '🎯', 1, 12, 3, 10),
  on('passeur', 'Le Passeur', '🏐', 1, 8, 3, 8),
  on('quiment', 'Qui Ment ?', '🕵️', 3, 8, 8, 15),
] };
const FICHIER = path.join(os.tmpdir(), `hub-manifest-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify(MANIFEST));

let hub = null;
const catalog = createCatalog({ file: FICHIER });
// TTL courts : un serveur « vu vivant » est revérifié au tirage suivant, ce qui
// laisse le temps d'observer l'état `pending` et d'y glisser des événements.
const health = createHealth({ timeoutMs: 600, upTtlMs: 250, downTtlMs: 250, onChange: () => hub && hub.broadcastAll() });
hub = createHub({ graceMs: 1500, heartbeatMs: 0, catalog, health });
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
  // Un état qui satisfait une condition, reçu APRÈS `from`.
  c.until = (pred, ms, from) => c.waitFor((m) => m.type === 'session' && pred(m.session), ms, from).then((m) => m.session);
  c.error = (code, ms, from) => c.waitFor((m) => m.type === 'error' && m.code === code, ms, from);
  c.last = () => { const m = [...c.msgs].reverse().find((x) => x.type === 'session' || x.type === 'created' || x.type === 'joined'); return m && m.session; };
  return c;
}
const P = (id, name, emoji = '🦊') => ({ id, name, avatar: { kind: 'emoji', emoji } });
const joueur = (s, id) => s.players.find((p) => p.id === id);

async function rejoindre(nom, id, code) {
  const c = client(nom); await c.open;
  c.send({ action: 'join', code, player: P(id, nom) });
  await c.waitFor((m) => m.type === 'joined');
  return c;
}

async function main() {
  console.log('Randomizer — protocole sur vraies connexions\n');

  // ── création, catalogue, pré-réveil
  const a = client('A'); await a.open;
  a.send({ action: 'create', player: P('p_aaaa', 'Alice') });
  const code = (await a.waitFor((m) => m.type === 'created')).session.code;
  const b = await rejoindre('B', 'p_bbbb', code);
  const s0 = await b.until((s) => s.pool && s.pool.catalog === 'ready' && Object.values(s.pool.health).every((h) => h === 'up'), 4000);
  t('catalogue : lu par le Hub, et voyage dans l\'état de session', s0.pool.games.length === 8, s0.pool.games.join(','));
  t('pré-réveil : à la création, le Hub a interrogé les 7 serveurs en ligne', new Set(appels.map((x) => x.id)).size === 7);
  t('santé : uniquement des GET HTTP, jamais un WebSocket vers un jeu', appels.every((x) => x.method === 'GET' && !x.upgrade));
  t('éligibilité à 2 (sans micro ni consentement) : morpion, demicercle, precision, passeur',
    JSON.stringify(s0.pool.eligible) === '["morpion","demicercle","precision","passeur"]', s0.pool.eligible.join(','));
  t('why : Qui Ment ? « il faut 3 », Imitation « micro », Ban « consentement », P4 « local »',
    s0.pool.why.quiment[0].code === 'TOO_FEW' && s0.pool.why.imitation[0].code === 'NEEDS' && s0.pool.why.imitation[0].need === 'mic'
    && s0.pool.why.ban[0].need === 'consent' && s0.pool.why.puissance4[0].code === 'LOCAL_ONLY');
  t('état public : draw vide, historique vide, contrainte nulle', s0.draw === null && s0.history.played.length === 0 && s0.constraints.maxMinutes === null);

  // ── préférences : chacun pour soi
  let m = b.mark();
  a.send({ action: 'prefs', love: ['passeur'], veto: [] });
  b.send({ action: 'prefs', love: [], veto: ['morpion'] });
  let s = await b.until((x) => joueur(x, 'p_aaaa').love.includes('passeur') && joueur(x, 'p_bbbb').veto.includes('morpion'), 3000, m);
  t('prefs : A ❤️ Passeur et B 🚫 Morpion, visibles chez B', true);
  t('prefs : le veto de B exclut Morpion, raison nominative',
    !s.pool.eligible.includes('morpion') && JSON.stringify(s.pool.why.morpion) === '[{"code":"VETO","players":["p_bbbb"]}]');
  t('prefs : le cœur de A double presque Passeur (1,5)', s.pool.weights.passeur === 1.5 && s.pool.weights.precision === 1);
  const sa = await a.until((x) => joueur(x, 'p_bbbb').veto.includes('morpion'), 3000);
  t('prefs : synchronisées chez A aussi', JSON.stringify(sa.pool.eligible) === JSON.stringify(s.pool.eligible));

  // Sécurité : B tente d'écrire les préférences de A.
  m = a.mark();
  b.send({ action: 'prefs', player: 'p_aaaa', id: 'p_aaaa', love: [], veto: ['passeur'] });
  s = await a.until((x) => joueur(x, 'p_bbbb').veto.includes('passeur'), 3000, m);
  t('sécurité : un prefs ne touche QUE son émetteur (le champ player est ignoré)',
    joueur(s, 'p_aaaa').veto.length === 0 && joueur(s, 'p_aaaa').love.includes('passeur'));
  t('sécurité : l\'hôte ne peut pas lever le veto de B', (() => { a.send({ action: 'prefs', love: ['passeur'], veto: [] }); return true; })()
    && !(await a.until((x) => true, 500)).pool.eligible.includes('passeur'));
  m = a.mark();
  b.send({ action: 'prefs', love: [], veto: ['morpion'] });
  await a.until((x) => JSON.stringify(joueur(x, 'p_bbbb').veto) === '["morpion"]', 3000, m);

  // ── capacités
  m = a.mark();
  a.send({ action: 'caps', caps: { mic: true } });
  s = await a.until((x) => joueur(x, 'p_aaaa').caps.mic === true, 3000, m);
  t('caps : A seul a un micro → Imitation toujours exclue, B nommé',
    JSON.stringify(s.pool.why.imitation) === '[{"code":"NEEDS","need":"mic","players":["p_bbbb"]}]');
  m = a.mark();
  b.send({ action: 'caps', caps: { mic: true } });
  s = await a.until((x) => joueur(x, 'p_bbbb').caps.mic === true, 3000, m);
  t('caps : les deux ont un micro → Imitation éligible', s.pool.eligible.includes('imitation'));
  b.send({ action: 'caps', caps: { mic: 'oui' } });
  t('caps : une valeur non booléenne est refusée', !!(await b.error('BAD_CAPS')));
  m = a.mark();
  b.send({ action: 'caps', caps: { mic: false } });
  await a.until((x) => joueur(x, 'p_bbbb').caps.mic === false, 3000, m);

  // ── hôte
  b.send({ action: 'draw' });
  t('hôte : un non-hôte ne peut pas tirer (NOT_HOST)', !!(await b.error('NOT_HOST')));
  b.send({ action: 'constraints', maxMinutes: 5 });
  t('hôte : un non-hôte ne peut pas régler la durée', !!(await b.error('NOT_HOST', 3000, b.mark() - 1)));
  t('hôte : ni l\'un ni l\'autre n\'a bougé l\'état', a.last().state === 'lobby' && a.last().constraints.maxMinutes === null);

  // ── contrainte de durée
  m = a.mark();
  a.send({ action: 'constraints', maxMinutes: 8 });
  s = await a.until((x) => x.constraints.maxMinutes === 8, 3000, m);
  t('durée ≤ 8 : Demi-Cercle (max 15) écarté, Passeur (max 8) gardé',
    s.pool.why.demicercle.some((r) => r.code === 'TOO_LONG') && s.pool.eligible.includes('passeur'));
  m = a.mark();
  a.send({ action: 'constraints', maxMinutes: null });
  await a.until((x) => x.constraints.maxMinutes === null, 3000, m);

  // ── 1er tirage
  const ma = a.mark(), mb = b.mark();
  a.send({ action: 'draw', gameId: 'morpion', players: 1 });       // champs forgés : ignorés
  const pend = await b.until((x) => x.state === 'drawing' && x.draw && x.draw.status === 'pending', 3000, mb);
  t('tirage : l\'état passe à drawing, chez tout le monde, AVANT le résultat', pend.draw.gameId === null);
  const d1a = await a.until((x) => x.draw && x.draw.status === 'drawn', 4000, ma);
  const d1b = await b.until((x) => x.draw && x.draw.status === 'drawn', 4000, mb);
  const g1 = d1a.draw.gameId;
  t('tirage : un jeu tiré PAR LE SERVEUR, parmi les éligibles', !!g1 && d1a.draw.eligible.includes(g1), g1);
  t('tirage : A et B voient le même tirage (id, jeu, liste)',
    d1a.draw.id === d1b.draw.id && d1b.draw.gameId === g1 && JSON.stringify(d1a.draw.eligible) === JSON.stringify(d1b.draw.eligible));
  t('tirage : Morpion (veto de B) n\'est pas dans la liste, malgré « gameId: morpion »',
    !d1a.draw.eligible.includes('morpion') && g1 !== 'morpion');
  t('tirage : « players: 1 » ignoré — le compte vient de la session (P4 exclu, Passeur/Précision présents)',
    !d1a.draw.eligible.includes('puissance4') && d1a.draw.eligible.includes('precision'));
  t('tirage : les poids du moment sont joints (Passeur aimé : 1,5)', d1a.draw.weights.passeur === 1.5);
  t('tirage : drawnAt et numéro', d1a.draw.n === 1 && typeof d1a.draw.drawnAt === 'number');
  t('historique : [g1]', JSON.stringify(d1a.history.played) === JSON.stringify([g1]));

  // Un second draw avant « continuer » : refusé, rien ne bouge.
  m = a.mark();
  a.send({ action: 'draw' });
  t('concurrence : draw pendant un tirage révélé → DRAW_IN_PROGRESS', !!(await a.error('DRAW_IN_PROGRESS', 3000, m)));
  await sleep(150);
  t('concurrence : toujours UN jeu, UN tirage', a.last().draw.id === d1a.draw.id && a.last().history.played.length === 1);

  b.send({ action: 'continue' });
  t('continuer : réservé à l\'hôte', !!(await b.error('NOT_HOST', 3000, b.mark() - 1)));
  m = a.mark();
  a.send({ action: 'continue' });
  s = await a.until((x) => x.state === 'debrief', 3000, m);
  t('continuer : state debrief, tirage confirmé, rien d\'effacé',
    s.draw.status === 'confirmed' && s.draw.gameId === g1 && s.history.played.length === 1);
  a.send({ action: 'continue' });
  t('continuer : deux fois → NOT_DRAWN', !!(await a.error('NOT_DRAWN', 3000, m)));

  // ── 2e tirage : l'historique grandit, la récence s'applique
  m = a.mark();
  a.send({ action: 'draw' });
  const d2 = await a.until((x) => x.draw && x.draw.n === 2 && x.draw.status === 'drawn', 4000, m);
  t('2e tirage : même session, même code', d2.code === code);
  t('2e tirage : history.played = [g1, g2], le premier toujours là',
    d2.history.played.length === 2 && d2.history.played[0] === g1 && d2.history.played[1] === d2.draw.gameId,
    d2.history.played.join(' → '));
  const attendu = { passeur: 1.5, demicercle: 1, precision: 1 };
  attendu[g1] = Math.round(attendu[g1] * 0.15 * 10000) / 10000;
  t('2e tirage : le jeu précédent pèse ×0,15 (récence)', d2.draw.weights[g1] === attendu[g1], JSON.stringify(d2.draw.weights));
  m = a.mark();
  a.send({ action: 'continue' });
  await a.until((x) => x.state === 'debrief' && x.draw.n === 2, 3000, m);

  // ── concurrence stricte : deux draw envoyés dans la même milliseconde
  m = a.mark();
  a.send({ action: 'draw' }); a.send({ action: 'draw' });
  const err = await a.error('DRAW_IN_PROGRESS', 3000, m);
  const d3 = await a.until((x) => x.draw && x.draw.n === 3 && x.draw.status === 'drawn', 4000, m);
  await sleep(200);
  const tous = a.msgs.slice(m).filter((x) => x.type === 'session' && x.session.draw && x.session.draw.status === 'drawn');
  t('concurrence : deux draw simultanés → un seul tirage, le second refusé', !!err && new Set(tous.map((x) => x.session.draw.id)).size === 1);
  t('concurrence : jamais deux jeux pour ce tirage', new Set(tous.map((x) => x.session.draw.gameId)).size === 1);
  t('concurrence : l\'historique n\'a pris qu\'UNE entrée', d3.history.played.length === 3);
  m = a.mark();
  a.send({ action: 'continue' });
  await a.until((x) => x.state === 'debrief' && x.draw.n === 3, 3000, m);

  // ── reconnexion PENDANT un tirage en attente
  sante.passeur = { code: 200, delay: 400 };           // un serveur lent : le tirage reste pending
  await sleep(300);                                    // la santé « up » est périmée (TTL 250 ms)
  m = a.mark();
  a.send({ action: 'draw' });
  const pend4 = await a.until((x) => x.draw && x.draw.n === 4 && x.draw.status === 'pending', 3000, m);
  b.ws.terminate();                                    // B coupé net pendant l'attente
  const b2 = await rejoindre('B', 'p_bbbb', code);     // …et revient aussitôt
  const vuB2 = b2.last();
  t('reconnexion pendant pending : B revient sur le MÊME tirage en cours', vuB2.draw.id === pend4.draw.id && vuB2.state === 'drawing');
  const d4 = await a.until((x) => x.draw && x.draw.n === 4 && x.draw.status === 'drawn', 4000, m);
  const d4b = await b2.until((x) => x.draw && x.draw.n === 4 && x.draw.status === 'drawn', 4000);
  t('reconnexion pendant pending : un seul résultat, le même chez A et B', d4.draw.gameId === d4b.draw.gameId && d4.draw.id === pend4.draw.id);
  t('reconnexion pendant pending : aucun tirage de plus', d4.history.played.length === 4);
  sante.passeur = { code: 200, delay: 0 };

  // ── reconnexion APRÈS la révélation
  b2.ws.terminate();
  const b3 = await rejoindre('B', 'p_bbbb', code);
  await sleep(150);
  const vu = b3.last();
  t('reconnexion après tirage : B retrouve le tirage révélé, sans en provoquer un autre',
    vu.draw.id === d4.draw.id && vu.draw.gameId === d4.draw.gameId && vu.history.played.length === 4 && vu.state === 'drawing');
  t('reconnexion : ses préférences et capacités sont conservées', JSON.stringify(joueur(vu, 'p_bbbb').veto) === '["morpion"]');
  m = a.mark();
  a.send({ action: 'continue' });
  await a.until((x) => x.state === 'debrief' && x.draw.n === 4, 3000, m);

  // ── un serveur de jeu tombe
  sante.passeur = { code: 503, delay: 0 };
  await sleep(300);
  m = a.mark();
  a.send({ action: 'draw' });
  const d5 = await a.until((x) => x.draw && x.draw.n === 5 && x.draw.status === 'drawn', 4000, m);
  t('serveur down (503) : Passeur n\'est pas tiré, ni même proposé', !d5.draw.eligible.includes('passeur') && d5.draw.gameId !== 'passeur');
  t('serveur down : la raison est dite dans le salon', (d5.pool.why.passeur || []).some((r) => r.code === 'SERVER_DOWN'));
  t('serveur down : la session continue normalement', d5.players.length === 2);
  m = a.mark();
  a.send({ action: 'continue' });
  await a.until((x) => x.state === 'debrief' && x.draw.n === 5, 3000, m);
  sante.passeur = { code: 200, delay: 2000 };          // plus lent que le délai (600 ms) : c'est une panne
  await sleep(300);
  m = a.mark();
  a.send({ action: 'draw' });
  const d6 = await a.until((x) => x.draw && x.draw.n === 6 && x.draw.status === 'drawn', 5000, m);
  t('serveur muet (délai dépassé) : écarté du tirage', !d6.draw.eligible.includes('passeur'));
  sante.passeur = { code: 200, delay: 0 };
  m = a.mark();
  a.send({ action: 'continue' });
  await a.until((x) => x.state === 'debrief' && x.draw.n === 6, 3000, m);

  // ── aucun jeu possible
  m = a.mark();
  a.send({ action: 'prefs', love: [], veto: ['demicercle', 'precision', 'passeur', 'ban', 'imitation'] });
  s = await a.until((x) => joueur(x, 'p_aaaa').veto.length === 5, 3000, m);
  t('aucun jeu : le salon le montre avant même de tirer', s.pool.eligible.length === 0);
  m = a.mark();
  a.send({ action: 'draw' });
  const e0 = await a.error('NO_ELIGIBLE_GAME', 4000, m);
  t('aucun jeu : erreur explicite NO_ELIGIBLE_GAME, avec le pourquoi', !!e0 && Object.keys(e0.why || {}).length === 8);
  s = await a.until((x) => x.state === 'debrief', 3000, m);
  t('aucun jeu : pas de repli — la session revient à son état, tirage précédent intact',
    s.draw.n === 6 && s.draw.status === 'confirmed' && s.history.played.length === 6);
  m = a.mark();
  a.send({ action: 'prefs', love: [], veto: [] });
  await a.until((x) => joueur(x, 'p_aaaa').veto.length === 0, 3000, m);

  // ── changement d'hôte : B peut tirer quand A part
  const mb4 = b3.mark();
  a.send({ action: 'leave' });
  await b3.until((x) => x.hostId === 'p_bbbb' && x.players.length === 1, 3000, mb4);
  b3.send({ action: 'draw' });
  const d7 = await b3.until((x) => x.draw && x.draw.n === 7 && x.draw.status === 'drawn', 4000, mb4);
  t('hôte parti : le nouvel hôte tire, l\'historique de la soirée suit', d7.draw.by === 'p_bbbb' && d7.history.played.length === 7);
  t('hôte parti : à 1 joueur, le moteur recalcule (Puissance 4 redevient possible)', d7.draw.eligible.includes('puissance4'));

  // ── nouvelle session = historique vide
  const c = client('C'); await c.open;
  c.send({ action: 'create', player: P('p_cccc', 'Chloé') });
  const nouv = (await c.waitFor((x) => x.type === 'created')).session;
  t('nouvelle session : historique vide, aucun tirage', nouv.history.played.length === 0 && nouv.draw === null && nouv.code !== code);

  // ── un serveur qui SE RÉVEILLE n'est pas un serveur mort (mesuré en prod)
  {
    const H2 = createHealth({ timeoutMs: 3000, retryMs: 150, quiet: true });
    sante.reveil = { seq: [503, 502, 503, 200], delay: 0 };
    const avant = appels.length;
    const t0 = Date.now();
    const r1 = await H2.check({ id: 'reveil', mode: 'online', health: `http://127.0.0.1:${HPORT}/reveil` });
    t('réveil : 503, 502, 503 puis 200 → « up » (réessais dans la fenêtre)', r1 === 'up' && appels.length - avant === 4,
      `${appels.length - avant} requêtes, ${Date.now() - t0} ms`);
    sante.mort = { code: 503, delay: 0 };
    const t1 = Date.now();
    const r2 = await H2.check({ id: 'mort', mode: 'online', health: `http://127.0.0.1:${HPORT}/mort` });
    t('toujours 503 : « down » seulement à la fin de la fenêtre', r2 === 'down' && Date.now() - t1 >= 2900, `${Date.now() - t1} ms`);
    const t2 = Date.now();
    const r3 = await H2.check({ id: 'ferme', mode: 'online', health: 'http://127.0.0.1:45999/' });
    t('connexion refusée (personne n\'écoute) : « down » tout de suite, sans réessai', r3 === 'down' && Date.now() - t2 < 1000, `${Date.now() - t2} ms`);
  }

  // ── Hub sans catalogue : le salon vit, le tirage refuse proprement
  const hub2 = createHub({ heartbeatMs: 0 });
  const fauxWs = { readyState: 1, sent: [], send(x) { this.sent.push(JSON.parse(x)); }, on() {}, close() {} };
  hub2.connection(Object.assign(fauxWs, { on(ev, fn) { if (ev === 'message') this.onmsg = fn; } }));
  fauxWs.onmsg(JSON.stringify({ action: 'create', player: P('p_zzzz', 'Z') }));
  fauxWs.onmsg(JSON.stringify({ action: 'draw' }));
  await sleep(50);
  const errs = fauxWs.sent.filter((x) => x.type === 'error').map((x) => x.code);
  const fin = fauxWs.sent.filter((x) => x.type === 'session').pop().session;
  t('catalogue indisponible : MANIFEST_UNAVAILABLE, et retour au salon', errs.includes('MANIFEST_UNAVAILABLE') && fin.state === 'lobby' && fin.draw === null, JSON.stringify(fauxWs.sent.map((x) => x.type + ':' + (x.code || x.session.state))));
  hub2.stop();

  for (const k of [a, b, b2, b3, c]) { try { k.ws.terminate(); } catch (_) {} }
}

santeSrv.listen(HPORT, () => server.listen(PORT, async () => {
  try { await main(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + (e.stack || e.message)); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  hub.stop(); wss.close(); server.close(); santeSrv.close();
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  process.exit(ko ? 1 : 0);
}));
