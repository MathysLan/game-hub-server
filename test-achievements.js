// Succès de joueur (lot J) : les définitions (achievements.js, rejeu pur), le
// stockage (store-memory.js, et store-pg.js si une base de test est donnée,
// rattrapage silencieux compris), puis le protocole sur de VRAIES connexions
// WebSocket : premier déblocage, livraison au retour, accusé, rien pour les
// autres, rien depuis un client.
//
//   node test-achievements.js
//   TEST_DATABASE_URL=postgres://… node test-achievements.js   + le SQL
//
// ⚠️ La base de TEST est vidée (ses tables hub_*) : jamais celle de production.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const AC = require('./src/achievements.js');
const { createMemoryStore } = require('./src/store-memory.js');
const { createHub } = require('./src/hub.js');
const { createCatalog } = require('./src/catalog.js');
const { createHealth } = require('./src/health.js');

const PORT = +(process.env.PORT || 8817);
let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════ définitions
console.log('Succès — définitions (achievements.js)\n');
const H = 3600e3;
const T0 = Date.parse('2026-10-03T18:00:00Z');                   // un samedi soir, 20 h à Paris
let n = 0;
// Une partie : jeu, rang, classés, derrière, soirée, instant.
const P = (gameId, rank, ranked, behind, o = {}) => ({ drawId: 'd_' + String(++n).padStart(4, '0'), sessionCode: o.s || 'SOIR1',
  gameId, rank, ranked, behind, at: o.at != null ? o.at : T0 + n * 60e3 });
const W = (g = 'passeur', o) => P(g, 1, 3, 2, o);                  // victoire
const L = (g = 'passeur', o) => P(g, 2, 3, 1, o);                  // défaite (2e)
const SOLO = (g = 'precision', o) => P(g, 1, 1, 0, o);
const NUL = (o) => P('morpion', 1, 2, 0, o);
const codes = (plays) => AC.unlocks(plays).map((u) => u.code);
const a = (plays, code) => codes(plays).includes(code);
const quand = (plays, code) => (AC.unlocks(plays).find((u) => u.code === code) || {}).drawId;

t('catalogue : 10 codes, dans l\'ordre', same(AC.CODES, ['first-win', 'explorer', 'stalemate', 'shared-throne', 'versatile', 'marathon', 'night-owl', 'hat-trick', 'crowd-king', 'grand-slam']));
t('aucune partie : aucun succès', same(AC.unlocks([]), []) && same(AC.unlocks(null), []));
{
  const solo = ['precision', 'passeur', 'morpion', 'ban', 'quiment', 'imitation'].map((g) => SOLO(g));
  t('que du solo (6 jeux) : Touche-à-tout SEULEMENT — ni victoire, ni nuit, ni série', same(codes(solo), ['explorer']), codes(solo).join());
  const nuit = [SOLO('precision', { at: Date.parse('2026-10-03T23:30:00Z') })];
  t('solo de nuit : pas d\'Oiseau de nuit', !a(nuit, 'night-owl'));
}
{
  t('Première victoire : 1er devant quelqu\'un', a([W()], 'first-win'));
  t('Première victoire : pas pour un 2e, ni un nul du Morpion, ni un solo', !a([L(), NUL(), SOLO()], 'first-win'));
  const ex = [P('passeur', 1, 3, 1)];
  t('Première victoire : 1er ex æquo devant quelqu\'un, oui', a(ex, 'first-win'));
}
{
  const quatre = ['passeur', 'precision', 'ban', 'morpion'].map((g) => L(g));
  t('Touche-à-tout : 4 jeux non, 5 oui (solo compris)', !a(quatre, 'explorer') && a([...quatre, SOLO('quiment')], 'explorer'));
  const p = [...quatre, L('passeur'), L('ban'), SOLO('imitation')];
  t('Touche-à-tout : débloqué par la partie du 5e jeu, pas avant', quand(p, 'explorer') === p[6].drawId);
}
{
  t('Pat : 2 nuls non, 3 oui', !a([NUL(), NUL()], 'stalemate') && a([NUL(), NUL(), NUL()], 'stalemate'));
  t('Pat : une victoire au Morpion ou un « nul » d\'un autre jeu ne comptent pas',
    !a([NUL(), NUL(), P('morpion', 1, 2, 1), P('passeur', 1, 2, 0)], 'stalemate'));
}
{
  t('Partage du trône : 1, 1, 3 oui', a([P('ban', 1, 3, 1)], 'shared-throne'));
  t('Partage du trône : 1, 1, 2, 4 (4 classés, 2 derrière) oui', a([P('ban', 1, 4, 2)], 'shared-throne'));
  t('Partage du trône : nul du Morpion (personne derrière) non ; 1, 1, 1 non ; seul 1er non',
    !a([NUL(), P('ban', 1, 3, 0), W()], 'shared-throne'));
}
{
  t('Polyvalent : 3 victoires au même jeu non', !a([W('ban'), W('ban'), W('ban')], 'versatile'));
  t('Polyvalent : victoires dans 3 jeux oui', a([W('ban'), W('passeur'), L('morpion'), W('quiment')], 'versatile'));
}
{
  const dix = (o = {}) => Array.from({ length: 10 }, (_, i) => L('passeur', { s: o.s, at: o.at ? o.at(i) : undefined }));
  t('Marathon : 10 parties compétitives d\'une soirée oui, 9 non', a(dix(), 'marathon') && !a(dix().slice(0, 9), 'marathon'));
  t('Marathon : le solo ne compte pas (9 + 1 solo non)', !a([...dix().slice(0, 9), SOLO()], 'marathon'));
  t('Marathon : 5 + 5 dans deux sessions non', !a([...dix({ s: 'AAAAA' }).slice(0, 5), ...dix({ s: 'BBBBB' }).slice(0, 5)], 'marathon'));
  t('Marathon : même code, 11 h entre deux parties oui ; 13 h (autre soirée au même code) non',
    a(dix({ at: (i) => T0 + i * 11 * H }), 'marathon') && !a(dix({ at: (i) => T0 + i * 60e3 + (i >= 5 ? 13 * H : 0) }), 'marathon'));
}
{
  const nuit = (iso) => a([L('passeur', { at: Date.parse(iso) })], 'night-owl');
  t('Oiseau de nuit, hiver (UTC+1) : 00:00:00 oui, 23:59:59 non, 04:59:59 oui, 05:00:00 non',
    nuit('2026-01-15T23:00:00Z') && !nuit('2026-01-15T22:59:59Z') && nuit('2026-01-16T03:59:59Z') && !nuit('2026-01-16T04:00:00Z'));
  t('Oiseau de nuit, été (UTC+2) : 00:00:00 oui, 04:59:59 oui, 05:00:00 non, 23:59:59 non',
    nuit('2026-07-15T22:00:00Z') && nuit('2026-07-16T02:59:59Z') && !nuit('2026-07-16T03:00:00Z') && !nuit('2026-07-15T21:59:59Z'));
  t('Oiseau de nuit, changements d\'heure (29 mars, 25 oct.) : 04:59:59 oui, 05:00:00 non',
    nuit('2026-03-29T00:30:00Z') && nuit('2026-03-29T02:59:59Z') && !nuit('2026-03-29T03:00:00Z')
    && nuit('2026-10-25T03:59:59Z') && !nuit('2026-10-25T04:00:00Z'));
  t('heure de Paris : 2026-07-15T22:00Z = 0 h, 2026-01-15T22:00Z = 23 h', AC.parisHour(Date.parse('2026-07-15T22:00:00Z')) === 0 && AC.parisHour(Date.parse('2026-01-15T22:00:00Z')) === 23);
}
{
  t('Hat-trick : V V V oui', a([W(), W(), W()], 'hat-trick'));
  t('Hat-trick : V V D V V non', !a([W(), W(), L(), W(), W()], 'hat-trick'));
  t('Hat-trick : un nul du Morpion CASSE la série (V V nul V V non)', !a([W(), W(), NUL(), W(), W()], 'hat-trick'));
  t('Hat-trick : un solo est IGNORÉ (V solo V V oui)', a([W(), SOLO(), W(), W()], 'hat-trick'));
  t('Hat-trick : 1er ex æquo devant quelqu\'un CONTINUE la série', a([W(), P('ban', 1, 3, 1), W()], 'hat-trick'));
  t('Hat-trick : une nouvelle soirée casse (V V | V non)', !a([W('passeur', { s: 'AAAAA' }), W('passeur', { s: 'AAAAA' }), W('passeur', { s: 'BBBBB' })], 'hat-trick'));
  t('Hat-trick : même code mais 13 h plus tard casse', !a([W('passeur', { at: T0 }), W('passeur', { at: T0 + 60e3 }), W('passeur', { at: T0 + 13 * H })], 'hat-trick'));
}
{
  t('Roi de la foule : victoire à 6 oui, à 5 non', a([P('ban', 1, 6, 5)], 'crowd-king') && !a([P('ban', 1, 5, 4)], 'crowd-king'));
  t('Roi de la foule : 1er ex æquo à 6 (devant 4) oui ; 2e à 8 non', a([P('ban', 1, 6, 4)], 'crowd-king') && !a([P('ban', 2, 8, 6)], 'crowd-king'));
}
{
  const six = ['morpion', 'imitation', 'demicercle', 'ban', 'precision', 'passeur'].map((g) => W(g));
  t('Grand Chelem : 6 jeux sur 7 non', !a(six, 'grand-slam'));
  t('Grand Chelem : les 7 oui', a([...six, W('quiment')], 'grand-slam'));
  t('Grand Chelem : une « victoire » solo ne compte pas', !a([...six, SOLO('quiment')], 'grand-slam'));
  t('Grand Chelem : liste figée (7 jeux en ligne, pas Puissance 4)', same(AC.GRAND_SLAM, ['morpion', 'imitation', 'demicercle', 'ban', 'precision', 'passeur', 'quiment']));
}
{
  // Le rejeu : ordre, moment du déblocage, monotonie.
  const p = [W('passeur'), W('ban'), L('morpion'), W('quiment'), NUL(), NUL(), NUL(), W(), W(), W()];
  const melange = p.slice().reverse();
  t('rejeu : l\'ordre d\'entrée ne compte pas (tri par played_at puis draw_id)', same(AC.unlocks(melange), AC.unlocks(p)));
  const egal = [P('passeur', 1, 3, 2, { at: T0 }), P('passeur', 2, 3, 1, { at: T0 })];
  t('rejeu : même instant → départagé par draw_id (stable)', quand(egal, 'first-win') === egal[0].drawId && quand(egal.slice().reverse(), 'first-win') === egal[0].drawId);
  t('rejeu : chaque succès est daté par la partie qui l\'a débloqué', quand(p, 'first-win') === p[0].drawId && quand(p, 'versatile') === p[3].drawId
    && quand(p, 'stalemate') === p[6].drawId && AC.unlocks(p).find((u) => u.code === 'first-win').at === p[0].at);
  let mono = true;
  const fin = AC.unlocks(p);
  for (let i = 1; i <= p.length; i++) {
    for (const u of AC.unlocks(p.slice(0, i))) if (!same(fin.find((f) => f.code === u.code), u)) mono = false;
  }
  t('rejeu : monotone — rejouer après chaque partie donne les mêmes déblocages, aux mêmes dates', mono);
}
{
  const v = AC.view([{ code: 'hat-trick', unlockedAt: 5, drawId: 'd_1', notifiedAt: null }, { code: 'inconnu', unlockedAt: 1, drawId: 'd_2', notifiedAt: 1 }]);
  t('view : les 10 codes, obtenus ou non ; notifiedAt et codes inconnus ne sortent pas', v.length === 10 && same(v.find((x) => x.code === 'hat-trick'), { code: 'hat-trick', unlocked: true, at: 5, drawId: 'd_1' })
    && v.filter((x) => x.unlocked).length === 1 && !JSON.stringify(v).includes('notified') && !JSON.stringify(v).includes('inconnu'));
  t('readSeen : codes connus seulement, sans doublon', same(AC.readSeen(['hat-trick', 'hat-trick', 'x', 42, null, 'first-win']), ['hat-trick', 'first-win']) && same(AC.readSeen('first-win'), []));
}

// ═══════════════════════════════════════════════════════════ stockage
async function scenarioStore(store, nom) {
  await store.register('p_s1', 'h1');
  await store.register('p_s2', 'h2');
  const list = [{ code: 'first-win', at: T0, drawId: 'd_a' }, { code: 'explorer', at: T0 + 1000, drawId: 'd_b' }];
  const n1 = await store.unlock('p_s1', list);
  const n2 = await store.unlock('p_s1', list);
  t(`${nom} : un succès ne s'insère qu'une fois (2 puis 0)`, same(n1.sort(), ['explorer', 'first-win']) && same(n2, []));
  const [c1, c2] = await Promise.all([store.unlock('p_s2', [list[0]]), store.unlock('p_s2', [list[0]])]);
  t(`${nom} : deux insertions simultanées → UN seul nouveau`, c1.length + c2.length === 1, `${c1} / ${c2}`);
  t(`${nom} : un id jamais enregistré n'insère rien`, same(await store.unlock('p_inconnu', list), []));
  const s1 = (await store.achievements('p_s1')).sort((x, y) => (x.code < y.code ? -1 : 1));
  t(`${nom} : date et partie gardées, à notifier`, same(s1.map((x) => [x.code, x.unlockedAt, x.drawId, x.notifiedAt]), [['explorer', T0 + 1000, 'd_b', null], ['first-win', T0, 'd_a', null]]), JSON.stringify(s1));
  const m1 = await store.markSeen('p_s1', ['first-win', 'hat-trick']);
  const m2 = await store.markSeen('p_s1', ['first-win']);
  const m3 = await store.markSeen('p_s2', ['explorer']);
  t(`${nom} : « vu » ne touche que des lignes existantes, non vues, du joueur`, same(m1, ['first-win']) && same(m2, []) && same(m3, []));
  const vu = (await store.achievements('p_s1')).find((x) => x.code === 'first-win');
  t(`${nom} : notifiedAt posé`, typeof vu.notifiedAt === 'number' && vu.notifiedAt > 0);
  t(`${nom} : « vu » n'a pas débloqué hat-trick`, !(await store.achievements('p_s1')).some((x) => x.code === 'hat-trick'));
  const sil = await store.unlock('p_s2', [{ code: 'hat-trick', at: T0 + 5, drawId: 'd_c' }], true);
  const hs = (await store.achievements('p_s2')).find((x) => x.code === 'hat-trick');
  t(`${nom} : inscription silencieuse = déjà notifié (notifiedAt = unlockedAt)`, same(sil, ['hat-trick']) && hs.notifiedAt === hs.unlockedAt);
  // Les parties relues pour le rejeu.
  await store.record('d_p1', 'SOIR1', 'passeur', [{ playerId: 'p_s1', rank: 1, ranked: 3, behind: 2, points: 30 }]);
  const pl = await store.plays('p_s1');
  t(`${nom} : plays() rend de quoi rejouer (jeu, rangs, soirée, instant)`, pl.length === 1 && same([pl[0].drawId, pl[0].sessionCode, pl[0].gameId, pl[0].rank, pl[0].ranked, pl[0].behind], ['d_p1', 'SOIR1', 'passeur', 1, 3, 2])
    && typeof pl[0].at === 'number' && Math.abs(pl[0].at - Date.now()) < 120e3, JSON.stringify(pl));
  return (await store.achievements('p_s2')).map((x) => [x.code, x.unlockedAt, x.drawId, x.notifiedAt != null]).sort();
}

// ═══════════════════════════════════════════════════════ protocole, vraies connexions
const on = (id, min = 1) => ({ id, title: id, emoji: '🎮', url: `games/${id}/`, mode: 'online', players: { min, max: 12 }, minutes: { min: 1, max: 8 },
  needs: [], categories: ['reflexe'], server: `wss://${id}.example`, health: `http://127.0.0.1:1/${id}`, join: 'v1', content: false, replay: false, handoff: true });
const JEUX = ['passeur', 'ban', 'precision'];
const FICHIER = path.join(os.tmpdir(), `hub-succes-${process.pid}.json`);
fs.writeFileSync(FICHIER, JSON.stringify({ version: 1, games: JEUX.map((g) => on(g)) }));

let panne = false, horloge = null;
const store = createMemoryStore({ down: () => panne, now: () => (horloge != null ? horloge : Date.now()) });
// Un déblocage qui échoue une fois (base qui tombe entre la ligne et le succès).
let unlockKo = false;
const unlockVrai = store.unlock;
store.unlock = (...x) => (unlockKo ? Promise.reject(new Error('panne simulée (unlock)')) : unlockVrai(...x));
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
      const m = c.msgs.slice(from).reverse().find(pred);
      if (m) return resolve(m);
      if (Date.now() > fin) return reject(new Error(`${nom} : condition non atteinte en ${ms} ms`));
      setTimeout(voir, 10);
    };
    voir();
  });
  c.until = (pred, ms, from) => c.waitFor((m) => m.type === 'session' && pred(m.session), ms, from).then((m) => m.session);
  c.last = () => { const m = [...c.msgs].reverse().find((x) => x.session); return m && m.session; };
  c.stats = async () => { const m = c.mark(); c.send({ action: 'stats' }); return c.waitFor((x) => x.type === 'stats', 3000, m); };
  // Les notifications de succès reçues depuis `from`.
  c.succes = (from = 0) => c.msgs.slice(from).filter((m) => m.type === 'achievement');
  c.fermer = () => new Promise((res) => { if (ws.readyState === ws.CLOSED) return res(); ws.once('close', res); ws.close(); });
  return c;
}
const cle = (l) => (l + 'q').repeat(20);
async function entre(nom, id, code, key, port) {
  const c = client(nom, port); await c.open;
  const player = Object.assign({ id, name: nom, avatar: { kind: 'emoji', emoji: '🦊' } }, key ? { key } : {});
  c.send(code ? { action: 'join', code, player } : { action: 'create', player });
  c.accueil = await c.waitFor((m) => m.type === 'joined' || m.type === 'created' || m.type === 'error');
  await sleep(60);                                          // vérification de la clé + livraison : asynchrones
  return c;
}
async function partie(hote, autres, gameId, rangs, avantResultats) {
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
  if (avantResultats) await avantResultats();
  const results = [hote, ...autres].map((c) => ({ gamePlayerId: 'g-' + c.nom, rank: rangs[c.nom], points: 100 - rangs[c.nom] }));
  m = hote.mark();
  hote.send({ action: 'results', drawId: d.id, gameId, results });
  await hote.until((s) => s.history.games.some((g) => g.drawId === d.id), 3000, m);
  hote.derniers = { drawId: d.id, results };
  m = hote.mark(); hote.send({ action: 'ended', drawId: d.id }); await hote.until((s) => s.state === 'debrief', 3000, m);
  await sleep(80);                                          // lignes puis succès : asynchrones
  return d.id;
}
const codesDe = (msgs) => msgs.flatMap((m) => m.unlocked.map((u) => u.code));
const vue = (s, code) => s.stats.achievements.find((x) => x.code === code);

async function protocole() {
  console.log('\nSuccès — protocole, vraies connexions\n');
  const ana = await entre('Ana', 'p_ana', null, cle('a'));
  const code = ana.last().code;
  const bob = await entre('Bob', 'p_bob', code, cle('b'));
  const s0 = await ana.stats();
  t('stats : les 10 succès, tous verrouillés pour un nouveau joueur', s0.stats.achievements.length === 10 && s0.stats.achievements.every((x) => !x.unlocked), JSON.stringify(s0.stats.achievements.slice(0, 2)));
  t('stats : les records et statistiques du lot H/I sont toujours là', s0.stats.records === null && s0.stats.played === 0);

  // 1. Première victoire d'Ana : notifiée à ELLE seule.
  let ma = ana.mark(), mb = bob.mark();
  const d1 = await partie(ana, [bob], 'passeur', { Ana: 1, Bob: 2 });
  await ana.waitFor((m) => m.type === 'achievement', 2000, ma).catch(() => null);
  t('1re victoire : Ana reçoit « achievement » [first-win], daté par la partie', same(codesDe(ana.succes(ma)), ['first-win'])
    && ana.succes(ma)[0].unlocked[0].drawId === d1 && typeof ana.succes(ma)[0].unlocked[0].at === 'number', JSON.stringify(ana.succes(ma)));
  t('Bob (2e) ne reçoit rien — et jamais le succès d\'Ana', bob.succes(mb).length === 0);
  const sa = await ana.stats();
  t('stats : first-win obtenu (date, partie), les 9 autres verrouillés', vue(sa, 'first-win').unlocked && vue(sa, 'first-win').drawId === d1
    && sa.stats.achievements.filter((x) => x.unlocked).length === 1);

  // 2. Le classement renvoyé : refusé, aucune notification de plus.
  ma = ana.mark();
  ana.send({ action: 'results', drawId: d1, gameId: 'passeur', results: ana.derniers.results });
  await ana.waitFor((x) => x.type === 'error', 2000, ma);
  await sleep(100);
  t('results renvoyé : refusé, aucun nouveau déblocage', ana.succes(ma).length === 0);

  // 3. Pas d'accusé → renvoyé à la reconnexion ; accusé → plus jamais.
  await ana.fermer();
  const ana2 = await entre('Ana', 'p_ana', code, cle('a'));
  await ana2.waitFor((m) => m.type === 'achievement', 2000).catch(() => null);
  t('reconnexion SANS accusé : first-win renvoyé (toujours à notifier)', same(codesDe(ana2.succes()), ['first-win']));
  // Bob tente d'accuser réception à la place d'Ana : sans effet pour elle.
  bob.send({ action: 'achievements-seen', codes: ['first-win', 'grand-slam', 'pas-un-code'] });
  await sleep(60);
  await ana2.fermer();
  const ana3 = await entre('Ana', 'p_ana', code, cle('a'));
  await ana3.waitFor((m) => m.type === 'achievement', 2000).catch(() => null);
  t('accusé forgé par Bob : la notification d\'Ana reste due', same(codesDe(ana3.succes()), ['first-win']));
  t('… et aucun message d\'erreur pour un code inconnu (ignoré)', !bob.msgs.some((m) => m.type === 'error' && m.code === 'BAD_JSON'));
  ana3.send({ action: 'achievements-seen', codes: ['first-win'] });
  await sleep(60);
  await ana3.fermer();
  const ana4 = await entre('Ana', 'p_ana', code, cle('a'));
  await sleep(150);
  t('accusé d\'Ana → reconnexion : RIEN n\'est renvoyé', ana4.succes().length === 0);
  const sa4 = await ana4.stats();
  t('… mais le succès reste obtenu dans le profil', vue(sa4, 'first-win').unlocked);

  // 4. Aucune action client ne débloque.
  const triche = await entre('Tri', 'p_tri', code, cle('t'));
  triche.send({ action: 'achievements-seen', codes: AC.CODES });
  let mt = triche.mark();
  triche.send({ action: 'unlock', code: 'grand-slam' });
  const inconnue = await triche.waitFor((x) => x.type === 'error', 2000, mt);
  triche.send({ action: 'stats', achievements: ['grand-slam'], playerId: 'p_ana' });
  const st = await triche.stats();
  t('aucune action client ne débloque : « unlock » inconnue, « vu » sans ligne, stats ne lit rien du message',
    inconnue.code === 'UNKNOWN_ACTION' && st.stats.achievements.every((x) => !x.unlocked) && triche.succes().length === 0);
  triche.send({ action: 'leave' });
  await ana4.until((s) => !s.players.some((p) => p.id === 'p_tri'), 2000);

  // 5. Plusieurs d'un coup, dans l'ordre du catalogue, UN message ; Cam gagne à 6.
  const cam = await entre('Cam', 'p_cam', code, cle('c'));
  const autres = [];
  for (const nom of ['Dan', 'Eve', 'Fil']) autres.push(await entre(nom, 'p_' + nom.toLowerCase(), code, cle(nom[0].toLowerCase())));
  await ana4.until((s) => s.players.length === 6, 2000);
  const mc = cam.mark();
  await partie(ana4, [bob, cam, ...autres], 'ban', { Ana: 2, Bob: 3, Cam: 1, Dan: 4, Eve: 5, Fil: 6 });
  await cam.waitFor((m) => m.type === 'achievement', 2000, mc).catch(() => null);
  t('victoire à 6 : Cam reçoit [first-win, crowd-king] en UN message, ordre du catalogue', cam.succes(mc).length === 1 && same(codesDe(cam.succes(mc)), ['first-win', 'crowd-king']), JSON.stringify(cam.succes(mc)));
  t('les autres joueurs ne reçoivent pas les succès de Cam', [ana4, bob, ...autres].every((c) => !codesDe(c.succes()).includes('crowd-king')));

  // 6. Joueur PARTI avant le classement : ses succès l'attendent.
  const md = autres[0].mark();
  await partie(ana4, [bob, cam, ...autres], 'precision', { Ana: 3, Bob: 4, Cam: 5, Dan: 1, Eve: 1, Fil: 6 }, async () => {
    autres[0].send({ action: 'leave' });
    await ana4.until((s) => !s.players.some((p) => p.id === 'p_dan'), 2000);
  });
  t('joueur parti : rien ne lui est envoyé (plus de socket dans la session)', autres[0].succes(md).length === 0);
  const dan = await entre('Dan', 'p_dan', null, cle('d'));               // il revient, dans une AUTRE soirée
  await dan.waitFor((m) => m.type === 'achievement', 2000).catch(() => null);
  t('… il revient (nouvelle session) : [first-win, shared-throne, crowd-king] livrés', same(codesDe(dan.succes()), ['first-win', 'shared-throne', 'crowd-king']), JSON.stringify(codesDe(dan.succes())));
  const eve = autres[1];
  t('Eve, 1re ex æquo à 6 : Partage du trône ET Roi de la foule', ['shared-throne', 'crowd-king'].every((c) => codesDe(eve.succes()).includes(c)), JSON.stringify(codesDe(eve.succes())));

  // 7. Base en panne au classement : rien ne casse ; la ligne puis le succès arrivent.
  for (const c of [cam, ...autres.slice(1)]) { c.send({ action: 'leave' }); }
  await ana4.until((s) => s.players.length === 2, 2000);
  panne = true;
  const mb7 = bob.mark();
  await partie(ana4, [bob], 'passeur', { Ana: 2, Bob: 1 });
  panne = false;
  await bob.waitFor((m) => m.type === 'achievement', 2000, mb7).catch(() => null);
  t('base en panne au classement : nouvelle tentative → ligne → first-win livré à Bob, une fois', same(codesDe(bob.succes(mb7)), ['first-win']), JSON.stringify(bob.succes(mb7)));

  // 8. Le succès échoue seul (ligne écrite) : rattrapé à l'ouverture du profil.
  unlockKo = true;
  const ma8 = ana4.mark();
  await partie(ana4, [bob], 'precision', { Ana: 1, Bob: 2 });     // Ana : 2e jeu gagné
  await partie(ana4, [bob], 'ban', { Ana: 1, Bob: 2 });           // 3e jeu gagné → Polyvalent
  unlockKo = false;
  await sleep(100);
  t('succès en panne : rien n\'est envoyé (rien d\'inséré)', !codesDe(ana4.succes(ma8)).includes('versatile'));
  const s8 = await ana4.stats();
  await ana4.waitFor((m) => m.type === 'achievement', 2000, ma8).catch(() => null);
  t('… rattrapé par la demande de stats : obtenu dans le profil ET notifié', vue(s8, 'versatile').unlocked && codesDe(ana4.succes(ma8)).includes('versatile'), JSON.stringify(codesDe(ana4.succes(ma8))));

  // 9. Hat-trick d'Ana dans la soirée (ban, ex æquo, precision) : déjà 2 victoires d'affilée.
  const ma9 = ana4.mark();
  await partie(ana4, [bob], 'passeur', { Ana: 1, Bob: 2 });
  await ana4.waitFor((m) => m.type === 'achievement' && m.unlocked.some((u) => u.code === 'hat-trick'), 2000, ma9).catch(() => null);
  t('Hat-trick : 3 victoires d\'affilée dans la soirée → notifié', codesDe(ana4.succes(ma9)).includes('hat-trick'), JSON.stringify(codesDe(ana4.succes(ma9))));

  // 10. Oiseau de nuit : l'horloge des parties à 2 h du matin, heure de Paris.
  horloge = Date.parse('2026-07-16T00:00:00Z');
  const mb10 = bob.mark();
  await partie(ana4, [bob], 'passeur', { Ana: 2, Bob: 1 });
  horloge = null;
  await bob.waitFor((m) => m.type === 'achievement' && m.unlocked.some((u) => u.code === 'night-owl'), 2000, mb10).catch(() => null);
  t('Oiseau de nuit : partie classée à 2 h (Paris) → notifié', codesDe(bob.succes(mb10)).includes('night-owl'), JSON.stringify(codesDe(bob.succes(mb10))));

  // 11. Sans clé : ni succès, ni notification, ni « vu ».
  const sansCle = await entre('Xav', 'p_xav', code);
  sansCle.send({ action: 'achievements-seen', codes: ['first-win'] });
  t('sans clé : stats UNVERIFIED, aucune notification', (await sansCle.stats()).reason === 'UNVERIFIED' && sansCle.succes().length === 0);

  // 12. Hub sans stockage : rien, et la soirée marche.
  const z = await entre('Zoé', 'p_zoe', null, cle('z'), PORT + 1);
  z.send({ action: 'achievements-seen', codes: ['first-win'] });
  await sleep(80);
  t('Hub sans stockage : aucune notification, « vu » ignoré sans erreur', z.accueil.type === 'created' && z.succes().length === 0 && !z.msgs.some((m) => m.type === 'error'));

  // 13. Hors session : refus propre.
  const seul = client('Seul'); await seul.open;
  const m13 = seul.mark(); seul.send({ action: 'achievements-seen', codes: ['first-win'] });
  t('hors session : NOT_IN_SESSION', (await seul.waitFor((x) => x.type === 'error', 2000, m13)).code === 'NOT_IN_SESSION');

  // Partout : jamais le succès d'un autre.
  const fuite = tous.filter((c) => c.succes().some((m) => m.unlocked.some((u) => !u.code || typeof u.at !== 'number')));
  t('forme des messages : { code, at, drawId } seulement', !fuite.length && tous.every((c) => c.succes().every((m) => m.unlocked.every((u) => same(Object.keys(u), ['code', 'at', 'drawId'])))));
}

(async () => {
  console.log('\nSuccès — stockage\n');
  const mem = await scenarioStore(createMemoryStore(), 'mémoire');

  if (process.env.TEST_DATABASE_URL) {
    const { createPgStore, SCHEMA } = require('./src/store-pg.js');
    const { Pool } = require('pg');
    const brut = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const vide = 'drop table if exists hub_achievements; drop table if exists hub_plays; drop table if exists hub_players;';
    await brut.query(vide);
    const pg = createPgStore({ url: process.env.TEST_DATABASE_URL });
    const sql = await scenarioStore(pg, 'postgres');
    t('postgres : les mêmes succès qu\'en mémoire (code, date, partie, notifié)', same(sql, mem), JSON.stringify(sql));
    await pg.close();

    // Rattrapage : une base du lot H/I (parties, SANS hub_achievements) → la
    // table naît, les succès déjà mérités y sont inscrits SANS notification.
    await brut.query(vide);
    await brut.query(SCHEMA);
    await brut.query(`insert into hub_players (player_id, key_hash) values ('p_old', 'h'), ('p_vide', 'h2')`);
    const vieilles = [W('passeur'), W('ban'), W('precision'), L('morpion')];
    for (const p of vieilles) {
      await brut.query(`insert into hub_plays (draw_id, player_id, session_code, game_id, rank, ranked, behind, points, played_at)
        values ($1, 'p_old', $2, $3, $4, $5, $6, 0, to_timestamp($7 / 1000.0))`, [p.drawId, p.sessionCode, p.gameId, p.rank, p.ranked, p.behind, p.at]);
    }
    const pg2 = createPgStore({ url: process.env.TEST_DATABASE_URL });
    const r = (await pg2.achievements('p_old')).sort((x, y) => AC.CODES.indexOf(x.code) - AC.CODES.indexOf(y.code));
    t('rattrapage : les succès déjà mérités sont inscrits (first-win, versatile, hat-trick)', same(r.map((x) => x.code), ['first-win', 'versatile', 'hat-trick']), JSON.stringify(r));
    t('rattrapage : TOUS déjà notifiés — aucune notification rétroactive', r.every((x) => x.notifiedAt != null && x.notifiedAt === x.unlockedAt));
    t('rattrapage : datés par la partie qui les a débloqués', r.find((x) => x.code === 'hat-trick').drawId === vieilles[2].drawId
      && r.find((x) => x.code === 'first-win').unlockedAt === vieilles[0].at);
    t('rattrapage : unlock() de ces succès ensuite = rien de nouveau', same(await pg2.unlock('p_old', AC.unlocks(await pg2.plays('p_old'))), []));
    await pg2.close();
    // Une seconde ouverture (table existante) ne refait PAS le rattrapage.
    await brut.query(`delete from hub_achievements where player_id = 'p_old' and code = 'hat-trick'`);
    const pg3 = createPgStore({ url: process.env.TEST_DATABASE_URL });
    t('rattrapage une seule fois : la table existe déjà → rien n\'est réinscrit en silence', !(await pg3.achievements('p_old')).some((x) => x.code === 'hat-trick'));
    t('postgres : plays() dans l\'ordre, instants en ms', same((await pg3.plays('p_old')).map((p) => [p.drawId, p.at]), vieilles.map((p) => [p.drawId, p.at])));
    await pg3.close();
    await brut.query(vide);
    await brut.end();
  } else {
    console.log('(postgres sauté : TEST_DATABASE_URL absent)');
  }

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
