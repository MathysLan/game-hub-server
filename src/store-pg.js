// Stockage des statistiques dans POSTGRES (production : Neon, via DATABASE_URL).
// Même interface que store-memory.js ; les règles sont celles de stats.js,
// écrites ici en SQL (test-stats.js vérifie que les deux disent la même chose).
//
// Deux tables, préfixées `hub_` (la base peut servir à autre chose) :
//   hub_players  un id de profil + l'EMPREINTE de sa clé (jamais la clé) ;
//   hub_plays    une ligne par (tirage, joueur) : le rang du jeu tel quel, le
//                nombre de classés, combien derrière, les points de soirée.
// ⚠️ La clé primaire (draw_id, player_id) EST la protection contre les
// doublons : un classement renvoyé, même après un redémarrage du Hub (qui a
// tout oublié en mémoire), ne recompte rien — `on conflict do nothing`.
//
// Les agrégats sont calculés PAR LA BASE (group by jeu) : on ne télécharge
// jamais l'historique d'un joueur, seulement quelques lignes.
'use strict';

const SCHEMA = `
create table if not exists hub_players (
  player_id  text primary key,
  key_hash   text not null,
  created_at timestamptz not null default now()
);
create table if not exists hub_plays (
  draw_id      text not null,
  player_id    text not null references hub_players (player_id),
  session_code text not null,
  game_id      text not null,
  rank         int  not null check (rank >= 1),
  ranked       int  not null check (ranked >= 1),
  behind       int  not null check (behind >= 0),
  points       int  not null,
  played_at    timestamptz not null default now(),
  primary key (draw_id, player_id)
);
create index if not exists hub_plays_player on hub_plays (player_id);
`;

// `options.Pool` : injectable (tests) ; par défaut celui de `pg`.
function createPgStore(options = {}) {
  const Pool = options.Pool || require('pg').Pool;
  const pool = new Pool({
    connectionString: options.url,
    max: 3,                           // un petit Hub : quelques requêtes par partie
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,  // Neon endormi : ~1 s pour se réveiller
  });
  // Une connexion inactive qui tombe (Neon qui s'endort) ne doit pas faire
  // tomber le Hub : on le note, le pool en rouvre une à la demande.
  pool.on('error', (e) => { if (!process.env.HUB_QUIET) console.warn('[stats] connexion perdue :', e.message); });

  // Le schéma, créé une fois (idempotent) avant la première requête ; un échec
  // est retenté à la requête suivante.
  let pret = null;
  const schema = () => pret || (pret = pool.query(SCHEMA).catch((e) => { pret = null; throw e; }));

  return {
    kind: 'pg',
    async register(playerId, keyHash) {
      await schema();
      const r = await pool.query(
        'insert into hub_players (player_id, key_hash) values ($1, $2) on conflict (player_id) do nothing', [playerId, keyHash]);
      if (r.rowCount === 1) return 'new';
      const s = await pool.query('select key_hash from hub_players where player_id = $1', [playerId]);
      return s.rows[0] && s.rows[0].key_hash === keyHash ? 'ok' : 'mismatch';
    },
    async record(drawId, sessionCode, gameId, list) {
      if (!list.length) return 0;
      await schema();
      // Une seule requête pour toute la partie. Seuls les joueurs enregistrés
      // (clé vérifiée) arrivent ici ; le `where exists` garde la clé étrangère
      // d'une ligne orpheline sans faire échouer les autres.
      const r = await pool.query(
        `insert into hub_plays (draw_id, player_id, session_code, game_id, rank, ranked, behind, points)
         select $1, t.player_id, $2, $3, t.rank, t.ranked, t.behind, t.points
           from unnest($4::text[], $5::int[], $6::int[], $7::int[], $8::int[]) as t(player_id, rank, ranked, behind, points)
          where exists (select 1 from hub_players p where p.player_id = t.player_id)
         on conflict (draw_id, player_id) do nothing`,
        [drawId, sessionCode, gameId, list.map((p) => p.playerId), list.map((p) => p.rank), list.map((p) => p.ranked),
          list.map((p) => p.behind), list.map((p) => p.points)]);
      return r.rowCount;
    },
    async perGame(playerId) {
      await schema();
      const r = await pool.query(
        `select game_id,
                count(*)::int                                              as played,
                count(*) filter (where ranked = 1)::int                    as solo,
                count(*) filter (where rank = 1 and behind > 0)::int       as wins,
                count(*) filter (where rank <= 3 and ranked >= 2)::int     as podiums,
                min(rank) filter (where ranked >= 2)                       as best,
                coalesce(sum(points), 0)::int                              as points
           from hub_plays where player_id = $1 group by game_id`, [playerId]);
      return r.rows.map((x) => ({ gameId: x.game_id, played: x.played, solo: x.solo, wins: x.wins, podiums: x.podiums,
        best: x.best == null ? null : Number(x.best), points: x.points }));
    },
    close: () => pool.end(),
  };
}

module.exports = { createPgStore, SCHEMA };
