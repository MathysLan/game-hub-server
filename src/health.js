// Santé des serveurs de jeu : « est-il réveillé et répond-il ? », rien de plus.
//
// ⚠️ LE HUB NE FAIT QU'UN GET SUR L'URL `health` DU MANIFEST. Il n'ouvre
// JAMAIS de WebSocket vers un serveur de jeu pour le tester : une connexion de
// jeu crée des rooms, compte des joueurs, et c'est au jeu seul de gérer sa
// partie. Le Hub orchestre, il ne joue pas.
//
// Quatre états par jeu :
//   unknown   jamais vérifié ;
//   checking  une requête est en cours (un serveur Render endormi met ~30 s
//             à répondre : ce n'est PAS une panne) ;
//   up        a répondu 2xx — valable UP_TTL_MS ;
//   down      a répondu autre chose, ou rien avant TIMEOUT_MS — le jeu est
//             écarté du tirage pendant DOWN_TTL_MS, puis on retente.
//
// Pas de surveillance en continu : on vérifie au moment où ça sert (création
// d'une session = pré-réveil, et juste avant un tirage).
'use strict';

// 40 s : un réveil Render prend ~30 s. Au-delà, on ne parle plus d'un serveur
// qui dort mais d'un serveur qui ne répond pas.
const TIMEOUT_MS = 40_000;
// 5 min : Render endort un service après 15 min sans trafic ; une réponse de
// moins de 5 min dit encore la vérité.
const UP_TTL_MS = 5 * 60_000;
// 2 min : assez pour ne pas retomber sur le même serveur mort au tirage
// suivant, assez court pour qu'un redémarrage ne l'exclue pas de la soirée.
const DOWN_TTL_MS = 2 * 60_000;

function createHealth(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs == null ? TIMEOUT_MS : options.timeoutMs;
  const upTtl = options.upTtlMs == null ? UP_TTL_MS : options.upTtlMs;
  const downTtl = options.downTtlMs == null ? DOWN_TTL_MS : options.downTtlMs;
  const onChange = options.onChange || (() => {});

  const etat = new Map();       // gameId → { status, at }
  const inflight = new Map();   // gameId → Promise

  function set(id, status) {
    const avant = etat.get(id);
    etat.set(id, { status, at: Date.now() });
    if (!avant || avant.status !== status) onChange(id, status);
  }

  function frais(id) {
    const e = etat.get(id);
    if (!e) return false;
    if (e.status === 'up') return Date.now() - e.at < upTtl;
    if (e.status === 'down') return Date.now() - e.at < downTtl;
    return false;
  }

  function check(game) {
    if (!game || !game.health) return Promise.resolve('up');     // jeu local : rien à joindre
    if (inflight.has(game.id)) return inflight.get(game.id);
    set(game.id, 'checking');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const p = Promise.resolve()
      .then(() => fetchImpl(game.health, { signal: ctrl.signal, redirect: 'follow' }))
      .then((res) => {
        // On lit le corps pour libérer la connexion ; son contenu ne décide
        // de rien (les sept serveurs répondent en texte ou en JSON).
        if (res && res.body && typeof res.text === 'function') res.text().catch(() => {});
        return res && res.ok ? 'up' : 'down';
      }, () => 'down')
      .then((s) => { clearTimeout(timer); inflight.delete(game.id); set(game.id, s); return s; });
    inflight.set(game.id, p);
    return p;
  }

  // Vérifie ce qui n'est pas frais, en parallèle, et attend. Rend l'état de
  // chaque jeu en ligne AU TERME de cette vérification : { gameId: 'up' |
  // 'down' }. Ne rejette jamais.
  function ensure(games) {
    const list = (games || []).filter((g) => g && g.mode === 'online');
    return Promise.all(list.map((g) => (frais(g.id) ? etat.get(g.id).status : check(g))))
      .then((etats) => Object.fromEntries(list.map((g, i) => [g.id, etats[i]])));
  }

  function status(id) {
    const e = etat.get(id);
    if (!e) return 'unknown';
    if (e.status === 'checking') return 'checking';
    return frais(id) ? e.status : 'unknown';
  }

  function snapshot(games) {
    const out = {};
    for (const g of games || []) if (g.mode === 'online') out[g.id] = status(g.id);
    return out;
  }

  return { check, ensure, status, snapshot };
}

module.exports = { TIMEOUT_MS, UP_TTL_MS, DOWN_TTL_MS, createHealth };
