-- ============================================================================
-- addressing-overhaul — six-tier spatial addressing.
-- ============================================================================
-- The universe's coordinate scheme grows from (sector, system, planet, region)
-- into the six-tier hierarchy galaxy → arm → cluster → system → planet → region:
--   * `sector` is RENAMED to `cluster` (same values; it's the cluster-within-arm
--     index now).
--   * `galaxy` (unbounded, default 0) and `arm` (a ring within the galaxy,
--     default 0) are ADDED. Every existing player becomes galaxy 0 / arm 0,
--     keeping their cluster/system/planet/region.
--
-- Coordinate KEYS (`world_deltas.location_key`, `discoveries.planet_key`) gain
-- the two new leading segments. Existing keys were minted under the old
-- 2/3/4-segment scheme; prefixing them with `0:0:` reinterprets them as
-- galaxy-0 / arm-0 so prior depletion and discoveries keep resolving under the
-- new parser (a region key `c:s:p:r` → `0:0:c:s:p:r`; a planet key `c:s:p` →
-- `0:0:c:s:p`). `markets.location_key = 'global'` is NOT a coordinate, so it is
-- left untouched.
--
-- Forward-only and tracked in `schema_migrations`, so the data rewrites run
-- EXACTLY ONCE; the structural steps are additionally guarded (`if exists` /
-- `if not exists`) so the file is safe to re-apply.
-- ----------------------------------------------------------------------------

-- 1a. Rename players.sector -> players.cluster. The public.leaderboard view
--     depends on this column, so drop it first (recreated against the new
--     columns below). Guarded so a re-run is a no-op.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'players'
      and column_name = 'sector'
  ) then
    drop view if exists public.leaderboard;
    alter table public.players rename column sector to cluster;
  end if;
end $$;

-- 1b. Add the two new outer tiers. Existing rows take galaxy 0 / arm 0.
alter table public.players
  add column if not exists galaxy integer not null default 0,
  add column if not exists arm integer not null default 0;

-- 1c. Recreate the public-safe leaderboard view against the six-tier coords
--     (no user_id; same grants). Idempotent via create-or-replace.
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
    p.created_at
  from public.players p;

comment on view public.leaderboard is
  'Public-safe projection of players (no user_id) for leaderboards.';

grant select on public.leaderboard to anon, authenticated;

-- 2. Reinterpret existing coordinate keys under galaxy 0 / arm 0 by prefixing
--    them with `0:0:`. Runs exactly once (schema_migrations-tracked).
update public.world_deltas
   set location_key = '0:0:' || location_key;

update public.discoveries
   set planet_key = '0:0:' || planet_key;
