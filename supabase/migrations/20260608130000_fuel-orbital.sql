-- ============================================================================
-- fuel-orbital — split ship fuel into two pools (P2).
-- ============================================================================
-- Travel now draws on two distinct fuels:
--   * the existing `fuel` column IS regular fuel — burned moving BETWEEN
--     PLANETS within a system (`land`: takeoff + time-varying interplanetary
--     distance as planets orbit). Kept as-is.
--   * `warp_fuel` (new) — burned on the long system-and-larger `warp` jumps;
--     its cost scales only with `warpDistance`. Pricier to buy than regular
--     fuel.
--
-- Forward-only and idempotent (`add column if not exists`). Existing players
-- get a full tank (matching a fresh spawn's default). RLS already covers
-- `public.players` (read-own; service-role writes), and the `leaderboard` view
-- exposes neither fuel column, so no policy/view change is needed.
-- ----------------------------------------------------------------------------

alter table public.players
  add column if not exists warp_fuel integer not null default 100 check (warp_fuel >= 0);
