// Profils PUBLICS (lot K) : sur de VRAIES connexions WebSocket, qui peut
// consulter le profil de qui — et surtout qui ne le peut pas.
//
//   node test-public-profile.js
//
// La règle : un player.id seul n'ouvre RIEN. La cible doit être dans la
// session du demandeur ET sa clé doit y avoir été vérifiée.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const ST = require('./src/stats.js');
const { createMemoryStore } = require('./src/store-memory.js');
const { createHub } = require('./src/hub.js');
const { createCatalog } = require('./src/catalog.js');
const { createHealth } = require('./src/health.js');

const PORT = +(process.env.PORT || 8827);
let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const on = (id) => ({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online', players: { min: 1, max: 12 }, minutes: { min: 1, max: 8 },
  needs: [], categories: ['reflexe'], server: `wss://${id}.example`, health: `http://127.0.0.1:1/${id}`, join: 'v1', content: false, replay: false, handoff: true });
const JEUX = ['passeur', 'ban', 'precision'];
const FICHIER = path.join(os.tmpdir(), `hub-public-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: JEUX.map(on) }));

let panne = false;
const store = createMemoryStore({ down: () => panne });
const catalog = createCatalog({ file: FICHIER });
const hub = createHub({ graceMs: 3000, heartbeatMs: 0, catalog, health: createHealth({ timeoutMs: 300 }), statsStore: store, statsRetryMs: [150, 400] });
const hubSans = createHub({ graceMs: 3000, heartbeatMs: 0, catalog, health: createHealth({ timeoutMs: 300 }) });
const serveur = (h) => { const s = createServer((_q, r) => { r.writeHead(200); r.end('ok'); }); new WebSocketServer({ server: s }).on('connection', (ws) => h.connection(ws)); return s; };
const server = serveur(hub), serverSans = serveur(hubSans);

const tous = [];
function client(nom, port = PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { ws, nom, msgs: [] };
  tous.push(c);
  ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  ws.on('error', () => {});
  c.open = new Promise((res) => ws.on('open', res));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.mark = () => c.msgs.length;
  c.waitFor = (pred, ms = 3000, from = 0) => new Promise((resolve, reject) => {
    const fin = Date.now() + ms;
    const voir = () => {
      const m = c.msgs.slice(from).find(pred);
      if (m) return resolve(m);
      if (Date.now() > fin) return reject(new Error(`${nom} : condition non atteinte en ${ms} ms`));
      setTimeout(voir, 10);
    };
    voir();
  });
  c.until = (pred, ms, from) => c.waitFor((m) => m.type === 'session' && pred(m.session), ms, from).then((m) => m.session);
  c.last = () => { const m = [...c.msgs].reverse().find((x) => x.session); return m && m.session; };
  c.stats = async () => { const m = c.mark(); c.send({ action: 'stats' }); return c.waitFor((x) => x.type === 'stats', 3000, m); };
  // Le profil public d'une cible — la requête est construite à la main : c'est
  // exactement ce qu'un client forgé peut envoyer.
  c.profil = async (playerId, extra = {}) => { const m = c.mark(); c.send({ action: 'public-profile', playerId, ...extra }); return c.waitFor((x) => x.type === 'public-profile' || x.type === 'error', 3000, m); };
  c.fermer = () => new Promise((res) => { if (ws.readyState === ws.CLOSED) return res(); ws.once('close', res); ws.close(); });
  return c;
}
const cle = (l) => (l + 'p').repeat(20);
async function entre(nom, id, code, key, port, name = nom) {
  const c = client(nom, port); await c.open;
  const player = Object.assign({ id, name, avatar: { kind: 'emoji', emoji: '🦊' } }, key ? { key } : {});
  c.send(code ? { action: 'join', code, player } : { action: 'create', player });
  c.accueil = await c.waitFor((m) => m.type === 'joined' || m.type === 'created' || m.type === 'error');
  await sleep(60);
  return c;
}
async function partie(hote, autres, gameId, rangs) {
  await hote.until((s) => s.pool && s.pool.catalog === 'ready', 4000);
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
  const results = [hote, ...autres].map((c) => ({ gamePlayerId: 'g-' + c.nom, rank: rangs[c.nom], points: 0 }));
  m = hote.mark(); hote.send({ action: 'results', drawId: d.id, gameId, results });
  await hote.until((s) => s.history.games.some((g) => g.drawId === d.id), 3000, m);
  m = hote.mark(); hote.send({ action: 'ended', drawId: d.id }); await hote.until((s) => s.state === 'debrief', 3000, m);
  await sleep(80);
  return d.id;
}
// Ce qu'un profil public NE DOIT JAMAIS contenir.
const INTERDIT = /"key"|keyHash|key_hash|drawId|draw_id|notified|"points"|sessionCode|session_code/;
// Ce que dit le profil privé, ramené à ce que dit le profil public.
const commePublic = (s) => ({ ...s, achievements: s.achievements.map((a) => (a.unlocked ? { code: a.code, unlocked: true, at: a.at } : a)) });

async function protocole() {
  console.log('Profils publics — vraies connexions\n');
  const ana = await entre('Ana', 'p_ana', null, cle('a'));
  const S1 = ana.last().code;
  const bob = await entre('Bob', 'p_bob', S1, cle('b'));
  const cam = await entre('Cam', 'p_cam', S1);                      // ancien client : AUCUNE clé
  const dan = await entre('Dan', 'p_dan', null, cle('d'));           // une AUTRE soirée
  const S2 = dan.last().code;
  t('created / joined annoncent profiles: true (Hub avec stockage)', ana.accueil.profiles === true && bob.accueil.profiles === true && dan.accueil.profiles === true);

  await partie(ana, [bob, cam], 'passeur', { Ana: 1, Bob: 2, Cam: 3 });
  await partie(ana, [bob, cam], 'ban', { Ana: 2, Bob: 1, Cam: 3 });
  await partie(dan, [], 'precision', { Dan: 1 });
  const msgsBobAvant = bob.mark();

  // A. Soi-même.
  const pa = await ana.profil('p_ana');
  const sa = (await ana.stats()).stats;
  t('A. Ana → son propre profil public : autorisé', pa.type === 'public-profile' && pa.reason === null && pa.profile && pa.profile.name === 'Ana', JSON.stringify(pa).slice(0, 160));
  t('A. … et ses chiffres = ceux de SON profil privé (sans drawId)', same(pa.profile.stats, commePublic(sa)), JSON.stringify(pa.profile.stats).slice(0, 200));

  // B. Un joueur de la même session.
  const pb = await ana.profil('p_bob');
  const sb = (await bob.stats()).stats;
  t('B. Ana → Bob (même session) : autorisé, identité du Hub, présent', pb.reason === null && pb.playerId === 'p_bob' && pb.profile.name === 'Bob' && pb.profile.present === true
    && same(pb.profile.avatar, { kind: 'emoji', emoji: '🦊' }), JSON.stringify(pb).slice(0, 160));
  t('B. … statistiques, par jeu, records et succès de Bob = son profil privé', same(pb.profile.stats, commePublic(sb)) && pb.profile.stats.played === 2 && pb.profile.stats.wins === 1
    && pb.profile.stats.games.length === 2 && !!pb.profile.stats.records && pb.profile.stats.achievements.length === 10);
  t('B. … les champs exacts, rien de plus', same(Object.keys(pb).sort(), ['playerId', 'profile', 'reason', 'type']) && same(Object.keys(pb.profile).sort(), ['avatar', 'name', 'present', 'stats'])
    && same(Object.keys(pb.profile.stats).sort(), ['achievements', 'best', 'games', 'played', 'podiums', 'records', 'solo', 'wins']));

  // C. Un joueur d'une autre session.
  const pc = await ana.profil('p_dan');
  t('C. Ana → Dan (AUTRE session) : NOT_FOUND, rien', pc.reason === 'NOT_FOUND' && pc.profile === null);
  // D. Ids forgés / malformés.
  const forges = [];
  for (const x of ['p_inexistant', '', 'P_ANA', 'p_ana ', 42, null, { id: 'p_bob' }, ['p_bob'], 'x'.repeat(65), '__proto__', 'constructor']) forges.push(await ana.profil(x));
  t('D. ids forgés / malformés / pièges (__proto__, constructor) : NOT_FOUND, jamais un profil', forges.every((r) => r.type === 'public-profile' && r.reason === 'NOT_FOUND' && r.profile === null),
    JSON.stringify(forges.map((r) => r.reason)));
  // E. Viser une autre session en ajoutant un code : le message n'en tient pas compte.
  const pe = await ana.profil('p_dan', { code: S2, session: S2, sessionCode: S2 });
  t('E. Ana ajoute le code de l\'autre soirée à sa requête : toujours NOT_FOUND (seul le socket compte)', pe.reason === 'NOT_FOUND' && pe.profile === null);
  t('E. … même réponse pour « autre soirée » et « id inventé » (pas d\'oracle)', same({ ...pe, playerId: null }, { ...forges[0], playerId: null }));

  // Usurpation : Mallory entre dans S1 avec l'id de Dan, sans clé puis avec une fausse.
  const mal = await entre('Mallory', 'p_dan', S1, undefined, PORT, 'Dan');
  const pm = await ana.profil('p_dan');
  t('usurpation : l\'id de Dan présent dans S1 SANS sa clé → UNVERIFIED, identité de session seulement, aucune stat', pm.reason === 'UNVERIFIED' && pm.profile.stats === null && pm.profile.name === 'Dan');
  await mal.fermer();
  mal.send = () => {};
  const mal2 = await entre('Mallory', 'p_dan', S1, cle('z'), PORT, 'Dan');
  const pm2 = await ana.profil('p_dan');
  t('usurpation avec une FAUSSE clé : UNVERIFIED, aucune stat de Dan', pm2.reason === 'UNVERIFIED' && pm2.profile.stats === null);
  const statsDeMallory = await mal2.profil('p_dan');
  t('… et Mallory elle-même ne lit pas « son » profil (les stats de Dan)', statsDeMallory.profile.stats === null && statsDeMallory.reason === 'UNVERIFIED');
  mal2.send({ action: 'leave' });
  await ana.until((s) => !s.players.some((p) => p.id === 'p_dan'), 2000);

  // Joueur sans clé (ancien client) : son identité, pas de stats ; et lui peut consulter.
  const pcam = await ana.profil('p_cam');
  t('joueur sans clé (Cam) : UNVERIFIED, identité seulement', pcam.reason === 'UNVERIFIED' && pcam.profile.name === 'Cam' && pcam.profile.stats === null);
  const parCam = await cam.profil('p_ana');
  t('un client SANS clé peut consulter un joueur vérifié de sa soirée (il en fait partie)', parCam.reason === null && parCam.profile.stats.played === 2);

  // F/G. Aucune fuite.
  const reponses = tous.flatMap((c) => c.msgs.filter((x) => x.type === 'public-profile'));
  t('G. aucune réponse ne contient de clé, d\'empreinte, de drawId, de notified_at, de points, de code de session', reponses.every((r) => !INTERDIT.test(JSON.stringify(r))),
    JSON.stringify(reponses.find((r) => INTERDIT.test(JSON.stringify(r))) || '').slice(0, 200));
  t('G. aucune clé (la vraie chaîne) nulle part chez Ana', !JSON.stringify(ana.msgs).includes(cle('b')) && !JSON.stringify(ana.msgs).includes(ST.hashKey(cle('b'))));
  t('F. lire le profil de Bob ne lui envoie rien et ne débloque rien pour lui', bob.msgs.slice(msgsBobAvant).filter((x) => x.type !== 'session').length <= 1
    && !bob.msgs.slice(msgsBobAvant).some((x) => x.type === 'achievement'));

  // Hors session.
  const eve = client('Eve'); await eve.open;
  const pev = await eve.profil('p_ana');
  t('hors session : NOT_IN_SESSION (erreur), aucun profil', pev.type === 'error' && pev.code === 'NOT_IN_SESSION');

  // Une demande à la fois.
  const m0 = ana.mark();
  ana.send({ action: 'public-profile', playerId: 'p_bob' });
  ana.send({ action: 'public-profile', playerId: 'p_bob' });
  await ana.waitFor(() => ana.msgs.slice(m0).filter((x) => x.type === 'public-profile').length >= 2, 3000).catch(() => null);
  const deux = ana.msgs.slice(m0).filter((x) => x.type === 'public-profile');
  t('deux demandes simultanées : une réponse chacune (la seconde BUSY ou servie), le Hub tient', deux.length === 2 && deux.some((r) => r.reason === null)
    && deux.every((r) => r.reason === null || r.reason === 'BUSY'), JSON.stringify(deux.map((r) => r.reason)));

  // Pseudo changé côté Hub (reprise sous un autre nom) : le profil suit le Hub.
  await bob.fermer();
  const bob2 = await entre('Bob', 'p_bob', S1, cle('b'), PORT, 'Bobby');
  const pr = await ana.profil('p_bob');
  t('identité = celle que le HUB connaît (Bob revenu en « Bobby ») ; mêmes stats', pr.profile.name === 'Bobby' && same(pr.profile.stats, pb.profile.stats));

  // 9. Joueur parti.
  bob2.send({ action: 'leave' });
  await ana.until((s) => !s.players.some((p) => p.id === 'p_bob'), 2000);
  const pp = await ana.profil('p_bob');
  t('joueur PARTI : toujours consultable dans cette soirée, present: false, mêmes stats', pp.reason === null && pp.profile.present === false && pp.profile.name === 'Bobby'
    && same(pp.profile.stats, pb.profile.stats), JSON.stringify(pp).slice(0, 160));
  const ppDan = await dan.profil('p_bob');
  t('… mais pas depuis une autre soirée', ppDan.reason === 'NOT_FOUND');

  // Nouveau joueur, vérifié, sans partie.
  const neo = await entre('Neo', 'p_neo', S1, cle('n'));
  const pn = await ana.profil('p_neo');
  t('nouveau joueur vérifié sans partie : profil vide (0 partie, aucun record, 10 succès verrouillés)', pn.reason === null && pn.profile.stats.played === 0
    && pn.profile.stats.records === null && pn.profile.stats.achievements.every((a) => !a.unlocked));

  // Base en panne : l'identité, pas de faux zéro.
  panne = true;
  const pd = await ana.profil('p_ana');
  panne = false;
  t('base en panne : UNAVAILABLE, identité, stats null (jamais un faux zéro)', pd.reason === 'UNAVAILABLE' && pd.profile.name === 'Ana' && pd.profile.stats === null);

  // Hub sans stockage : n'annonce pas la fonction, et répond UNAVAILABLE.
  const z = await entre('Zoé', 'p_zoe', null, cle('z'), PORT + 1);
  const pz = await z.profil('p_zoe');
  t('Hub sans stockage : profiles: false, UNAVAILABLE (identité seule)', z.accueil.profiles === false && pz.reason === 'UNAVAILABLE' && pz.profile.stats === null);

  // H. Un client ancien : rien ne change pour lui (ne demande rien, la soirée marche).
  t('H. client ancien (Cam) : il a joué ses 2 parties, sans jamais rien demander de nouveau', ana.last().history.games.length === 2 && cam.msgs.some((x) => x.type === 'session'));
  for (const c of [neo, eve, dan, cam]) c.send({ action: 'leave' });
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  await new Promise((r) => serverSans.listen(PORT + 1, r));
  try { await protocole(); } catch (e) { t('EXCEPTION', false, e.stack); }
  for (const c of tous) await c.fermer().catch(() => {});
  hub.stop(); hubSans.stop();
  server.close(); serverSans.close();
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
})();
