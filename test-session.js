// Tests du MODÈLE, sans réseau : codes, identité, élection d'hôte, état public.
//
//   node test-session.js
//
// Ces modules sont purs exprès. Ce qui se teste ici sans ouvrir un socket n'a
// pas à être testé à travers un socket.
'use strict';

const codes = require('./src/codes.js');
const ident = require('./src/identity.js');
const S = require('./src/session.js');
const { publicSession } = require('./src/serialize.js');

let ok = 0, ko = 0;
const t = (nom, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + nom + (detail ? ' — ' + detail : '')); }
  else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('Modèle de session — hors réseau\n');

// ─────────────────────────────────────────────────────────────── codes
{
  const pris = new Set();
  const c = codes.newCode((x) => pris.has(x));
  t('un code fait 5 caractères', c.length === 5, c);
  t('un code n\'utilise que l\'alphabet non ambigu',
    [...c].every((ch) => codes.ALPHABET.includes(ch)), c);
  t('ni I, ni L, ni O, ni 0, ni 1 dans l\'alphabet',
    !/[ILO01]/.test(codes.ALPHABET), codes.ALPHABET);
  // Le Hub a SON alphabet : 5 caractères, là où les sept jeux en tirent 4. Un
  // code de session ne se confond donc jamais avec un code de partie.
  t('le code du Hub est plus long que celui des jeux (4)', codes.LENGTH === 5);

  // Collision : on force `estPris` à refuser tout sauf une valeur.
  let n = 0;
  const seul = codes.newCode((x) => { n++; return n < 5; });
  t('un code déjà pris est retiré', typeof seul === 'string' && n === 5, `${n} tirages`);

  let boom = false;
  try { codes.newCode(() => true); } catch (_) { boom = true; }
  t('si aucun code n\'est libre, on échoue franchement (pas de boucle infinie)', boom);

  t('code normalisé : minuscules et espaces pardonnés',
    codes.normalizeCode('  ab2cd  ') === 'AB2CD');
  t('code de mauvaise longueur refusé', codes.normalizeCode('AB2C') === null);
  t('code avec un caractère ambigu refusé', codes.normalizeCode('AB0CD') === null);
  t('non-chaîne refusée', codes.normalizeCode(42) === null);
}

// ─────────────────────────────────────────────────────────────── identité
{
  const bon = { id: 'p_7f3a91c2', name: 'Mathys', avatar: { kind: 'emoji', emoji: '🦊' } };
  t('identité valide acceptée', !!ident.readPlayer(bon).player);

  t('id absent refusé', !!ident.readPlayer({ name: 'x', avatar: { emoji: '🦊' } }).error);
  t('id trop court refusé', !!ident.readPlayer({ ...bon, id: 'ab' }).error);
  t('id exotique refusé', !!ident.readPlayer({ ...bon, id: 'p_<script>' }).error);
  t('pseudo vide refusé (4 serveurs sur 6 le refusent aussi)',
    !!ident.readPlayer({ ...bon, name: '   ' }).error);

  const long = ident.readPlayer({ ...bon, name: 'Bartholomew-Alexandre-de-la-Tour' });
  t('pseudo tronqué à 16, comme les serveurs de jeu',
    long.player.name.length === 16, '« ' + long.player.name + ' »');

  // ⚠️ slice(0, 4) compte des unités UTF-16 : un emoji à ZWJ serait coupé en
  // plein milieu par les serveurs de jeu. On le refuse ici aussi.
  t('emoji à ZWJ refusé (8 unités UTF-16)',
    !!ident.readPlayer({ ...bon, avatar: { emoji: '👨‍👩‍👧' } }).error);
  t('avatar sans emoji refusé', !!ident.readPlayer({ ...bon, avatar: {} }).error);

  const img = 'data:image/webp;base64,' + 'A'.repeat(200);
  const avecImg = ident.readPlayer({ ...bon, avatar: { kind: 'image', emoji: '🦊', src: img } });
  t('image valide conservée par le Hub', avecImg.player.avatar.kind === 'image' && !!avecImg.player.avatar.src);
  t('l\'emoji reste présent à côté de l\'image', avecImg.player.avatar.emoji === '🦊');

  const svg = ident.readPlayer({ ...bon, avatar: { kind: 'image', emoji: '🦊', src: 'data:image/svg+xml;base64,PHN2Zz4=' } });
  t('SVG refusé, repli silencieux sur l\'emoji', svg.player.avatar.kind === 'emoji' && !svg.player.avatar.src);

  const gros = ident.readPlayer({ ...bon,
    avatar: { kind: 'image', emoji: '🦊', src: 'data:image/webp;base64,' + 'A'.repeat(ident.MAX_IMAGE_CHARS + 10) } });
  t('image au-delà de la limite refusée, repli sur l\'emoji', gros.player.avatar.kind === 'emoji');
}

// ─────────────────────────────────────────────────────── session et hôte
{
  const s = S.createSession('AB2CD');
  t('session neuve : état lobby', s.state === 'lobby');
  t('session neuve : aucun hôte tant qu\'il n\'y a personne', s.hostId === null);
  t('les six états sont représentables',
    S.STATES.join(',') === 'lobby,drawing,launching,inGame,debrief,closed');

  const a = S.addPlayer(s, { id: 'p_aaaa', name: 'A', avatar: { kind: 'emoji', emoji: '🦊' } });
  t('le premier joueur devient hôte', s.hostId === 'p_aaaa');
  t('champs préparés pour le randomizer',
    a.player.caps.mic === false && Array.isArray(a.player.veto) && Array.isArray(a.player.love));

  S.addPlayer(s, { id: 'p_bbbb', name: 'B', avatar: { kind: 'emoji', emoji: '🐼' } });
  t('un deuxième joueur ne devient pas hôte', s.hostId === 'p_aaaa');
  t('le même id deux fois est refusé',
    S.addPlayer(s, { id: 'p_aaaa', name: 'A2', avatar: { kind: 'emoji', emoji: '🔥' } }).error === 'PLAYER_EXISTS');

  // Réélection : l'hôte se déconnecte (pas encore parti).
  S.getPlayer(s, 'p_aaaa').connected = false;
  S.electHost(s);
  t('hôte déconnecté : le suivant prend la main', s.hostId === 'p_bbbb');
  S.getPlayer(s, 'p_aaaa').connected = true;
  S.electHost(s);
  t('un hôte valide n\'est pas remplacé pour rien', s.hostId === 'p_bbbb');

  S.removePlayer(s, 'p_bbbb');
  t('hôte parti : réélection automatique', s.hostId === 'p_aaaa');

  // Session pleine
  const plein = S.createSession('ZZZZZ', { maxPlayers: 2 });
  S.addPlayer(plein, { id: 'p_0001', name: 'x', avatar: { kind: 'emoji', emoji: '🦊' } });
  S.addPlayer(plein, { id: 'p_0002', name: 'y', avatar: { kind: 'emoji', emoji: '🦊' } });
  t('session pleine refusée',
    S.addPlayer(plein, { id: 'p_0003', name: 'z', avatar: { kind: 'emoji', emoji: '🦊' } }).error === 'SESSION_FULL');
  t('le plafond par défaut est 12 (le plus permissif des sept jeux)', S.MAX_PLAYERS === 12);
}

// ───────────────────────────────────────────────────────── état public
{
  const s = S.createSession('AB2CD');
  S.addPlayer(s, { id: 'p_aaaa', name: 'A', avatar: { kind: 'emoji', emoji: '🦊' } });
  s.sockets.set('p_aaaa', { secret: 'un faux socket' });
  const pub = publicSession(s);
  const texte = JSON.stringify(pub);

  t('l\'état public ne contient aucun socket', !texte.includes('faux socket'));
  t('l\'identifiant interne de session ne sort pas', !('id' in pub) && !texte.includes(s.id));
  t('le code, lui, est public', pub.code === 'AB2CD');
  t('les horodatages internes ne sortent pas',
    !texte.includes('since') && !texte.includes('createdAt') && !texte.includes('graceMs'));
  t('draw et history existent, vides',
    pub.draw === null && Array.isArray(pub.history.played) && pub.history.played.length === 0);
  t('l\'hôte est marqué sur le joueur', pub.players[0].host === true);

  // Liste blanche : si un champ interne apparaît dans le modèle demain, il ne
  // doit pas partir tout seul.
  s.players[0].secretInterne = 'ne doit pas sortir';
  t('un champ ajouté au modèle ne fuit pas dans l\'état public',
    !JSON.stringify(publicSession(s)).includes('ne doit pas sortir'));
}

console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok + ko} vérifications, ${ko} échec(s)`);
process.exit(ko ? 1 : 0);
