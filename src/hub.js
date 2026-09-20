// Le Hub : le magasin de sessions et le protocole WebSocket.
//
// C'est le seul fichier qui touche à la fois aux sockets et au modèle. Tout ce
// qui peut s'en passer vit ailleurs : codes.js, identity.js, session.js,
// serialize.js, prefs.js et engine.js n'ont aucune idée qu'un réseau existe.
'use strict';

const crypto = require('node:crypto');
const S = require('./session.js');
const E = require('./engine.js');
const { newCode, normalizeCode } = require('./codes.js');
const { readPlayer } = require('./identity.js');
const { readPrefs, readCaps, readConstraints } = require('./prefs.js');
const L = require('./launch.js');
const { publicSession } = require('./serialize.js');
const { ERRORS, LAUNCH_FAILURES, parse } = require('./protocol.js');

// ── Heartbeat ─────────────────────────────────────────────────────────────
// Sans lui, une connexion MORTE (téléphone passé en mode avion, Wi-Fi coupé,
// onglet tué par l'OS) ne se signale jamais : aucune trame de fermeture
// n'arrive, et le joueur resterait « connecté » pour les autres jusqu'à ce que
// TCP abandonne — de longues minutes.
//
// Mécanisme : le ping/pong NATIF de WebSocket (ws.ping(), événement 'pong').
// Le navigateur y répond lui-même, dans sa pile réseau : aucun code côté page,
// et un onglet en arrière-plan dont le JavaScript est ralenti répond quand même.
//
// Fréquence : un ping toutes les 20 s. Une connexion qui n'a pas répondu au
// ping précédent est coupée au tour suivant : une connexion morte est donc
// détectée en 20 à 40 s. Assez vite pour que le salon soit juste avant un
// lancement de partie ; pas agressif pour autant — une trame de 2 octets par
// joueur toutes les 20 s, et une connexion lente a 20 s entières pour répondre.
// (Bonus : un trafic régulier évite que les proxys ferment une connexion jugée
// inactive.)
//
// Une connexion coupée par le heartbeat passe par le MÊME chemin qu'une
// fermeture ordinaire (onClose) : joueur marqué absent, délai de grâce, reprise
// possible avec le même player.id.
const HEARTBEAT_MS = 20_000;

// Hasard du tirage : cryptographique, dans [0, 1). Math.random suffirait pour
// une soirée entre amis, mais rien ne justifie de s'en contenter.
// (randomInt refuse un intervalle de 2^48 ou plus : 2^47 valeurs suffisent.)
const cryptoRandom = () => crypto.randomInt(0, 2 ** 47) / 2 ** 47;

// Un catalogue vide, pour un hub monté sans manifest (les tests du salon).
// Il répond « indisponible » : le salon marche, le tirage refuse proprement.
const NO_CATALOG = {
  load: () => Promise.reject(new Error('aucun catalogue configuré')),
  get: () => null,
  status: () => 'error',
};
// Sans vérificateur de santé (tests du salon), les serveurs sont réputés
// joignables : il n'y a rien pour dire le contraire.
const upAll = (games) => Object.fromEntries((games || []).filter((g) => g.mode === 'online').map((g) => [g.id, 'up']));
const NO_HEALTH = {
  ensure: (games) => Promise.resolve(upAll(games)),
  snapshot: upAll,
};

function createHub(options = {}) {
  const sessions = new Map();          // code → session
  const graceMs = options.graceMs == null ? S.GRACE_MS : options.graceMs;
  const heartbeatMs = options.heartbeatMs == null ? HEARTBEAT_MS : options.heartbeatMs;
  const catalog = options.catalog || NO_CATALOG;
  const health = options.health || NO_HEALTH;
  const random = options.random || cryptoRandom;
  const launchOpts = { createMs: options.launchCreateMs, joinMs: options.launchJoinMs };
  const graceTimers = new Map();       // `code/playerId` → timer
  const launchTimers = new Map();      // code de session → échéance du lancement en cours
  const connections = new Set();       // tous les sockets vivants, en session ou non

  // Un tour de heartbeat : couper ce qui n'a pas répondu depuis le tour
  // précédent, puis relancer un ping à tous les autres.
  function beat() {
    for (const ws of connections) {
      if (ws.isAlive === false) {
        // terminate() et non close() : une connexion morte ne répondra pas à la
        // poignée de main de fermeture. L'événement 'close' suit, et onClose
        // fait le reste.
        try { ws.terminate(); } catch (_) { /* déjà partie */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* le close suivra */ }
    }
  }
  let heartbeat = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(beat, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();   // ne retient pas le process en vie
  }

  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const fail = (ws, code, extra) => send(ws, Object.assign({ type: 'error', code, message: ERRORS[code] || code }, extra || {}));

  // Ce que le moteur dit du catalogue pour CE groupe, recalculé à chaque
  // diffusion. Le salon voit donc toujours l'éligibilité à jour : un veto, un
  // micro déclaré, un joueur de plus, un serveur tombé — tout se voit tout de
  // suite, chez tout le monde.
  // ⚠️ La santé n'entre PAS dans l'éligibilité : elle n'est qu'une information
  // (le dernier état connu du serveur d'un jeu, souvent « unknown » puisqu'on
  // ne réveille plus personne à l'avance). Ce que le salon affiche comme
  // « possible », c'est ce que les RÈGLES disent.
  function poolOf(session) {
    const games = catalog.get();
    if (!games) return { catalog: catalog.status() === 'error' ? 'error' : 'loading', games: [], eligible: [], why: {}, weights: {}, health: {} };
    return Object.assign({ catalog: 'ready', health: health.snapshot(games) }, E.evaluate(session, games));
  }
  const publicOf = (session) => publicSession(session, poolOf(session));

  // UN SEUL endroit sérialise et diffuse. Les handlers ne construisent jamais
  // un état à la main : sinon deux joueurs finissent par voir deux vérités.
  function broadcastSession(session) {
    const payload = { type: 'session', session: publicOf(session) };
    for (const p of session.players) send(session.sockets.get(p.id), payload);
  }

  // Le catalogue et la santé des serveurs concernent toutes les sessions : un
  // changement se rediffuse partout, regroupé (un réveil de sept serveurs ne
  // doit pas produire quatorze diffusions).
  let toutesPrevu = null;
  function broadcastAll() {
    if (toutesPrevu) return;
    toutesPrevu = setTimeout(() => {
      toutesPrevu = null;
      for (const s of sessions.values()) broadcastSession(s);
    }, 30);
    if (toutesPrevu.unref) toutesPrevu.unref();
  }

  // À la création d'une session, on charge le CATALOGUE (un fichier sur GitHub
  // Pages), et rien d'autre.
  // ⚠️ On ne réveille plus les sept serveurs de jeu au passage : c'était sept
  // réveils Render pour un seul jeu joué, et un jeu encore endormi se
  // retrouvait écarté du tirage. Seul le serveur du candidat tiré est vérifié.
  function chargeCatalogue() {
    catalog.load().then(() => broadcastAll(), () => broadcastAll());
  }

  function closeSession(session) {
    session.state = 'closed';
    clearTimeout(launchTimers.get(session.code));
    launchTimers.delete(session.code);
    for (const key of [...graceTimers.keys()]) {
      if (key.startsWith(session.code + '/')) {
        clearTimeout(graceTimers.get(key));
        graceTimers.delete(key);
      }
    }
    session.sockets.clear();
    sessions.delete(session.code);
  }

  // Un joueur absent est gardé un temps, puis retiré pour de bon. Deux sorties
  // possibles, et c'est la seule fonction qui décide : ou bien il restait du
  // monde et on rediffuse, ou bien la session est vide et elle disparaît.
  function dropPlayer(session, playerId) {
    S.removePlayer(session, playerId);
    session.sockets.delete(playerId);
    graceTimers.delete(session.code + '/' + playerId);
    if (!session.players.length) return closeSession(session);
    playerGone(session, playerId);
    S.electHost(session);
    broadcastSession(session);
  }

  function attach(ws, session, player) {
    // ⚠️ UN SEUL SOCKET ACTIF PAR JOUEUR. Si le même player.id revient avec une
    // nouvelle connexion, la précédente est fermée — on ne laisse pas deux
    // sockets se faire passer pour deux joueurs.
    // Le choix du « dernier arrivé gagne » est délibéré : le cas fréquent est
    // un téléphone qui a perdu le réseau et dont l'ancien socket met des
    // minutes à mourir. Refuser le nouveau rendrait le retour impossible.
    // Contrepartie assumée, à rediscuter avant la phase de handoff : quelqu'un
    // qui connaît le code ET un player.id peut évincer son propriétaire.
    const ancien = session.sockets.get(player.id);
    if (ancien && ancien !== ws) {
      send(ancien, { type: 'error', code: 'REPLACED', message: 'connexion reprise ailleurs' });
      try { ancien.close(4001, 'replaced'); } catch (_) { /* déjà fermé */ }
    }
    session.sockets.set(player.id, ws);
    ws.hub = { code: session.code, playerId: player.id };
    const key = session.code + '/' + player.id;
    if (graceTimers.has(key)) { clearTimeout(graceTimers.get(key)); graceTimers.delete(key); }
  }

  function onCreate(ws, msg) {
    if (ws.hub) return fail(ws, 'ALREADY_IN_SESSION');
    const r = readPlayer(msg.player);
    if (r.error) return send(ws, { type: 'error', code: 'BAD_PLAYER', message: r.error });

    const code = newCode((c) => sessions.has(c));
    const session = S.createSession(code, { graceMs });
    sessions.set(code, session);
    S.addPlayer(session, r.player);
    attach(ws, session, r.player);

    send(ws, { type: 'created', you: r.player.id, session: publicOf(session) });
    chargeCatalogue();
  }

  function onJoin(ws, msg) {
    if (ws.hub) return fail(ws, 'ALREADY_IN_SESSION');
    const code = normalizeCode(msg.code);
    if (!code) return fail(ws, 'BAD_CODE');
    const session = sessions.get(code);
    if (!session) return fail(ws, 'SESSION_NOT_FOUND');
    if (session.state === 'closed') return fail(ws, 'SESSION_CLOSED');

    const r = readPlayer(msg.player);
    if (r.error) return send(ws, { type: 'error', code: 'BAD_PLAYER', message: r.error });

    // Reconnexion : le même player.id est déjà dans la session. On ne crée pas
    // un doublon, on reprend sa place — préférences et capacités comprises.
    // ⚠️ Revenir ne déclenche RIEN d'autre : pas de nouveau tirage, pas de
    // changement d'état. Le tirage en cours reste celui de tout le monde.
    const connu = S.getPlayer(session, r.player.id);
    if (connu) {
      connu.name = r.player.name;
      connu.avatar = r.player.avatar;
      connu.connected = true;
      attach(ws, session, connu);
      S.electHost(session);
      send(ws, { type: 'joined', you: connu.id, session: publicOf(session) });
      return broadcastSession(session);
    }

    const add = S.addPlayer(session, r.player);
    if (add.error) return fail(ws, add.error);
    attach(ws, session, add.player);
    send(ws, { type: 'joined', you: add.player.id, session: publicOf(session) });
    broadcastSession(session);
  }

  // `leave` = départ VOLONTAIRE, à distinguer d'une coupure réseau :
  //   - le joueur est retiré tout de suite (pas de délai de grâce : il ne
  //     reviendra pas, il l'a dit) ;
  //   - s'il ne reste plus AUCUN joueur connecté — seulement des absents en
  //     délai de grâce, ou personne —, la session s'arrête immédiatement : il
  //     n'y a plus de participant volontairement présent. C'est la même règle
  //     que pour une fermeture de socket (onClose), appliquée au départ
  //     volontaire, qui gardait jusqu'ici la session 60 s pour un absent.
  // Une coupure réseau, elle, garde son délai de grâce (onClose, inchangé).
  function onLeave(ws) {
    if (!ws.hub) return fail(ws, 'NOT_IN_SESSION');
    const session = sessions.get(ws.hub.code);
    const playerId = ws.hub.playerId;
    ws.hub = null;
    if (!session) return;
    if (session.sockets.get(playerId) === ws) session.sockets.delete(playerId);
    const key = session.code + '/' + playerId;
    if (graceTimers.has(key)) { clearTimeout(graceTimers.get(key)); graceTimers.delete(key); }
    S.removePlayer(session, playerId);
    if (!S.connectedPlayers(session).length) return closeSession(session);
    playerGone(session, playerId);
    S.electHost(session);
    broadcastSession(session);
  }

  // Une fermeture de socket n'est PAS un départ : on marque absent, on réélit
  // l'hôte s'il le faut, et on laisse une fenêtre pour revenir. Mais si plus
  // personne n'est connecté, la session s'arrête tout de suite — inutile de
  // garder en mémoire un salon que personne ne regarde.
  function onClose(ws) {
    if (!ws.hub) return;
    const { code, playerId } = ws.hub;
    ws.hub = null;
    const session = sessions.get(code);
    if (!session) return;
    if (session.sockets.get(playerId) !== ws) return;   // déjà repris ailleurs

    session.sockets.delete(playerId);
    const p = S.getPlayer(session, playerId);
    if (p) p.connected = false;

    // ⚠️ Pendant un lancement ou une partie, un groupe entier peut être
    // déconnecté du Hub une seconde : chacun navigue vers le jeu, dans le même
    // onglet. On ne ferme donc PAS la session vide ; les délais de grâce
    // individuels (plus bas) s'en chargeront si personne ne revient.
    if (!S.connectedPlayers(session).length && !S.HANDOFF_STATES.includes(session.state)) return closeSession(session);

    S.electHost(session);
    broadcastSession(session);

    if (session.graceMs > 0) {
      const key = code + '/' + playerId;
      const timer = setTimeout(() => {
        graceTimers.delete(key);
        const s = sessions.get(code);
        const encore = s && S.getPlayer(s, playerId);
        if (encore && !encore.connected) dropPlayer(s, playerId);
      }, session.graceMs);
      if (timer.unref) timer.unref();   // ne pas retenir le process en vie
      graceTimers.set(key, timer);
    }
  }

  // ── Randomizer ──────────────────────────────────────────────────────────
  // L'émetteur, TOUJOURS désigné par son socket. Aucun handler ne lit un id de
  // joueur dans le message : c'est ce qui empêche d'agir au nom d'un autre.
  function me(ws) {
    if (!ws.hub) return null;
    const session = sessions.get(ws.hub.code);
    if (!session || session.sockets.get(ws.hub.playerId) !== ws) return null;
    const player = S.getPlayer(session, ws.hub.playerId);
    return player ? { session, player } : null;
  }

  // ❤️ / 🚫 : pour soi, et seulement pour soi.
  function onPrefs(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const games = catalog.get();
    const r = readPrefs(msg, games ? games.map((g) => g.id) : null);
    if (r.error) return fail(ws, 'BAD_PREFS');
    m.player.love = r.love;
    m.player.veto = r.veto;
    broadcastSession(m.session);
  }

  // « J'ai un micro », « j'accepte l'avertissement » : déclaratif, pour soi.
  function onCaps(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const r = readCaps(msg.caps);
    if (r.error) return fail(ws, 'BAD_CAPS');
    m.player.caps = Object.assign({}, m.player.caps, r.caps);
    broadcastSession(m.session);
  }

  // La durée maximale : un réglage de SESSION, donc de l'hôte.
  function onConstraints(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    if (m.session.hostId !== m.player.id) return fail(ws, 'NOT_HOST');
    const r = readConstraints(msg);
    if (r.error) return fail(ws, 'BAD_CONSTRAINTS');
    m.session.constraints = r.constraints;
    broadcastSession(m.session);
  }

  // Le tirage. Le client demande « tire le prochain jeu » ; TOUT le reste est
  // décidé ici, à partir de l'état serveur :
  //   - le nombre de joueurs relu dans session.players (jamais dans le message),
  //   - les capacités et les vetos relus sur chaque joueur,
  //   - la santé des serveurs vérifiée par un GET sur leur /health,
  //   - le hasard, cryptographique.
  //
  // ⚠️ CONCURRENCE. L'état passe à `drawing` SYNCHRONEMENT, avant le moindre
  // `await` : un second `draw` — même arrivé dans la même milliseconde — trouve
  // l'état `drawing` et reçoit DRAW_IN_PROGRESS. Il n'existe donc jamais deux
  // tirages vivants dans une session, ni deux jeux pour un même tirage.
  async function onDraw(ws) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const { session, player } = m;
    if (session.hostId !== player.id) return fail(ws, 'NOT_HOST');
    if (session.state === 'drawing') return fail(ws, 'DRAW_IN_PROGRESS');
    if (session.state !== 'lobby' && session.state !== 'debrief') return fail(ws, 'DRAW_IN_PROGRESS');

    const avant = { state: session.state, draw: session.draw, launch: session.launch };
    const draw = {
      id: 'd_' + crypto.randomBytes(6).toString('hex'),
      n: session.drawCount + 1,
      status: 'pending',
      by: player.id,
      requestedAt: Date.now(),
      gameId: null, eligible: [], weights: {}, drawnAt: null,
    };
    session.state = 'drawing';
    session.draw = draw;
    session.launch = null;           // un nouveau tirage efface le lancement précédent (raté ou fini)
    broadcastSession(session);

    // Un tirage annulé rend la session exactement comme elle était.
    const annuler = (code, extra) => {
      if (sessions.get(session.code) !== session || session.draw !== draw) return;
      session.state = avant.state;
      session.draw = avant.draw;
      session.launch = avant.launch;
      fail(ws, code, extra);
      broadcastSession(session);
    };

    let games;
    try { games = await catalog.load(); }
    catch (_) { return annuler('MANIFEST_UNAVAILABLE'); }

    // ⚠️⚠️ LE TIRAGE NE DÉPEND QUE DES RÈGLES. Pas de /health, pas d'attente,
    // pas de second tirage : on tire, on révèle. C'est la correction de fond —
    // un serveur endormi (Render, plan gratuit) ne doit PAS transformer un
    // tirage parfaitement valable en « aucun serveur disponible ».
    //
    // Le réveil se fait plus tard et tout seul : après « continuer », le
    // handoff ouvre la page du jeu, et c'est ELLE qui se connecte à son
    // serveur et le réveille. Personne n'a besoin de le faire à l'avance.
    //
    // La santé reste lue (poolOf → `pool.health`) mais seulement pour
    // INFORMER : elle n'entre ni dans le filtre, ni dans le tirage.
    try {
      const res = E.draw(session, games, random);
      if (res.error) return annuler('NO_ELIGIBLE_GAME', { why: res.why });

      draw.status = 'drawn';
      draw.gameId = res.gameId;
      draw.eligible = res.eligible;
      draw.weights = res.weights;
      draw.drawnAt = Date.now();
      session.drawCount = draw.n;
      // Le tirage est définitif dès cet instant : il entre dans l'historique,
      // qui ne fait que grandir pendant toute la session.
      session.history.played.push(res.gameId);
      console.log(`[tirage] #${draw.n} ${res.gameId}`);
      broadcastSession(session);
    } catch (e) {
      // Un bug ne doit pas laisser la session bloquée en « tirage en cours ».
      console.error('[tirage]', e && e.message);
      return annuler('DRAW_FAILED');
    }
  }

  // « Continuer » : l'hôte prend acte du jeu tiré. La session revient au Hub,
  // prête pour la suite (le lancement arrivera avec le handoff) ou pour un
  // nouveau tirage — sans rien effacer.
  function onContinue(ws) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const { session, player } = m;
    if (session.hostId !== player.id) return fail(ws, 'NOT_HOST');
    if (session.state !== 'drawing' || !session.draw || session.draw.status !== 'drawn') return fail(ws, 'NOT_DRAWN');
    session.draw.status = 'confirmed';
    const games = catalog.get() || [];
    const game = games.find((g) => g.id === session.draw.gameId);
    // Un jeu qui ne sait pas être lancé par le Hub (handoff: false dans le
    // manifest) : on revient au Hub, comme avant — le jeu est tiré, pas lancé.
    if (!game || !game.handoff || !game.url) {
      session.state = 'debrief';
      return broadcastSession(session);
    }
    // Le lancement. Un serveur déjà vu mort n'est même pas tenté.
    session.launch = L.create(session, session.draw, game, Date.now(), launchOpts);
    session.state = 'launching';
    // Le serveur a été vu vivant au moment du tirage ; s'il est retombé entre
    // temps (un joueur l'a signalé), inutile d'envoyer le groupe dans le vide.
    if (health.status(game.id) === 'down') return failLaunch(session, 'SERVER_DOWN');
    armLaunchTimer(session);
    broadcastSession(session);
  }

  // ── Lancement (handoff) ─────────────────────────────────────────────────
  // Tous ces messages viennent de la page DU JEU (games/shared/hub-handoff.js),
  // qui s'est reconnectée au Hub avec le même player.id. Le Hub ne parle
  // jamais au serveur du jeu : il enregistre ce que les navigateurs déclarent,
  // et ne croit un code de room que de l'hôte du lancement.

  // Une échéance par lancement : créer la room, puis y faire entrer le groupe.
  function armLaunchTimer(session) {
    clearTimeout(launchTimers.get(session.code));
    const l = session.launch;
    if (!l || (l.stage !== 'create' && l.stage !== 'join')) return launchTimers.delete(session.code);
    const t = setTimeout(() => {
      launchTimers.delete(session.code);
      if (sessions.get(session.code) !== session || session.launch !== l) return;
      if (l.stage === 'create') return failLaunch(session, 'LAUNCH_TIMEOUT');
      if (l.stage === 'join') { L.applyPlaying(l); session.state = 'inGame'; broadcastSession(session); }
    }, Math.max(0, l.deadline - Date.now()));
    if (t.unref) t.unref();
    launchTimers.set(session.code, t);
  }

  // Un lancement raté ramène TOUJOURS le groupe au salon, avec la raison.
  // Rien n'est effacé : le tirage reste dans l'historique, et l'hôte peut
  // retirer tout de suite.
  function failLaunch(session, reason) {
    const l = session.launch;
    if (!l) return;
    clearTimeout(launchTimers.get(session.code));
    launchTimers.delete(session.code);
    L.fail(l, reason);
    session.state = 'lobby';
    S.electHost(session);
    broadcastSession(session);
  }

  // Tous ceux qu'on attendait sont entrés : la partie est lancée.
  function maybePlaying(session) {
    const l = session.launch;
    if (l && l.stage === 'join' && !L.waiting(l).length) {
      L.applyPlaying(l);
      session.state = 'inGame';
      armLaunchTimer(session);
    }
  }

  // Un joueur quitte la session (volontairement, ou fin de sa grâce).
  function playerGone(session, playerId) {
    const l = session.launch;
    if (!l || !S.HANDOFF_STATES.includes(session.state)) return;
    // L'hôte part avant d'avoir créé la room : personne d'autre ne peut la
    // créer à sa place (seul le porteur du lancement le peut). On libère le
    // groupe, qui a un nouvel hôte et peut retirer.
    if (l.stage === 'create' && playerId === l.hostId) return failLaunch(session, 'HOST_LEFT');
    L.forget(l, playerId);
    maybePlaying(session);
  }

  // L'hôte a créé la room et en déclare le code.
  function onLaunched(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const { session, player } = m;
    const l = session.launch;
    const r = L.checkLaunched(l, player.id, msg, Date.now());
    if (r.error) return fail(ws, r.error);
    L.applyLaunched(l, r.code, Date.now(), launchOpts);
    maybePlaying(session);
    armLaunchTimer(session);
    broadcastSession(session);
  }

  // Un joueur est entré dans LA room du lancement.
  function onEntered(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const { session, player } = m;
    const l = session.launch;
    const r = L.checkEntered(l, player.id, msg);
    if (r.error) return fail(ws, r.error);
    L.applyEntered(l, player.id);
    maybePlaying(session);
    broadcastSession(session);
  }

  // L'hôte a démarré la partie sans attendre tout le monde.
  function onStarted(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const l = m.session.launch;
    if (!l || !msg || msg.drawId !== l.drawId) return fail(ws, 'LAUNCH_MISMATCH');
    if (m.player.id !== l.hostId) return fail(ws, 'NOT_HOST');
    if (l.stage === 'playing') return;
    if (l.stage !== 'join') return fail(ws, 'NOT_LAUNCHING');
    L.applyPlaying(l);
    m.session.state = 'inGame';
    armLaunchTimer(m.session);
    broadcastSession(m.session);
  }

  // La partie est finie : retour au Hub, prêt pour le tirage suivant. Pas de
  // score de soirée à cette phase — c'est ici qu'il viendra se brancher.
  function onEnded(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const { session, player } = m;
    const l = session.launch;
    if (!l || !msg || msg.drawId !== l.drawId) return fail(ws, 'LAUNCH_MISMATCH');
    if (player.id !== l.hostId && player.id !== session.hostId) return fail(ws, 'NOT_HOST');
    if (!S.HANDOFF_STATES.includes(session.state)) return;
    clearTimeout(launchTimers.get(session.code));
    launchTimers.delete(session.code);
    l.stage = 'ended';
    session.state = 'debrief';
    S.electHost(session);
    broadcastSession(session);
  }

  // Quelque chose a échoué côté jeu. L'hôte qui ne peut pas créer la room
  // fait échouer le lancement ; un invité qui ne peut pas entrer n'échoue que
  // pour lui (on ne laisse pas un invité annuler la partie des autres).
  // « Injoignable » écarte en plus le jeu des tirages le temps d'un down.
  function onAbort(ws, msg) {
    const m = me(ws);
    if (!m) return fail(ws, 'NOT_IN_SESSION');
    const { session, player } = m;
    const l = session.launch;
    if (!l || !msg || msg.drawId !== l.drawId) return fail(ws, 'LAUNCH_MISMATCH');
    if (l.stage !== 'create' && l.stage !== 'join') return fail(ws, 'NOT_LAUNCHING');
    // L'hôte change d'avis : il annule, le groupe revient au salon et peut
    // retirer tout de suite (sans attendre l'échéance du lancement).
    if (msg.reason === 'CANCELLED') {
      if (player.id !== l.hostId && player.id !== session.hostId) return fail(ws, 'NOT_HOST');
      return failLaunch(session, 'CANCELLED');
    }
    const reason = msg.reason === 'UNREACHABLE' ? 'UNREACHABLE' : 'CREATE_FAILED';
    if (reason === 'UNREACHABLE' && health.markDown) health.markDown(l.gameId);
    if (player.id === l.hostId && l.stage === 'create') return failLaunch(session, reason);
    if (player.id !== l.hostId) {
      l.failed[player.id] = typeof msg.detail === 'string' ? msg.detail.slice(0, 120) : reason;
      maybePlaying(session);
      return broadcastSession(session);
    }
    fail(ws, 'NOT_LAUNCHING');
  }

  function onMessage(ws, raw) {
    const r = parse(raw);
    if (r.error) {
      fail(ws, r.error);
      if (r.error === 'TOO_BIG') { try { ws.close(4009, 'too big'); } catch (_) {} }
      return;
    }
    const a = r.msg.action;
    if (a === 'create') return onCreate(ws, r.msg);
    if (a === 'join') return onJoin(ws, r.msg);
    if (a === 'leave') return onLeave(ws);
    if (a === 'prefs') return onPrefs(ws, r.msg);
    if (a === 'caps') return onCaps(ws, r.msg);
    if (a === 'constraints') return onConstraints(ws, r.msg);
    if (a === 'draw') return onDraw(ws);
    if (a === 'continue') return onContinue(ws);
    if (a === 'launched') return onLaunched(ws, r.msg);
    if (a === 'entered') return onEntered(ws, r.msg);
    if (a === 'started') return onStarted(ws, r.msg);
    if (a === 'ended') return onEnded(ws, r.msg);
    if (a === 'abort') return onAbort(ws, r.msg);
  }

  function connection(ws) {
    ws.hub = null;
    ws.isAlive = true;
    connections.add(ws);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      ws.isAlive = true;       // un message prouve aussi que la connexion vit
      try { onMessage(ws, raw.toString()); }
      catch (e) {
        // Un handler qui jette ne doit jamais emporter le serveur avec lui.
        fail(ws, 'BAD_JSON');
      }
    });
    ws.on('close', () => { connections.delete(ws); onClose(ws); });
    ws.on('error', () => { /* le close suivra */ });
  }

  return {
    sessions, connection, broadcastSession, broadcastAll, beat, publicOf,
    // Arrête le heartbeat (tests, arrêt propre du serveur).
    stop: () => { if (heartbeat) clearInterval(heartbeat); heartbeat = null; },
    heartbeatMs,
    stats: () => ({ sessions: sessions.size,
      players: [...sessions.values()].reduce((n, s) => n + s.players.length, 0) }),
  };
}

module.exports = { createHub, HEARTBEAT_MS, LAUNCH_FAILURES };
