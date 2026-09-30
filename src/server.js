// game-hub-server — orchestrateur de session du portfolio.
//
//   npm start            démarre sur $PORT (8100 par défaut)
//   npm test             modèle, protocole, puis bout en bout
//
// Ce que ce serveur EST : un salon. Il tient un groupe d'amis, leurs identités
// et leur hôte, et rien d'autre.
//
// Ce qu'il n'est PAS, et ne doit jamais devenir : un serveur de jeu. Aucune
// règle, aucun score, aucun secret, aucun contenu. Les sept serveurs existants
// (morpion, imitation, demicercle, ban, precision, passeur, qui-ment) restent
// seuls arbitres de leurs parties.
//
//   PROFIL / JOUEURS → SESSION → SÉLECTION → (plus tard) HANDOFF → SERVEUR DE JEU
//
// Variables d'environnement :
//   PORT            8100 par défaut
//   MANIFEST_URL    le catalogue des jeux (défaut : GitHub Pages du portfolio)
//   MANIFEST_FILE   un fichier local à la place (tests, développement)
//   DATABASE_URL    Postgres des statistiques de joueur (Neon) ; absent = pas de stats
//   HUB_STATS       'memory' : statistiques en mémoire (tests), sans DATABASE_URL
//
// Ce fichier n'assemble que les morceaux ; la logique est dans src/.
'use strict';

const { WebSocketServer } = require('ws');
const { createHub } = require('./hub.js');
const { createCatalog } = require('./catalog.js');
const { createHealth } = require('./health.js');
const { createHttp } = require('./http.js');
const pkg = require('../package.json');

const PORT = process.env.PORT || 8100;

// Le catalogue est relu depuis le portfolio ; la santé des serveurs de jeu est
// vérifiée par un simple GET sur leur /health. Un changement de santé se
// rediffuse à toutes les sessions (le salon grise le jeu tout de suite).
let hub = null;
const catalog = createCatalog({ url: process.env.MANIFEST_URL, file: process.env.MANIFEST_FILE });
const health = createHealth({ onChange: () => { if (hub) hub.broadcastAll(); } });
// Statistiques de joueur : Postgres si DATABASE_URL (production, Neon), la
// mémoire si HUB_STATS=memory (tests du portfolio), rien sinon — et alors la
// soirée marche comme avant, sans statistiques.
const statsStore = process.env.DATABASE_URL ? require('./store-pg.js').createPgStore({ url: process.env.DATABASE_URL })
  : process.env.HUB_STATS === 'memory' ? require('./store-memory.js').createMemoryStore() : null;
if (!process.env.HUB_QUIET) console.log('[stats] stockage :', statsStore ? statsStore.kind : 'aucun (statistiques désactivées)');
hub = createHub({ catalog, health, statsStore });
catalog.load().catch((e) => { if (!process.env.HUB_QUIET) console.warn('[catalogue] indisponible au démarrage :', e.message); });
const server = createHttp(hub, pkg);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => hub.connection(ws));

// En test, le serveur est requis depuis le fichier de test : on écoute quand
// même (les tests ouvrent de vrais sockets), mais on ne veut pas de bannière.
server.listen(PORT, () => {
  if (!process.env.HUB_QUIET) console.log(`game-hub-server à l'écoute sur :${PORT}`);
});

module.exports = { server, wss, hub };
