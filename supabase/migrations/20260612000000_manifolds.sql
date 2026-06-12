-- ============================================================================
-- manifolds — a NEW top coordinate tier above galaxy (a pure DATA PARTITION).
-- ============================================================================
-- The spatial hierarchy grows from
--   galaxy → arm → cluster → system → planet → region
-- into
--   manifold → galaxy → arm → cluster → system → planet → region.
--
-- A `manifold` is a PARALLEL DATA LAYER of the same procedurally-generated
-- universe: generation is manifold-INVARIANT (the generator never seeds an RNG
-- with `manifold`, so manifold −1 produces byte-identical worlds to manifold 0),
-- but every stored row keys by manifold and there is NO travel between manifolds
-- — so a manifold is an airtight isolated slice of the universe inside the SAME
-- Supabase project. Prod lives in manifold 0; the staging/test universe is −1.
--
-- This mirrors `addressing-overhaul` (which added galaxy/arm and renamed
-- sector→cluster): a new outer coordinate tier + a one-time prefix of every
-- existing location key so prior data resolves under manifold 0.
--
-- Coordinate KEYS gain a leading `manifold` segment, so segment counts shift up
-- by one (system 4→5, planet 5→6, region 6→7). Existing keys were minted under
-- the manifold-less scheme; prefixing them with `0:` reinterprets them as
-- manifold 0 so prior depletion / discoveries / bases / salvage / markets /
-- supply keep resolving under the new parser. `markets.location_key = 'global'`
-- is an INERT non-coordinate sentinel (pre-P12) and is left untouched.
--
-- Forward-only and tracked in `schema_migrations`, so the data rewrites run
-- EXACTLY ONCE; the structural steps are additionally guarded (`if not exists`)
-- so the file is safe to re-apply.
-- ----------------------------------------------------------------------------

-- 1. The manifold column. Default 0 = the prime universe (prod); every existing
--    player becomes manifold 0. Mirrors the galaxy/arm additions in
--    addressing-overhaul. New players take their manifold from
--    `OMNIPLEX_SPAWN_MANIFOLD` (the app stamps it on insert; staging sets −1).
alter table public.players
  add column if not exists manifold integer not null default 0;

-- 2. Reinterpret existing coordinate keys under manifold 0 by prefixing them
--    with `0:`. Runs exactly once (schema_migrations-tracked). Each of these
--    columns holds a `systemKey`/`planetKey`/`regionKey` produced by the
--    generator, so the prefix lands them in the manifold-0 partition.
update public.world_deltas
   set location_key = '0:' || location_key;

update public.discoveries
   set planet_key = '0:' || planet_key;

update public.bases
   set region_key = '0:' || region_key;

update public.salvaged_sites
   set region_key = '0:' || region_key;

-- markets: per-system rows are systemKeys; the literal 'global' is the inert
-- pre-P12 sentinel (NOT a coordinate) and must stay as-is.
update public.markets
   set location_key = '0:' || location_key
 where location_key <> 'global';

-- system_supply: every row is keyed by a systemKey (no sentinel).
update public.system_supply
   set location_key = '0:' || location_key;

-- 3. Completion-tracking keys embed a hub `systemKey` inside `<hub>|<bucket>|
--    <slot>` (`completed_contracts.contract_key` / `completed_bounties.
--    bounty_key`). Rather than surgically rewrite the embedded hub portion, we
--    RESET completion tracking (truncate): it is player-scoped and purely a
--    double-fulfill guard, so clearing it is NON-DESTRUCTIVE — players simply
--    re-see the CURRENT rotation's contracts/bounties as available again (the
--    cleaner option offered by the spec). No credits/rep/items are touched.
delete from public.completed_contracts;
delete from public.completed_bounties;

-- 4. Recreate the public-safe leaderboard view to expose `manifold` so `who`
--    can scope by the viewer's manifold (test accounts never appear on prod's
--    board, and vice-versa). `manifold` is NOT identity — exposing it is
--    public-safe — and `user_id`/email stay OFF the view as always. Same grants.
--    `CREATE OR REPLACE VIEW` can only APPEND columns (Postgres rejects
--    inserting/reordering), so `manifold` goes LAST, preserving the prior column
--    order (id, handle, credits, galaxy, arm, cluster, system, planet,
--    created_at, charted) exactly — same constraint addressing-overhaul/
--    cartography hit.
create or replace view public.leaderboard as
  select
    p.id,
    p.handle,
    p.credits,
    p.galaxy,
    p.arm,
    p.cluster,
    p.system,
    p.planet,
    p.created_at,
    p.charted,
    p.manifold
  from public.players p;

comment on view public.leaderboard is
  'Public-safe projection of players (no user_id) for leaderboards, incl. charted + manifold.';

grant select on public.leaderboard to anon, authenticated;
