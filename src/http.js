// Le serveur HTTP : le strict nécessaire pour savoir si le Hub répond.
//
// Pas de tableau de bord, pas d'API. Render a besoin d'une réponse HTTP pour
// son health check, et un humain a besoin de savoir en une requête si le
// service est réveillé — c'est tout ce qu'il y a ici.
//
// Le format JSON reprend celui que `precision-server` sert déjà sur `/` :
// `{ ok, service, rooms }`. C'est aussi la forme proposée dans la revue de
// conception pour les sept serveurs de jeu (`{ ok, game, protocolVersion,
// serverVersion }`), en attendant qu'ils l'adoptent.
'use strict';

const { createServer } = require('node:http');

// Version du PROTOCOLE du Hub, pas du paquet. Elle changera le jour où un
// client à jour ne pourra plus parler à un serveur ancien — pas à chaque
// correctif.
const PROTOCOL_VERSION = 1;

function createHttp(hub, pkg) {
  return createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj, null, 2) + '\n');
    };

    if (url === '/health' || url === '/') {
      const s = hub.stats();
      return json({
        ok: true,
        service: 'game-hub-server',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: pkg.version,
        sessions: s.sessions,
        players: s.players,
        uptimeSec: Math.round(process.uptime()),
      });
    }
    json({ ok: false, error: 'not found' }, 404);
  });
}

module.exports = { createHttp, PROTOCOL_VERSION };
