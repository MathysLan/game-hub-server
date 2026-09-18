// Protocole WebSocket du Hub — de VRAIES connexions.
//
//   node test.js
//
// Le serveur est monté ici, dans le même processus, avec un délai de grâce
// court : sans ça, vérifier qu'un joueur absent finit par être retiré
// demanderait d'attendre une minute.
//
// ⚠️ Ce fichier assemble le hub à la main (createHub) au lieu de charger
// src/server.js, uniquement pour pouvoir régler `graceMs`. C'est test-e2e.js
// qui démarre le VRAI serveur, assemblage compris — sans quoi personne ne
// vérifierait que src/server.js se lance.
'use strict';

const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { createHub } = require('./src/hub.js');

const PORT = +(process.env.PORT || 8791);
const GRACE = 200;

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};

const hub = createHub({ graceMs: GRACE });
const server = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => hub.connection(ws));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Un client minimal : il garde tout ce qu'il reçoit et sait attendre un type.
function client(nom) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, nom, msgs: [], waiters: [], closed: false, closeCode: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => (w.type === m.type ? (w.resolve(m), false) : true));
  });
  ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
  c.open = new Promise((res) => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.raw = (s) => ws.send(s);
  c.wait = (type, ms = 3000) => new Promise((resolve, reject) => {
    const found = c.msgs.find((m) => m.type === type);
    if (found) return resolve(found);
    const w = { type, resolve };
    c.waiters.push(w);
    setTimeout(() => { if (c.waiters.includes(w)) reject(new Error(`${nom} : pas de « ${type} »`)); }, ms);
  });
  c.clear = () => { c.msgs.length = 0; };
  // ⚠️ Attendre « le prochain session » est une course : la diffusion de
  // l'action précédente peut arriver juste après un clear() et se faire passer
  // pour elle. On attend un état qui répond à une CONDITION, jamais un tour.
  c.until = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const fin = Date.now() + ms;
    const voir = () => {
      const m = [...c.msgs].reverse().find((x) => x.type === 'session' && pred(x.session));
      if (m) return resolve(m);
      if (Date.now() > fin) return reject(new Error(`${nom} : aucun état ne satisfait la condition`));
      setTimeout(voir, 25);
    };
    voir();
  });
  c.last = (type) => [...c.msgs].reverse().find((m) => m.type === type);
  return c;
}

const P = (id, name, extra = {}) => ({ id, name, avatar: { kind: 'emoji', emoji: '🦊' }, ...extra });

async function main() {
  console.log('Protocole du Hub — vraies connexions WebSocket\n');

  // ── 1-3. création
  const a = client('A'); await a.open;
  a.send({ action: 'create', player: P('p_aaaa', 'Mathys') });
  const created = await a.wait('created');
  t('création : le serveur répond « created »', !!created);
  t('création : un code de 5 caractères revient',
    /^[A-HJ-NP-Z2-9]{5}$/.test(created.session.code), created.session.code);
  t('création : le créateur est hôte',
    created.session.hostId === 'p_aaaa' && created.session.players[0].host === true);
  t('création : « you » identifie bien l\'appelant', created.you === 'p_aaaa');
  t('création : l\'état est lobby', created.session.state === 'lobby');
  const CODE = created.session.code;

  // ── 12. validation des données reçues
  {
    const bad = client('bad'); await bad.open;
    bad.raw('ceci n\'est pas du json');
    t('JSON illisible : erreur structurée', (await bad.wait('error')).code === 'BAD_JSON');
    bad.clear();
    bad.send({ action: 'danse' });
    t('action inconnue refusée', (await bad.wait('error')).code === 'UNKNOWN_ACTION');
    bad.clear();
    bad.send({ action: 'create', player: { id: 'x', name: 'y', avatar: { emoji: '🦊' } } });
    t('identifiant trop court refusé', (await bad.wait('error')).code === 'BAD_PLAYER');
    bad.clear();
    bad.send({ action: 'create', player: P('p_zzzz', '   ') });
    const e = await bad.wait('error');
    t('pseudo vide refusé, avec la raison', e.code === 'BAD_PLAYER' && /pseudo/.test(e.message), e.message);
    bad.clear();
    bad.send({ action: 'join', code: 'XX', player: P('p_zzzz', 'Z') });
    t('code mal formé refusé', (await bad.wait('error')).code === 'BAD_CODE');
    bad.clear();
    bad.send({ action: 'leave' });
    t('quitter sans session : refus propre', (await bad.wait('error')).code === 'NOT_IN_SESSION');
    bad.clear();
    // Message trop gros : le socket doit être fermé, pas gardé en mémoire.
    bad.raw(JSON.stringify({ action: 'create', player: P('p_yyyy', 'Y'.repeat(40000)) }));
    t('message trop volumineux : erreur puis fermeture',
      (await bad.wait('error')).code === 'TOO_BIG');
    await sleep(120);
    t('message trop volumineux : socket effectivement fermé', bad.closed === true);
  }

  // ── 5. join avec un code inexistant
  {
    const x = client('x'); await x.open;
    x.send({ action: 'join', code: 'ZZZZZ', player: P('p_xxxx', 'X') });
    t('join sur un code inconnu : SESSION_NOT_FOUND',
      (await x.wait('error')).code === 'SESSION_NOT_FOUND');
    x.ws.close();
  }

  // ── 4, 6, 7. deuxième joueur et synchronisation
  const b = client('B'); await b.open;
  a.clear();
  b.send({ action: 'join', code: CODE.toLowerCase(), player: P('p_bbbb', 'Léa', { avatar: { kind: 'emoji', emoji: '🐼' } }) });
  const joined = await b.wait('joined');
  t('join avec un code valide (minuscules pardonnées)', !!joined);
  t('B se voit et voit A', joined.session.players.length === 2);
  const pushA = await a.wait('session');
  t('A reçoit l\'état à jour sans avoir rien demandé', pushA.session.players.length === 2);
  t('A voit B nommément',
    pushA.session.players.some((p) => p.name === 'Léa' && p.avatar.emoji === '🐼'));
  t('l\'hôte reste A pour tout le monde',
    pushA.session.hostId === 'p_aaaa' && joined.session.hostId === 'p_aaaa');

  // ── 8. collision de player.id : un seul socket actif
  {
    const clone = client('clone'); await clone.open;
    clone.send({ action: 'join', code: CODE, player: P('p_bbbb', 'Faux Léa') });
    const rejoint = await clone.wait('joined');
    t('même player.id : on reprend la place, pas de doublon',
      rejoint.session.players.length === 2, `${rejoint.session.players.length} joueurs`);
    await sleep(150);
    t('l\'ancien socket du même joueur est fermé', b.closed === true, 'code ' + b.closeCode);
    t('l\'ancien socket est prévenu avant',
      !!b.msgs.find((m) => m.type === 'error' && m.code === 'REPLACED'));
    // On rend la main à un vrai B pour la suite.
    clone.ws.close();
    await sleep(GRACE + 150);
  }

  // ── 13. avatar image conservé côté Hub
  {
    const img = 'data:image/webp;base64,' + 'A'.repeat(400);
    const c = client('C'); await c.open;
    c.send({ action: 'join', code: CODE, player: P('p_cccc', 'Tom', { avatar: { kind: 'image', emoji: '🐢', src: img } }) });
    const r = await c.wait('joined');
    const tom = r.session.players.find((p) => p.id === 'p_cccc');
    t('l\'avatar image est conservé par le Hub', tom.avatar.kind === 'image' && tom.avatar.src === img);
    t('l\'emoji reste à côté, comme repli', tom.avatar.emoji === '🐢');
    c.ws.close();
    await sleep(GRACE + 150);
  }

  // ── 14. aucune fuite d'interne sur le fil
  {
    const texte = JSON.stringify(a.last('session') || pushA);
    t('le fil ne contient ni socket, ni id interne, ni horodatage',
      !/_socket|hs_|createdAt|graceMs|since/.test(texte));
  }

  // ── 9, 10. déconnexion et réélection
  {
    const d = client('D'); await d.open;
    d.send({ action: 'join', code: CODE, player: P('p_dddd', 'Noé') });
    await d.wait('joined');
    await a.until((s) => s.players.some((p) => p.id === 'p_dddd'));
    d.ws.close();
    const maj = await a.until((s) => {
      const n = s.players.find((p) => p.id === 'p_dddd');
      return n && n.connected === false;
    });
    t('déconnexion : le joueur est marqué absent, pas supprimé',
      !!maj.session.players.find((p) => p.id === 'p_dddd' && p.connected === false));
    const apres = await a.until((s) => !s.players.some((p) => p.id === 'p_dddd'), GRACE + 2000);
    t('après le délai de grâce : le joueur absent est retiré',
      !apres.session.players.some((p) => p.id === 'p_dddd'));
  }

  {
    // L'hôte s'en va : un autre prend la main tout de suite.
    const e = client('E'); await e.open;
    e.send({ action: 'join', code: CODE, player: P('p_eeee', 'Zoé') });
    await e.wait('joined');
    a.ws.close();
    const maj = await e.until((s) => s.hostId === 'p_eeee');
    t('l\'hôte part : réélection immédiate', maj.session.hostId === 'p_eeee', maj.session.hostId);
    t('le nouvel hôte est marqué côté joueur',
      maj.session.players.find((p) => p.id === 'p_eeee').host === true);

    // ── 11. dernier joueur parti : la session disparaît
    e.ws.close();
    await sleep(200);
    t('dernier joueur parti : la session est supprimée', hub.sessions.size === 0,
      `${hub.sessions.size} session(s)`);

    const z = client('z'); await z.open;
    z.send({ action: 'join', code: CODE, player: P('p_ffff', 'F') });
    t('son code ne répond plus', (await z.wait('error')).code === 'SESSION_NOT_FOUND');
    z.ws.close();
  }

  // ── 15. plusieurs sessions indépendantes
  {
    const a1 = client('a1'); await a1.open;
    const a2 = client('a2'); await a2.open;
    a1.send({ action: 'create', player: P('p_1111', 'Un') });
    a2.send({ action: 'create', player: P('p_2222', 'Deux') });
    const s1 = await a1.wait('created'), s2 = await a2.wait('created');
    t('deux sessions ont deux codes différents', s1.session.code !== s2.session.code);
    t('le Hub en compte bien deux', hub.sessions.size === 2);

    const b1 = client('b1'); await b1.open;
    a1.clear(); a2.clear();
    b1.send({ action: 'join', code: s1.session.code, player: P('p_3333', 'Trois') });
    await b1.wait('joined');
    await a1.wait('session');
    t('la première session voit son nouveau joueur', a1.last('session').session.players.length === 2);
    t('la seconde n\'a rien reçu', !a2.last('session'));

    // `leave` explicite : le joueur part vraiment, sans attendre la grâce.
    b1.send({ action: 'leave' });
    const seul = await a1.until((s) => s.players.length === 1);
    t('leave : le joueur est retiré tout de suite', seul.session.players.length === 1);

    a1.ws.close(); a2.ws.close(); b1.ws.close();
    await sleep(250);
    t('tout est nettoyé à la fin', hub.sessions.size === 0, `${hub.sessions.size} session(s)`);
  }
}

server.listen(PORT, async () => {
  try { await main(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + e.message); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  wss.close(); server.close();
  process.exit(ko ? 1 : 0);
});
