// Stockage des statistiques dans POSTGRES (production : Neon, via DATABASE_URL).
// Même interface que store-memory.js ; les règles sont celles de stats.js,
// écrites ici en SQL (test-stats.js vérifie que les deux disent la même chose).
//
// Trois tables, préfixées `hub_` (la base peut servir à autre chose) :
//   hub_players  un id de profil + l'EMPREINTE de sa clé (jamais la clé) ;
//   hub_plays    une ligne par (tirage, joueur) : le rang du jeu tel quel, le
//                nombre de classés, combien derrière, les points de soirée.
//   hub_achievements  (lot J) les succès débloqués : quand, par quelle partie,
//                notification montrée ou non (voir SCHEMA_SUCCES).
// ⚠️ La clé primaire (draw_id, player_id) EST la protection contre les
// doublons : un classement renvoyé, même après un redémarrage du Hub (qui a
// tout oublié en mémoire), ne recompte rien — `on conflict do nothing`.
//
// Les agrégats sont calculés PAR LA BASE (group by jeu) : on ne télécharge
// jamais l'historique d'un joueur, seulement quelques lignes.
'use strict';

const AC = require('./achievements.js');

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

// SUCCÈS (lot J). Le Hub décide d'un succès par le rejeu des parties
// (achievements.js) ; cette table ne fait que RETENIR :
//   - le PREMIER déblocage — la clé primaire (player_id, code) décide seule, et
//     `on conflict do nothing returning code` rend exactement les nouveaux ;
//   - la partie et le moment qui l'ont débloqué (unlocked_at = played_at) ;
//   - si la notification a été MONTRÉE (notified_at) : c'est ce qui empêche
//     un rechargement, une reconnexion ou un autre onglet de la rejouer.
const SCHEMA_SUCCES = `
create table if not exists hub_achievements (
  player_id   text not null references hub_players (player_id),
  code        text not null,
  unlocked_at timestamptz not null,
  draw_id     text not null,
  notified_at timestamptz,
  primary key (player_id, code)
);
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
  // est retenté à la requête suivante. Le jour où `hub_achievements` NAÎT, les
  // succès déjà mérités (parties d'avant le lot J) y sont inscrits DANS LA MÊME
  // TRANSACTION, comme déjà notifiés : aucune notification rétroactive, et un
  // échec annule tout (table comprise), donc le rattrapage ne se fait qu'une fois.
  let pret = null;
  async function creeSchema() {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(424242)');   // un seul Hub crée à la fois
      await c.query(SCHEMA);
      const avant = await c.query(`select to_regclass('hub_achievements') as t`);
      await c.query(SCHEMA_SUCCES);
      if (avant.rows[0].t == null) {
        const ids = await c.query('select distinct player_id from hub_plays');
        let n = 0;
        for (const { player_id: id } of ids.rows) n += (await insere(c, id, AC.unlocks(await lit(c, id)), true)).length;
        if (!process.env.HUB_QUIET) console.log(`[succès] table créée, ${n} succès déjà mérités inscrits (sans notification)`);
      }
      await c.query('commit');
    } catch (e) {
      try { await c.query('rollback'); } catch (_) { /* connexion perdue */ }
      throw e;
    } finally {
      c.release();
    }
  }
  const schema = () => pret || (pret = creeSchema().catch((e) => { pret = null; throw e; }));

  // Les parties d'un joueur, pour le rejeu (index hub_plays_player).
  async function lit(q, playerId) {
    const r = await q.query(
      `select draw_id, session_code, game_id, rank, ranked, behind, played_at
         from hub_plays where player_id = $1 order by played_at, draw_id`, [playerId]);
    return r.rows.map((x) => ({ drawId: x.draw_id, sessionCode: x.session_code, gameId: x.game_id, rank: x.rank,
      ranked: x.ranked, behind: x.behind, at: new Date(x.played_at).getTime() }));
  }
  // Une seule requête ; rend les codes RÉELLEMENT insérés.
  async function insere(q, playerId, list, silent) {
    if (!list.length) return [];
    const r = await q.query(
      `insert into hub_achievements (player_id, code, unlocked_at, draw_id, notified_at)
       select $1, t.code, to_timestamp(t.at / 1000.0), t.draw_id, case when $5 then to_timestamp(t.at / 1000.0) end
         from unnest($2::text[], $3::float8[], $4::text[]) as t(code, at, draw_id)
        where exists (select 1 from hub_players p where p.player_id = $1)
       on conflict (player_id, code) do nothing
       returning code`,
      [playerId, list.map((u) => u.code), list.map((u) => u.at), list.map((u) => u.drawId), !!silent]);
    return r.rows.map((x) => x.code);
  }

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
    // ── Succès (lot J) — mêmes contrats que store-memory.js ──
    async plays(playerId) { await schema(); return lit(pool, playerId); },
    async unlock(playerId, list, silent = false) { await schema(); return insere(pool, playerId, list, silent); },
    async achievements(playerId) {
      await schema();
      const r = await pool.query('select code, unlocked_at, draw_id, notified_at from hub_achievements where player_id = $1', [playerId]);
      return r.rows.map((x) => ({ code: x.code, unlockedAt: new Date(x.unlocked_at).getTime(), drawId: x.draw_id,
        notifiedAt: x.notified_at == null ? null : new Date(x.notified_at).getTime() }));
    },
    // Notification montrée : seulement des lignes existantes, pas encore notifiées.
    async markSeen(playerId, codes) {
      if (!codes.length) return [];
      await schema();
      const r = await pool.query(
        `update hub_achievements set notified_at = now()
          where player_id = $1 and code = any($2::text[]) and notified_at is null returning code`, [playerId, codes]);
      return r.rows.map((x) => x.code);
    },
    close: () => pool.end(),
  };
}

module.exports = { createPgStore, SCHEMA, SCHEMA_SUCCES };
