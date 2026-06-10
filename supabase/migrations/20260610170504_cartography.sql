-- ============================================================================
-- cartography (Keystone 3b) — an exploration rank that climbs as you chart
-- worlds. Forward-only and idempotent.
-- ============================================================================
-- Gives exploration a progression LADDER (the explorer's analogue of faction
-- ranks for traders). Each FIRST-discovery of a planet — the once-only gate in
-- `world.recordDiscovery` that also pays the `DISCOVERY_BOUNTY` — increments the
-- discoverer's `players.charted`, which maps (purely, in `cartography.ts`) to a
-- cartography rank/title shown in the `cartography` command, the first-discovery
-- scan message, and the public leaderboard / `who`.
--
-- Forward-only per the project convention: a NEW migration recreating the
-- leaderboard view (we never edit a landed one — see addressing-overhaul). No
-- retroactive backfill: `charted` starts at 0 for everyone and only grows on
-- discoveries made after this lands.
-- ============================================================================

-- 1. The charted counter. Default 0, never negative (mirrors the survival/fuel
--    columns); existing players start at 0 (no backfill, forward-only).
alter table public.players
  add column if not exists charted integer not null default 0 check (charted >= 0);

-- 2. Atomic charted increment — the explorer's analogue of `add_player_credits`.
--    Called inside the first-discovery gate (exactly once per planet) so two
--    simultaneous first-discoveries by the same player can't lose an increment.
--    Returns the new charted count (so the handler can surface the rank-up).
create or replace function public.add_charted(
  p_player uuid,
  p_delta integer
) returns integer
language sql
as $$
  update public.players
     set charted = charted + p_delta
   where id = p_player
  returning charted;
$$;

comment on function public.add_charted(uuid, integer) is
  'Atomic worlds-charted increment (race-safe). Returns new charted count.';

-- 3. Recreate the public-safe leaderboard view to ADD `charted` (the explorer
--    ranking signal), preserving every existing column. Still NO user_id — the
--    title is derived render-side from `charted` (cartography.ts), so the view
--    only needs the raw count. Same grants. Idempotent via create-or-replace.
create or replace view public.leaderboard as
  select
    p.id,
    p.handle,
    p.credits,
    p.charted,
    p.galaxy,
    p.arm,
    p.cluster,
    p.system,
    p.planet,
    p.created_at
  from public.players p;

comment on view public.leaderboard is
  'Public-safe projection of players (no user_id) for leaderboards, incl. charted.';

grant select on public.leaderboard to anon, authenticated;
