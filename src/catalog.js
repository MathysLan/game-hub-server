// Le catalogue des jeux : le manifest du portfolio, relu depuis GitHub Pages.
//
// ⚠️ LE HUB NE RECOPIE PAS LE MANIFEST. La source de vérité est
// `data/games.js` du portfolio ; `tools/build.mjs` en génère
// `data/games.manifest.json`, publié par GitHub Pages. Le Hub va le chercher,
// exactement comme `ban-server` va chercher `games/ban/videos.json` : Mathys
// édite data/games.js, rebuild, push — aucun redéploiement Render.
//
// Deux sources possibles, dans cet ordre :
//   MANIFEST_FILE   un fichier local (tests, développement hors ligne) ;
//   MANIFEST_URL    une URL, par défaut celle de GitHub Pages.
//
// Le manifest vient d'ailleurs : il est RELU ici, jeu par jeu. Un jeu mal formé
// est écarté (et on le dit dans la console), le reste du catalogue sert quand
// même. Une version de schéma inconnue est refusée en bloc : mieux vaut ne rien
// tirer que deviner.
'use strict';

const fs = require('node:fs');
const { GAME_ID_RE } = require('./prefs.js');

const DEFAULT_URL = 'https://mathyslan.github.io/data/games.manifest.json';
const SCHEMA_VERSION = 1;
// 5 min : un jeu ajouté au portfolio apparaît dans le Hub au plus tard 5 min
// après le déploiement de Pages. Au-delà du cache, on relit.
const TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

const bornes = (v) => v && Number.isInteger(v.min) && Number.isInteger(v.max) && v.min >= 1 && v.max >= v.min;
const url = (v) => typeof v === 'string' && /^(https?|wss?):\/\/[^\s]+$/.test(v);

// Un jeu du manifest, ou null s'il est inutilisable. On ne garde que ce que le
// Hub lit — le manifest reste la référence pour le reste.
function readGame(g) {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.id !== 'string' || !GAME_ID_RE.test(g.id)) return null;
  if (g.mode !== 'online' && g.mode !== 'local') return null;
  if (!bornes(g.players) || !bornes(g.minutes)) return null;
  if (!Array.isArray(g.needs) || !g.needs.every((n) => typeof n === 'string')) return null;
  if (g.mode === 'online' && (!url(g.server) || !url(g.health))) return null;
  return {
    id: g.id,
    title: typeof g.title === 'string' ? g.title : g.id,
    emoji: typeof g.emoji === 'string' ? g.emoji : '',
    mode: g.mode,
    players: { min: g.players.min, max: g.players.max },
    minutes: { min: g.minutes.min, max: g.minutes.max },
    needs: g.needs.slice(),
    categories: Array.isArray(g.categories) ? g.categories.filter((c) => typeof c === 'string') : [],
    server: g.mode === 'online' ? g.server : null,
    health: g.mode === 'online' ? g.health : null,
    join: typeof g.join === 'string' ? g.join : null,
    content: g.content === true,
    replay: g.replay === true,
  };
}

function readManifest(json) {
  if (!json || typeof json !== 'object') throw new Error('manifest illisible');
  if (json.version !== SCHEMA_VERSION) throw new Error(`version de manifest inconnue : ${json.version}`);
  if (!Array.isArray(json.games)) throw new Error('manifest sans liste de jeux');
  const games = [];
  for (const raw of json.games) {
    const g = readGame(raw);
    if (!g) { console.warn('[catalogue] jeu écarté (mal formé) :', raw && raw.id); continue; }
    if (games.some((x) => x.id === g.id)) continue;
    games.push(g);
  }
  return games;
}

function createCatalog(options = {}) {
  const file = options.file || null;
  const src = options.url || DEFAULT_URL;
  const fetchImpl = options.fetch || globalThis.fetch;
  const ttl = options.ttlMs == null ? TTL_MS : options.ttlMs;

  let games = null, loadedAt = 0, status = 'idle', inflight = null;

  async function lire() {
    if (file) return JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(src, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // Rend le catalogue frais. En cas d'échec, l'ancien catalogue sert encore
  // (mieux vaut un catalogue d'il y a dix minutes que plus de tirage du tout) ;
  // sans ancien catalogue, l'erreur remonte.
  function load() {
    if (games && Date.now() - loadedAt < ttl) return Promise.resolve(games);
    if (inflight) return inflight;
    if (!games) status = 'loading';
    inflight = lire().then(readManifest).then((g) => {
      games = g; loadedAt = Date.now(); status = 'ready';
      return games;
    }, (e) => {
      if (games) return games;
      status = 'error';
      throw e;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    load,
    get: () => games,
    status: () => status,
    source: () => file || src,
  };
}

module.exports = { DEFAULT_URL, SCHEMA_VERSION, TTL_MS, readGame, readManifest, createCatalog };
