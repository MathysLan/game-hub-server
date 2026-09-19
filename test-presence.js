// Présence : heartbeat, départ volontaire, coupure réseau, reprise — de
// VRAIES connexions WebSocket.
//
//   node test-presence.js
//
// Le hub est monté ici avec des délais courts (ping toutes les 150 ms, grâce de
// 600 ms) pour tout vérifier en quelques secondes. Les valeurs de production
// (20 s et 60 s) sont celles de src/hub.js et src/session.js.
//
// Une connexion MORTE est simulée par un client `ws` créé avec
// `autoPong: false` : il ne répond plus aux pings, exactement comme un
// téléphone passé en mode avion (le socket reste « ouvert » de son côté, mais
// plus rien ne revient).
'use strict';

const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { createHub, HEARTBEAT_MS } = require('./src/hub.js');

const PORT = +(process.env.PORT || 8792);
const BEAT = 150;
const GRACE = 600;

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};

const hub = createHub({ graceMs: GRACE, heartbeatMs: BEAT });
const server = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => hub.connection(ws));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(nom, options) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, options);
  const c = { ws, nom, msgs: [], pings: 0, closed: false, closeCode: null };
  ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  ws.on('ping', () => { c.pings++; });
  ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
  ws.on('error', () => {});
  c.open = new Promise((res) => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.first = (type, ms = 3000) => c.waitFor((m) => m.type === type, ms);
  // Un état qui satisfait une CONDITION (jamais « le prochain message »).
  // `from` : ne regarder que les messages reçus APRÈS ce rang — sinon un vieil
  // état (d'avant l'action testée) satisfait la condition trop tôt.
  c.mark = () => c.msgs.length;
  c.until = (pred, ms = 3000, from = 0) => c.waitFor((m) => m.type === 'session' && pred(m.session), ms, from);
  c.waitFor = (pred, ms, from = 0) => new Promise((resolve, reject) => {
    const fin = Date.now() + ms;
    const voir = () => {
      const m = c.msgs.slice(from).reverse().find(pred);
      if (m) return resolve(m);
      if (Date.now() > fin) return reject(new Error(`${nom} : condition non atteinte en ${ms} ms`));
      setTimeout(voir, 10);
    };
    voir();
  });
  return c;
}
const P = (id, name) => ({ id, name, avatar: { kind: 'emoji', emoji: '🦊' } });
const joueur = (s, id) => s.players.find((p) => p.id === id);

async function creer(nom, id) {
  const c = client(nom); await c.open;
  c.send({ action: 'create', player: P(id, nom) });
  return { c, code: (await c.first('created')).session.code };
}
async function rejoindre(nom, id, code, options) {
  const c = client(nom, options); await c.open;
  c.send({ action: 'join', code, player: P(id, nom) });
  await c.first('joined');
  return c;
}

async function main() {
  console.log('Présence du Hub — heartbeat, départs, coupures, reprises\n');
  t('fréquence de production documentée : un ping toutes les 20 s', HEARTBEAT_MS === 20000);

  // ── 1-2. heartbeat : les pings arrivent, une connexion qui répond reste
  const { c: a, code } = await creer('A', 'p_aaaa');
  const b = await rejoindre('B', 'p_bbbb', code);
  await sleep(BEAT * 6);
  t('1. heartbeat : le serveur envoie des pings régulièrement', a.pings >= 4 && b.pings >= 4, `${a.pings} / ${b.pings} pings`);
  t('2. une connexion qui répond aux pings n\'est jamais coupée', !a.closed && !b.closed);
  t('2. … et reste « connectée » pour les autres',
    joueur(hub.sessions.get(code).players.length ? hubPublic(code) : { players: [] }, 'p_bbbb').connected === true);

  // ── 3-4. connexion morte : elle ne répond plus → coupée → absente
  const m = await rejoindre('M', 'p_mort', code, { autoPong: false });
  const t0 = Date.now();
  const vu = await a.until((s) => joueur(s, 'p_mort') && joueur(s, 'p_mort').connected === false, BEAT * 6);
  const delai = Date.now() - t0;
  t('3. connexion morte détectée et coupée par le serveur', m.closed === true, `code ${m.closeCode}`);
  t(`3. détectée en ≤ 2 tours de heartbeat (${delai} ms pour un tour de ${BEAT} ms)`, delai <= BEAT * 2 + 150);
  t('4. déconnexion réseau → le joueur est ABSENT, pas retiré', !!joueur(vu.session, 'p_mort') && vu.session.players.length === 3);

  // ── 5. reprise pendant le délai de grâce : même player.id, pas de doublon
  const avantReprise = a.mark();
  const m2 = await rejoindre('M', 'p_mort', code);
  const repris = await a.until((s) => joueur(s, 'p_mort') && joueur(s, 'p_mort').connected === true, 3000, avantReprise);
  t('5. reprise pendant le délai de grâce : le joueur est récupéré', !!repris);
  t('5. … même player.id, aucun doublon', repris.session.players.filter((p) => p.id === 'p_mort').length === 1 && repris.session.players.length === 3);
  await sleep(GRACE + 200);
  t('5. … et il n\'est PAS retiré à l\'échéance de l\'ancienne grâce', !!joueur(hubPublic(code), 'p_mort'));

  // ── 4 bis. une coupure brutale côté client (sans trame de fermeture)
  const avantCoupure = a.mark();
  m2.ws.terminate();
  const abs = await a.until((s) => joueur(s, 'p_mort') && joueur(s, 'p_mort').connected === false, 3000, avantCoupure);
  t('4. coupure brutale côté client → absent', !!abs);
  const retire = await a.until((s) => !joueur(s, 'p_mort'), GRACE + 1500, avantCoupure);
  t('4. … puis retiré au bout du délai de grâce', !!retire && retire.session.players.length === 2);

  // ── 6, 8. leave explicite : retiré TOUT DE SUITE, la session continue
  const c = await rejoindre('C', 'p_cccc', code);
  await a.until((s) => !!joueur(s, 'p_cccc'));
  const t1 = Date.now(), depuis = a.mark();
  c.send({ action: 'leave' });
  await a.until((s) => !joueur(s, 'p_cccc'), 3000, depuis);
  const vite = Date.now() - t1;
  t(`6. leave explicite : retiré immédiatement (${vite} ms, grâce = ${GRACE} ms)`, vite < GRACE / 2);
  t('8. plusieurs joueurs : un leave conserve la session', hub.sessions.has(code) && hubPublic(code).players.length === 2,
    hubPublic(code).players.map((p) => p.id + (p.connected ? '+' : '-')).join(' '));

  // ── 9. changement d'hôte : par leave, puis par heartbeat
  const depuisB = b.mark();
  a.send({ action: 'leave' });
  const h1 = await b.until((s) => s.hostId === 'p_bbbb' && !joueur(s, 'p_aaaa'), 3000, depuisB);
  t('9. l\'hôte fait leave : l\'hôte passe immédiatement au suivant', !!h1);
  const d = await rejoindre('D', 'p_dddd', code);
  const e = await rejoindre('E', 'p_eeee', code, { autoPong: false });
  await b.until((s) => !!joueur(s, 'p_eeee'));
  b.send({ action: 'leave' });                      // D devient hôte (plus ancien connecté)
  await d.until((s) => s.hostId === 'p_dddd');
  d.ws.terminate();                                 // D coupé brutalement : absent
  const h2 = await e.until((s) => s.hostId === 'p_eeee', 2000).catch(() => null);
  t('9. l\'hôte coupé net : l\'hôte passe au joueur encore connecté', !!h2, h2 ? '' : 'E n\'est pas devenu hôte');

  // ── 7. dernier joueur CONNECTÉ en leave → session supprimée immédiatement,
  //       même s'il reste des absents dans leur délai de grâce.
  //       (E ne répond pas aux pings : on le laisse partir d'abord, puis on
  //       reconstruit une situation propre.)
  e.ws.terminate();
  await sleep(100);
  t('fermeture de socket du dernier connecté : session supprimée (inchangé)', !hub.sessions.has(code));

  const { c: x, code: code2 } = await creer('X', 'p_xxxx');
  const y = await rejoindre('Y', 'p_yyyy', code2);
  y.ws.terminate();                                  // Y : absent, en délai de grâce
  await x.until((s) => joueur(s, 'p_yyyy') && !joueur(s, 'p_yyyy').connected);
  x.send({ action: 'leave' });                       // X, dernier connecté, part volontairement
  await sleep(50);
  t('7. dernier connecté en leave : session supprimée IMMÉDIATEMENT (absent en grâce compris)',
    !hub.sessions.has(code2), `${hub.sessions.size} session(s)`);
  const y2 = client('Y2'); await y2.open;
  y2.send({ action: 'join', code: code2, player: P('p_yyyy', 'Y') });
  t('7. … l\'absent qui revient apprend que la session est terminée', (await y2.first('error')).code === 'SESSION_NOT_FOUND');

  const { c: solo, code: code3 } = await creer('Solo', 'p_solo');
  solo.send({ action: 'leave' });
  await sleep(50);
  t('7. seul joueur en leave : session supprimée immédiatement', !hub.sessions.has(code3));

  // ── 10. create / join toujours intacts après tout ça
  const { c: n1, code: code4 } = await creer('N1', 'p_nnn1');
  const n2 = await rejoindre('N2', 'p_nnn2', code4);
  const vu2 = await n1.until((s) => s.players.length === 2);
  t('10. create + join : toujours deux joueurs, un hôte', vu2.session.hostId === 'p_nnn1' && !!joueur(vu2.session, 'p_nnn2'));
  t('10. après leave, le même socket peut recréer une session', await (async () => {
    n2.send({ action: 'leave' }); await sleep(50);
    n2.send({ action: 'create', player: P('p_nnn2', 'N2') });
    return !!(await n2.first('created'));
  })());

  for (const k of [a, b, c, d, e, m, m2, x, y, y2, solo, n1, n2]) { try { k.ws.terminate(); } catch (_) {} }
  await sleep(100);
  t('fin : plus aucune session', hub.sessions.size === 0, `${hub.sessions.size}`);
}

// État public courant d'une session (lecture directe, pour les assertions).
function hubPublic(code) {
  const { publicSession } = require('./src/serialize.js');
  const s = hub.sessions.get(code);
  return s ? publicSession(s) : { players: [] };
}

server.listen(PORT, async () => {
  try { await main(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + e.message); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  hub.stop(); wss.close(); server.close();
  process.exit(ko ? 1 : 0);
});
