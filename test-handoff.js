// Lancement (handoff) sur de VRAIES connexions WebSocket, contre le Hub seul.
//
//   node test-handoff.js
//
// Le serveur du jeu n'est PAS là : c'est voulu. Le Hub ne lui parle jamais —
// il ne fait que croire l'hôte sur le code de room et enregistrer qui déclare
// être entré. Ce fichier vérifie donc toutes les règles du Hub avec des codes
// fabriqués. La partie réelle (vraie room du Passeur, trois joueurs dedans,
// une manche jouée) est vérifiée côté portfolio, par tests/handoff.mjs et
// tests/handoff-play.mjs.
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

const PORT = +(process.env.PORT || 8795);
const HPORT = PORT + 1;
const CREATE = 700, JOIN = 900, GRACE = 1500;

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sante = {};
const santeSrv = createServer((req, res) => {
  const id = req.url.replace(/^\//, '');
  const c = sante[id] || 200;
  res.writeHead(c); res.end('x');
});
const on = (id, min, max, mmax, extra = {}) => Object.assign({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online',
  players: { min, max }, minutes: { min: 1, max: mmax }, needs: [], categories: ['reflexe'],
  server: `wss://${id}.example`, health: `http://127.0.0.1:${HPORT}/${id}`, join: 'v1', content: false, replay: false, handoff: false }, extra);
const FICHIER = path.join(os.tmpdir(), `hub-handoff-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: [
  on('passeur', 1, 8, 8, { handoff: true }), on('demicercle', 2, 10, 15), on('precision', 1, 12, 10),
] }));

let hub = null;
const catalog = createCatalog({ file: FICHIER });
const health = createHealth({ timeoutMs: 500, upTtlMs: 200, downTtlMs: 500, onChange: () => hub && hub.broadcastAll() });
hub = createHub({ graceMs: GRACE, heartbeatMs: 0, catalog, health, launchCreateMs: CREATE, launchJoinMs: JOIN });
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
const role = (s, you) => (s.launch && s.launch.hostId === you ? 'host' : 'guest');

// Une session à trois où seul Le Passeur est possible, tirée et confirmée.
async function trio(tag) {
  const a = await entre('A', `p_a${tag}`);
  const code = a.last().code;
  const b = await entre('B', `p_b${tag}`, code);
  const c = await entre('C', `p_c${tag}`, code);
  await a.until((s) => s.pool && s.pool.catalog === 'ready' && s.players.length === 3, 4000);
  let m = a.mark();
  b.send({ action: 'prefs', love: [], veto: ['demicercle', 'precision'] });
  await a.until((s) => s.pool.eligible.length === 1, 3000, m);
  return { a, b, c, code };
}
async function tireEtConfirme(a) {
  let m = a.mark();
  a.send({ action: 'draw' });
  const d = await a.until((s) => s.draw && s.draw.status === 'drawn', 4000, m);
  m = a.mark();
  a.send({ action: 'continue' });
  const s = await a.until((x) => x.state !== 'drawing', 3000, m);
  return { draw: d.draw, s };
}

async function main() {
  console.log('Lancement (handoff) — vraies connexions, Hub seul\n');

  // ── tirage → lancement, rôles
  const { a, b, c, code } = await trio('1');
  const { draw, s: s1 } = await tireEtConfirme(a);
  t('tirage : Le Passeur (seul jeu possible)', draw.gameId === 'passeur');
  t('continuer → launching, stage « create », aucun code encore', s1.state === 'launching' && s1.launch.stage === 'create' && s1.launch.roomCode === null);
  t('le lancement est lié au tirage (drawId) et porte l\'URL du manifest', s1.launch.drawId === draw.id && s1.launch.url === 'games/passeur/');
  const sb = await b.until((x) => x.state === 'launching');
  t('rôles : A = host, B et C = guest (dérivés de launch.hostId)', role(s1, 'p_a1') === 'host' && role(sb, 'p_b1') === 'guest' && role(c.last(), 'p_c1') === 'guest');
  t('waiting : tout le groupe est attendu', JSON.stringify(s1.launch.waiting) === '["p_a1","p_b1","p_c1"]');

  // ── entered avant le code
  let m = b.mark();
  b.send({ action: 'entered', drawId: draw.id, roomCode: 'KQMP' });
  t('entered avant que l\'hôte ait créé la room : refusé', !!(await b.error('NOT_LAUNCHING', 2000, m)));

  // ── D. un invité se fait passer pour l'hôte
  m = b.mark();
  b.send({ action: 'launched', drawId: draw.id, roomCode: 'ZZZZ', playerId: 'p_a1', role: 'host' });
  t('D. guest qui déclare un code : refusé (NOT_HOST), quels que soient ses champs', !!(await b.error('NOT_HOST', 2000, m)));
  t('D. … et le lancement n\'a pas bougé', a.last().launch.roomCode === null);

  // ── l'hôte NAVIGUE vers le jeu : son socket du Hub se ferme, la page du jeu le rouvre
  a.ws.close();
  await b.until((x) => x.players.find((p) => p.id === 'p_a1').connected === false, 3000);
  t('navigation : A absent, mais TOUJOURS hôte du lancement', b.last().hostId === 'p_a1' && b.last().state === 'launching');
  const a2 = await entre('A', 'p_a1', code);                   // la page du jeu de A, même player.id
  t('navigation : la page du jeu reprend la place de A (même id, pas de doublon)', a2.last().players.length === 3 && a2.last().hostId === 'p_a1');

  // ── E. codes mal formés / mauvais tirage
  m = a2.mark();
  a2.send({ action: 'launched', drawId: draw.id, roomCode: 'AB' });
  t('E. code mal formé : BAD_ROOM_CODE', !!(await a2.error('BAD_ROOM_CODE', 2000, m)));
  a2.send({ action: 'launched', drawId: 'd_autre', roomCode: 'KQMP' });
  t('lancement lié au draw courant : autre drawId → LAUNCH_MISMATCH', !!(await a2.error('LAUNCH_MISMATCH', 2000, m)));

  // ── G. deux « launched » simultanés : un seul valide
  m = a2.mark();
  a2.send({ action: 'launched', drawId: draw.id, roomCode: 'KQMP' });
  a2.send({ action: 'launched', drawId: draw.id, roomCode: 'WXYZ' });
  const e2 = await a2.error('LAUNCH_CONSUMED', 2000, m);
  const go = await b.until((x) => x.launch && x.launch.stage === 'join', 2000);
  t('G. deux launched simultanés : le second refusé (LAUNCH_CONSUMED)', !!e2);
  t('G. … le premier code tient', go.launch.roomCode === 'KQMP');
  t('go : B et C voient le code, et que l\'hôte est déjà dedans', go.launch.roomCode === 'KQMP' && JSON.stringify(go.launch.entered) === '["p_a1"]'
    && (await c.until((x) => x.launch && x.launch.roomCode === 'KQMP', 2000)));
  t('waiting : B et C encore attendus', JSON.stringify(go.launch.waiting) === '["p_b1","p_c1"]');

  // ── entered
  m = b.mark();
  b.send({ action: 'entered', drawId: draw.id, roomCode: 'ZZZZ' });
  t('E. entrer dans une AUTRE room : WRONG_ROOM', !!(await b.error('WRONG_ROOM', 2000, m)));
  b.ws.close();                                                 // B navigue à son tour
  const b2 = await entre('B', 'p_b1', code);
  b2.send({ action: 'entered', drawId: draw.id, roomCode: 'kqmp' });
  const sb2 = await b2.until((x) => x.launch.entered.includes('p_b1'), 2000);
  t('entered : B est dans la room, seul C est attendu', JSON.stringify(sb2.launch.waiting) === '["p_c1"]' && sb2.state === 'launching');
  c.ws.close();
  const c2 = await entre('C', 'p_c1', code);
  m = c2.mark();
  c2.send({ action: 'entered', drawId: draw.id, roomCode: 'KQMP' });
  const jeu = await c2.until((x) => x.state === 'inGame', 2000, m);
  t('tout le monde est entré → inGame, stage playing, personne de manqué', jeu.launch.stage === 'playing' && jeu.launch.missed.length === 0);

  // ── session cohérente après déconnexion
  b2.ws.terminate();
  await a2.until((x) => x.players.find((p) => p.id === 'p_b1').connected === false, 2000);
  t('déconnexion pendant la partie : B absent, la partie continue (inGame)', a2.last().state === 'inGame' && a2.last().launch.entered.includes('p_b1'));
  const b3 = await entre('B', 'p_b1', code);
  t('B revient : même id, aucun doublon, rien de relancé', b3.last().players.length === 3 && b3.last().state === 'inGame' && b3.last().launch.roomCode === 'KQMP');

  // ── ended → debrief → nouveau tirage possible
  m = b3.mark();
  b3.send({ action: 'ended', drawId: draw.id });
  t('ended : réservé à l\'hôte', !!(await b3.error('NOT_HOST', 2000, m)));
  m = a2.mark();
  a2.send({ action: 'ended', drawId: draw.id });
  const deb = await a2.until((x) => x.state === 'debrief', 2000, m);
  t('ended : retour au Hub (debrief), l\'historique garde la partie', deb.launch.stage === 'ended' && deb.history.played[0] === 'passeur');

  // ── B. l'hôte ne crée jamais la room → échéance
  let r = await tireEtConfirme(a2);
  t('nouveau tirage après une partie : même session', r.s.state === 'launching' && r.s.code === code);
  const t0 = Date.now();
  const echec = await b3.until((x) => x.launch && x.launch.stage === 'failed', CREATE + 1500);
  t(`B. l'hôte ne crée pas la room : échec au bout de ${Date.now() - t0} ms (échéance ${CREATE} ms)`, echec.launch.reason === 'LAUNCH_TIMEOUT' && echec.state === 'lobby');
  // ── F. launch expiré → refus
  m = a2.mark();
  a2.send({ action: 'launched', drawId: r.draw.id, roomCode: 'KQMP' });
  t('F. launched après expiration : refusé', !!(await a2.error('NOT_LAUNCHING', 2000, m)));
  t('F. … la session n\'est pas bloquée : on peut retirer', (await tireEtConfirme(a2)).s.state === 'launching');

  // ── C. l'hôte crée la room mais les invités n'entrent jamais → on lance avec ceux qui sont là
  let l = a2.last().launch;
  a2.send({ action: 'launched', drawId: l.drawId, roomCode: 'MNPQ' });
  const fin = await b3.until((x) => x.state === 'inGame' && x.launch.drawId === l.drawId, JOIN + 1500);
  t('C. les invités n\'entrent pas : à l\'échéance, partie lancée et absents « manqués »',
    JSON.stringify(fin.launch.missed.sort()) === '["p_b1","p_c1"]', JSON.stringify(fin.launch));
  a2.send({ action: 'ended', drawId: l.drawId });
  await a2.until((x) => x.state === 'debrief', 2000);

  // ── started : l'hôte démarre sans attendre
  r = await tireEtConfirme(a2);
  a2.send({ action: 'launched', drawId: r.draw.id, roomCode: 'RSTU' });
  await b3.until((x) => x.launch && x.launch.stage === 'join', 2000);
  m = b3.mark();
  b3.send({ action: 'started', drawId: r.draw.id });
  t('started : réservé à l\'hôte', !!(await b3.error('NOT_HOST', 2000, m)));
  a2.send({ action: 'started', drawId: r.draw.id });
  const st = await b3.until((x) => x.state === 'inGame' && x.launch.drawId === r.draw.id, 2000);
  t('started : partie lancée, B et C manqués (nommés)', st.launch.stage === 'playing' && st.launch.missed.length === 2);
  a2.send({ action: 'ended', drawId: r.draw.id });
  await a2.until((x) => x.state === 'debrief', 2000);

  // ── un invité ne peut pas entrer (room introuvable) : échec pour LUI seul
  r = await tireEtConfirme(a2);
  a2.send({ action: 'launched', drawId: r.draw.id, roomCode: 'HJKM' });
  await b3.until((x) => x.launch && x.launch.stage === 'join', 2000);
  b3.send({ action: 'abort', drawId: r.draw.id, reason: 'CREATE_FAILED', detail: 'aucune partie avec ce code' });
  const gf = await a2.until((x) => x.launch && x.launch.failed.p_b1, 2000);
  t('abort d\'un invité : échec pour lui seul, avec la raison ; le lancement continue',
    gf.launch.stage === 'join' && /aucune partie/.test(gf.launch.failed.p_b1) && JSON.stringify(gf.launch.waiting) === '["p_c1"]');
  a2.send({ action: 'ended', drawId: r.draw.id });
  await a2.until((x) => x.state === 'debrief', 2000);

  // ── l'hôte annule le lancement (il a changé d'avis)
  r = await tireEtConfirme(a2);
  m = b3.mark();
  b3.send({ action: 'abort', drawId: r.draw.id, reason: 'CANCELLED' });
  t('annuler : un invité ne peut pas annuler le lancement du groupe', !!(await b3.error('NOT_HOST', 2000, m)));
  a2.send({ action: 'abort', drawId: r.draw.id, reason: 'CANCELLED' });
  const an = await b3.until((x) => x.launch && x.launch.drawId === r.draw.id && x.launch.stage === 'failed', 2000, m);
  t('annuler : l\'hôte annule → retour au salon (CANCELLED), sans attendre l\'échéance', an.launch.reason === 'CANCELLED' && an.state === 'lobby');

  // ── A. serveur du jeu injoignable depuis le navigateur de l'hôte
  r = await tireEtConfirme(a2);
  m = b3.mark();
  a2.send({ action: 'abort', drawId: r.draw.id, reason: 'UNREACHABLE' });
  const inj = await b3.until((x) => x.launch && x.launch.stage === 'failed', 2000, m);
  t('A. serveur injoignable : retour au salon, raison UNREACHABLE', inj.state === 'lobby' && inj.launch.reason === 'UNREACHABLE');
  // ⚠️ Le jeu reste PROPOSÉ : la santé ne filtre plus le catalogue. Ce que le
  // Hub retient, c'est que son serveur est down — le candidat sera recalé au
  // tirage suivant, sans réveiller les six autres au passage.
  const pool = b3.last();
  t('A. … le jeu reste proposé dans le salon (la santé ne filtre pas)',
    pool.pool.eligible.includes('passeur') && !(pool.pool.why.passeur || []).some((w) => w.code === 'SERVER_DOWN'));
  t('A. … mais le Hub le retient « down »', pool.pool.health.passeur === 'down', pool.pool.health.passeur);
  m = a2.mark();
  a2.send({ action: 'draw' });
  t('A. … et le tirage suivant le recale : NO_SERVER_AVAILABLE, pas NO_ELIGIBLE_GAME',
    !!(await a2.error('NO_SERVER_AVAILABLE', 3000, m)));

  // ── serveur vu down AVANT le lancement : échec immédiat
  await sleep(600);                                    // le « down » du cas A est périmé (500 ms)
  const s2 = await trio('2');
  // Le tirage recale déjà un candidat dont le serveur ne répond pas
  // (test-draw.js, test-candidat.js) : on vérifie ici le cas d'un serveur qui
  // tombe ENTRE le tirage et « continuer ».
  m = s2.a.mark();
  s2.a.send({ action: 'draw' });
  const d2 = await s2.a.until((x) => x.draw && x.draw.status === 'drawn', 4000, m);
  health.markDown('passeur');
  m = s2.a.mark();
  s2.a.send({ action: 'continue' });
  const imm = await s2.a.until((x) => x.launch && x.launch.drawId === d2.draw.id && x.launch.stage === 'failed', 2000, m);
  t('serveur tombé entre tirage et lancement : échec immédiat, SERVER_DOWN', imm.launch.reason === 'SERVER_DOWN' && imm.state === 'lobby');

  // ── H. l'hôte quitte pendant le lancement (avant d'avoir créé la room)
  await sleep(600);                                    // le « down » précédent est périmé
  const s3 = await trio('3');
  await tireEtConfirme(s3.a);
  m = s3.b.mark();
  s3.a.send({ action: 'leave' });
  const hl = await s3.b.until((x) => x.launch && x.launch.stage === 'failed', 2000, m);
  t('H. l\'hôte quitte avant de créer la room : échec HOST_LEFT, retour au salon', hl.launch.reason === 'HOST_LEFT' && hl.state === 'lobby');
  t('H. … nouvel hôte (B), qui peut retirer', hl.hostId === 'p_b3');

  // ── session d'UN joueur : naviguer ne ferme pas la session
  const solo = await entre('Solo', 'p_solo');
  const codeSolo = solo.last().code;
  await solo.until((x) => x.pool && x.pool.catalog === 'ready', 3000);
  solo.send({ action: 'prefs', love: [], veto: ['precision'] });
  await solo.until((x) => x.pool.eligible.length === 1 && x.pool.eligible[0] === 'passeur', 3000).catch(() => null);
  const soloPret = solo.last().pool.eligible.includes('passeur');
  if (soloPret) {
    const rs = await tireEtConfirme(solo);
    solo.ws.close();
    await sleep(150);
    t('solo : l\'hôte seul navigue vers le jeu → la session n\'est PAS fermée', hub.sessions.has(codeSolo) && hub.sessions.get(codeSolo).state === 'launching');
    const solo2 = await entre('Solo', 'p_solo', codeSolo);
    solo2.send({ action: 'launched', drawId: rs.draw.id, roomCode: 'BCDF' });
    const sl = await solo2.until((x) => x.state === 'inGame', 2000);
    t('solo : la page du jeu déclare sa room → inGame (seul attendu, seul entré)', sl.launch.entered.length === 1);
    solo2.ws.terminate();
  } else {
    t('solo : Le Passeur n\'est pas éligible ici (santé) — vérification sautée', false, JSON.stringify(solo.last().pool.why.passeur));
  }

  // ── jeu SANS handoff : on revient au Hub, comme avant
  const s4 = await trio('4');
  m = s4.b.mark();
  s4.b.send({ action: 'prefs', love: [], veto: ['passeur', 'precision'] });
  await s4.a.until((x) => JSON.stringify(x.pool.eligible) === '["demicercle"]', 3000);
  const r4 = await tireEtConfirme(s4.a);
  t('jeu sans handoff (manifest) : continuer → debrief, aucun lancement', r4.draw.gameId === 'demicercle' && r4.s.state === 'debrief' && r4.s.launch === null);

  for (const k of [a, b, c, a2, b2, c2, b3, s2.a, s2.b, s2.c, s3.b, s3.c, solo, s4.a, s4.b, s4.c]) { try { k.ws.terminate(); } catch (_) {} }
}

santeSrv.listen(HPORT, () => server.listen(PORT, async () => {
  try { await main(); }
  catch (e) { ko++; console.log('KO   EXCEPTION — ' + (e.stack || e.message)); }
  console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
  hub.stop(); wss.close(); server.close(); santeSrv.close();
  try { fs.unlinkSync(FICHIER); } catch (_) {}
  process.exit(ko ? 1 : 0);
}));
