-- ============================================================================
-- planet-regions — add the player's current region index.
-- ============================================================================
-- The universe gained a tier beneath planets: each planet is subdivided into
-- many regions (its procedural `regionCount`), each with its own biome and
-- deposits. A player now stands in a specific region of the planet they're on
-- and `jump`s between regions. This column records that 0-based region index.
--
-- Forward-only and idempotent (`if not exists`). Existing players default to
-- region 0 — you touch down in region 0 on `warp`/`land`. RLS already covers
-- `public.players` (read-own; service-role writes), so no policy change is
-- needed. The `leaderboard` view does not expose region, so it is untouched.
-- ----------------------------------------------------------------------------

alter table public.players
  add column if not exists region integer not null default 0;
