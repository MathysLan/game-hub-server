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
// ⚠️ ON NE VÉRIFIE QU'UN SEUL JEU À LA FOIS : celui que le tirage vient de
// désigner (hub.js → onDraw). Vérifier les sept avant de tirer réveillait tout
// le parc Render pour rien — et pouvait écarter des jeux parfaitement valables
// pendant leur réveil. La santé ne filtre plus le catalogue ; elle confirme (ou
// non) le candidat.
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
// Entre deux tentatives pendant un réveil : assez court pour ne pas faire
// attendre le groupe, assez long pour ne pas marteler un serveur qui démarre.
const RETRY_MS = 2_500;

function createHealth(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs == null ? TIMEOUT_MS : options.timeoutMs;
  const upTtl = options.upTtlMs == null ? UP_TTL_MS : options.upTtlMs;
  const downTtl = options.downTtlMs == null ? DOWN_TTL_MS : options.downTtlMs;
  const retryMs = options.retryMs == null ? RETRY_MS : options.retryMs;
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

  // Une tentative : 'up' sur un 2xx, sinon la raison de l'échec.
  async function tentative(game, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetchImpl(game.health, { signal: ctrl.signal, redirect: 'follow' });
      // On lit le corps pour libérer la connexion ; son contenu ne décide
      // de rien (les sept serveurs répondent en texte ou en JSON).
      if (res && res.body && typeof res.text === 'function') res.text().catch(() => {});
      return res && res.ok ? { ok: true } : { ok: false, why: 'HTTP ' + (res && res.status) };
    } catch (e) {
      const code = e && e.cause && e.cause.code;
      // Personne n'écoute, ou le nom n'existe pas : ce n'est pas un réveil, et
      // réessayer n'y changera rien. (Le proxy de Render, lui, accepte toujours
      // la connexion d'un service endormi.)
      const definitif = code === 'ECONNREFUSED' || code === 'ENOTFOUND';
      return { ok: false, definitif, why: ctrl.signal.aborted ? 'délai dépassé' : (code || (e && e.message) || 'erreur réseau') };
    } finally { clearTimeout(timer); }
  }

  // ⚠️ UN SERVEUR QUI SE RÉVEILLE N'EST PAS UN SERVEUR MORT. Mesuré en
  // production (2026-09-19) : depuis Render, un jeu endormi ne répond pas tout
  // de suite un 2xx — le Hub le déclarait « down » en moins d'une seconde, et
  // le tirage ne trouvait AUCUN jeu, alors que les mêmes URL répondaient 200
  // après 12 à 22 s vues d'ailleurs. Dans la fenêtre de `timeoutMs`, une
  // réponse non-2xx ou une erreur réseau n'est donc pas un verdict : on
  // réessaie toutes les RETRY_MS. Seule la fin de la fenêtre dit « down ».
  function check(game) {
    if (!game || !game.health) return Promise.resolve('up');     // jeu local : rien à joindre
    if (inflight.has(game.id)) return inflight.get(game.id);
    set(game.id, 'checking');
    const debut = Date.now();
    const fin = debut + timeoutMs;
    const p = (async () => {
      let r = { ok: false, why: 'aucune tentative' };
      for (let essai = 1; ; essai++) {
        const reste = fin - Date.now();
        if (reste <= 0) break;
        r = await tentative(game, reste);
        if (!options.quiet) console.log(`[santé] ${game.id} tentative=${essai} ${r.ok ? 'ok' : r.why}`);
        if (r.ok) return 'up';
        if (r.definitif) break;
        const pause = Math.min(retryMs, fin - Date.now());
        if (pause <= 0) break;
        await new Promise((ok) => setTimeout(ok, pause));
      }
      // Visible dans les journaux de Render : pourquoi ce jeu est écarté.
      if (!options.quiet) console.warn(`[santé] ${game.id} échec après ${((Date.now() - debut) / 1000).toFixed(1)} s : ${r.why}`);
      return 'down';
    })().then((s) => { inflight.delete(game.id); set(game.id, s); return s; });
    inflight.set(game.id, p);
    return p;
  }

  // UN seul jeu : son état s'il est encore frais (inutile de réveiller deux
  // fois), sinon une vraie vérification. Ne rejette jamais.
  function one(game) {
    if (!game || game.mode !== 'online') return Promise.resolve('up');
    if (frais(game.id)) return Promise.resolve(etat.get(game.id).status);
    return check(game);
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

  // Un joueur n'a pas pu joindre le serveur du jeu (depuis SON navigateur) :
  // on l'écarte des tirages le temps de DOWN_TTL_MS, comme un /health en échec.
  const markDown = (id) => set(id, 'down');

  return { check, one, status, snapshot, markDown };
}

module.exports = { TIMEOUT_MS, UP_TTL_MS, DOWN_TTL_MS, RETRY_MS, createHealth };
