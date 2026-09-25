// Lancement (handoff) — le module pur, sans réseau.
//
//   node test-launch.js
'use strict';

const L = require('./src/launch.js');
const S = require('./src/session.js');

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Une session réelle (session.js), trois joueurs, un tirage « passeur ».
function scene() {
  const s = S.createSession('ABCDE');
  for (const [id, name] of [['p_aaaa', 'A'], ['p_bbbb', 'B'], ['p_cccc', 'C']]) S.addPlayer(s, { id, name, avatar: { kind: 'emoji', emoji: '🦊' } });
  const draw = { id: 'd_1', gameId: 'passeur' };
  const game = { id: 'passeur', url: 'games/passeur/' };
  const l = L.create(s, draw, game, 1000, { createMs: 500, joinMs: 800 });
  return { s, l };
}

console.log('Lancement — module pur\n');

{
  const { l } = scene();
  t('création : hôte du lancement = hôte de la session, figé', l.hostId === 'p_aaaa');
  t('création : stage create, aucun code, tout le groupe attendu', l.stage === 'create' && l.roomCode === null && same(L.waiting(l), ['p_aaaa', 'p_bbbb', 'p_cccc']));
  t('création : lié au tirage (drawId) et au jeu du manifest', l.drawId === 'd_1' && l.gameId === 'passeur' && l.url === 'games/passeur/');
  t('création : échéance posée', l.deadline === 1500);
}

// ── host autorisé / guest refusé
{
  const { l } = scene();
  t('guest refusé : un invité ne déclare pas de code', L.checkLaunched(l, 'p_bbbb', { drawId: 'd_1', roomCode: 'KQMP' }, 1100).error === 'NOT_HOST');
  t('host autorisé', L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: 'kqmp' }, 1100).code === 'KQMP');
}

// ── roomCode valide
{
  const { l } = scene();
  for (const bad of ['', 'AB', 'ABCDEFGHI', 'AB-D', 'ab cd', null, 42, { x: 1 }]) {
    t(`roomCode mal formé refusé : ${JSON.stringify(bad)}`, L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: bad }, 1100).error === 'BAD_ROOM_CODE');
  }
  t('roomCode : espaces et minuscules pardonnés', L.normalizeRoomCode('  kqmp ') === 'KQMP');
}

// ── lié au draw courant
{
  const { l } = scene();
  t('launch lié au draw : un autre drawId est refusé', L.checkLaunched(l, 'p_aaaa', { drawId: 'd_0', roomCode: 'KQMP' }, 1100).error === 'LAUNCH_MISMATCH');
  t('launch lié au draw : sans drawId, refusé', L.checkLaunched(l, 'p_aaaa', { roomCode: 'KQMP' }, 1100).error === 'LAUNCH_MISMATCH');
}

// ── expiration
{
  const { l } = scene();
  t('expiration : après l\'échéance, refusé', L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: 'KQMP' }, 1501).error === 'LAUNCH_EXPIRED');
  t('expiration : pile à l\'échéance, accepté', !!L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: 'KQMP' }, 1500).code);
}

// ── double launch
{
  const { l } = scene();
  const r = L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: 'KQMP' }, 1100);
  L.applyLaunched(l, r.code, 1100, { joinMs: 800 });
  t('double launch : le second est refusé (usage unique)', L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: 'ZZZZ' }, 1150).error === 'LAUNCH_CONSUMED');
  t('double launch : le premier code reste', l.roomCode === 'KQMP' && l.stage === 'join');
  t('launched : l\'hôte est dans sa room, nouvelle échéance (rejoindre)', same(l.entered, ['p_aaaa']) && l.deadline === 1900);
}

// ── waiting / entered
{
  const { l } = scene();
  L.applyLaunched(l, 'KQMP', 1100, {});
  t('waiting : B et C attendus', same(L.waiting(l), ['p_bbbb', 'p_cccc']));
  t('entered : code d\'une AUTRE room refusé', L.checkEntered(l, 'p_bbbb', { drawId: 'd_1', roomCode: 'ZZZZ' }).error === 'WRONG_ROOM');
  t('entered : autre tirage refusé', L.checkEntered(l, 'p_bbbb', { drawId: 'd_9', roomCode: 'KQMP' }).error === 'LAUNCH_MISMATCH');
  t('entered : bon code accepté', L.checkEntered(l, 'p_bbbb', { drawId: 'd_1', roomCode: 'kqmp' }).ok === true);
  L.applyEntered(l, 'p_bbbb');
  L.applyEntered(l, 'p_bbbb');
  t('entered : idempotent, B n\'est plus attendu', same(l.entered, ['p_aaaa', 'p_bbbb']) && same(L.waiting(l), ['p_cccc']));
  L.applyEntered(l, 'p_dddd');
  t('entered : un joueur arrivé après le tirage est ajouté', l.expected.includes('p_dddd') && l.entered.includes('p_dddd'));
  L.applyEntered(l, 'p_cccc');
  t('tout le monde est entré : plus personne en attente', L.waiting(l).length === 0);
}

// ── entered avant le code
{
  const { l } = scene();
  t('entered avant que l\'hôte ait créé la room : refusé', L.checkEntered(l, 'p_bbbb', { drawId: 'd_1', roomCode: 'KQMP' }).error === 'NOT_LAUNCHING');
}

// ── failed / manqués
{
  const { l } = scene();
  L.applyLaunched(l, 'KQMP', 1100, {});
  l.failed.p_bbbb = 'aucune partie avec ce code';
  t('failed : un invité en échec n\'est plus attendu, et la raison reste', same(L.waiting(l), ['p_cccc']) && l.failed.p_bbbb.length > 5);
  L.applyPlaying(l);
  t('playing : ceux qui manquent sont « manqués », pas oubliés', l.stage === 'playing' && same(l.missed, ['p_cccc']));
  L.applyEntered(l, 'p_cccc');
  t('un manqué qui entre quand même n\'est plus manqué', l.missed.length === 0 && l.entered.includes('p_cccc'));
  L.fail(l, 'UNREACHABLE');
  t('fail : stage failed + raison', l.stage === 'failed' && l.reason === 'UNREACHABLE');
  t('fail : plus rien n\'est accepté ensuite', L.checkLaunched(l, 'p_aaaa', { drawId: 'd_1', roomCode: 'KQMP' }, 1100).error === 'NOT_LAUNCHING'
    && L.checkEntered(l, 'p_bbbb', { drawId: 'd_1', roomCode: 'KQMP' }).error === 'NOT_LAUNCHING');
}

// ── changement d'hôte
{
  const { s, l } = scene();
  s.state = 'launching'; s.launch = l;
  s.players.find((p) => p.id === 'p_aaaa').connected = false;       // A navigue vers le jeu
  S.electHost(s);
  t('changement d\'hôte : A qui NAVIGUE reste hôte pendant le lancement', s.hostId === 'p_aaaa');
  S.removePlayer(s, 'p_aaaa');                                        // A part pour de bon
  t('changement d\'hôte : A parti → nouvel hôte parmi les connectés', s.hostId === 'p_bbbb');
  L.forget(l, 'p_aaaa');
  t('forget : un joueur parti n\'est plus attendu', !l.expected.includes('p_aaaa') && !L.waiting(l).includes('p_aaaa'));
  // Au retour de la partie (debrief d'un lancement fini) : même protection.
  const r = scene();
  r.s.state = 'debrief'; r.s.launch = r.l; r.l.stage = 'ended';
  r.s.players.find((p) => p.id === 'p_aaaa').connected = false;      // A revient du jeu au Hub
  S.electHost(r.s);
  t('retour de partie : A qui revient du jeu (absent un instant) reste hôte', r.s.hostId === 'p_aaaa');
  r.l.stage = 'failed';
  S.electHost(r.s);
  t('… mais pas après un lancement RATÉ : règle habituelle', r.s.hostId === 'p_bbbb');
  s.state = 'lobby';
  s.hostId = 'p_cccc';
  s.players.find((p) => p.id === 'p_cccc').connected = false;
  S.electHost(s);
  t('hors lancement : la règle habituelle (le plus ancien connecté)', s.hostId === 'p_bbbb');
}

// ── état public
{
  const { l } = scene();
  L.applyLaunched(l, 'KQMP', 1100, { joinMs: 800 });
  const p = L.publicLaunch(l, 1300);
  t('public : champ par champ, waiting calculé, temps restant', same(Object.keys(p).sort(),
    ['deadline' in p ? 'x' : 'drawId', 'entered', 'expected', 'expiresInMs', 'failed', 'gameId', 'hostId', 'missed', 'reason', 'roomCode', 'scored', 'stage', 'url', 'waiting'].sort())
    && p.expiresInMs === 600 && same(p.waiting, ['p_bbbb', 'p_cccc']));
  t('public : null sans lancement', L.publicLaunch(null, 0) === null);
}

console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
