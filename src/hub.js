// Le Hub : le magasin de sessions et le protocole WebSocket.
//
// C'est le seul fichier qui touche à la fois aux sockets et au modèle. Tout ce
// qui peut s'en passer vit ailleurs : codes.js, identity.js, session.js et
// serialize.js n'ont aucune idée qu'un réseau existe.
'use strict';

const S = require('./session.js');
const { newCode, normalizeCode } = require('./codes.js');
const { readPlayer } = require('./identity.js');
const { publicSession } = require('./serialize.js');
const { ERRORS, parse } = require('./protocol.js');

function createHub(options = {}) {
  const sessions = new Map();          // code → session
  const graceMs = options.graceMs == null ? S.GRACE_MS : options.graceMs;
  const graceTimers = new Map();       // `code/playerId` → timer

  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const fail = (ws, code) => send(ws, { type: 'error', code, message: ERRORS[code] || code });

  // UN SEUL endroit sérialise et diffuse. Les handlers ne construisent jamais
  // un état à la main : sinon deux joueurs finissent par voir deux vérités.
  function broadcastSession(session) {
    const payload = { type: 'session', session: publicSession(session) };
    for (const p of session.players) send(session.sockets.get(p.id), payload);
  }

  function closeSession(session) {
    session.state = 'closed';
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

    send(ws, { type: 'created', you: r.player.id, session: publicSession(session) });
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
    // un doublon, on reprend sa place — c'est tout ce que « reconnexion »
    // signifie à cette phase, et c'est déjà ce qui compte.
    const connu = S.getPlayer(session, r.player.id);
    if (connu) {
      connu.name = r.player.name;
      connu.avatar = r.player.avatar;
      connu.connected = true;
      attach(ws, session, connu);
      S.electHost(session);
      send(ws, { type: 'joined', you: connu.id, session: publicSession(session) });
      return broadcastSession(session);
    }

    const add = S.addPlayer(session, r.player);
    if (add.error) return fail(ws, add.error);
    attach(ws, session, add.player);
    send(ws, { type: 'joined', you: add.player.id, session: publicSession(session) });
    broadcastSession(session);
  }

  function onLeave(ws) {
    if (!ws.hub) return fail(ws, 'NOT_IN_SESSION');
    const session = sessions.get(ws.hub.code);
    const playerId = ws.hub.playerId;
    ws.hub = null;
    if (session) dropPlayer(session, playerId);
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

    if (!S.connectedPlayers(session).length) return closeSession(session);

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

  function onMessage(ws, raw) {
    const r = parse(raw);
    if (r.error) {
      fail(ws, r.error);
      if (r.error === 'TOO_BIG') { try { ws.close(4009, 'too big'); } catch (_) {} }
      return;
    }
    if (r.msg.action === 'create') return onCreate(ws, r.msg);
    if (r.msg.action === 'join') return onJoin(ws, r.msg);
    if (r.msg.action === 'leave') return onLeave(ws);
  }

  function connection(ws) {
    ws.hub = null;
    ws.on('message', (raw) => {
      try { onMessage(ws, raw.toString()); }
      catch (e) {
        // Un handler qui jette ne doit jamais emporter le serveur avec lui.
        fail(ws, 'BAD_JSON');
      }
    });
    ws.on('close', () => onClose(ws));
    ws.on('error', () => { /* le close suivra */ });
  }

  return {
    sessions, connection, broadcastSession,
    stats: () => ({ sessions: sessions.size,
      players: [...sessions.values()].reduce((n, s) => n + s.players.length, 0) }),
  };
}

module.exports = { createHub };
