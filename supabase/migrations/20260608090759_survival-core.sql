-- ============================================================================
-- survival-core — the on-foot survival layer (health + embark state).
-- ============================================================================
-- A player now either rides their ship (embarked) or stands on foot in the
-- current region (disembarked). Mining happens on foot, where a planet's hazard
-- can wound you; the economy (buy/sell/fuel) and ship travel (warp/land) require
-- being aboard. Two new columns on `public.players` carry this state:
--
--   * `health`  — current hit points, 0..MAX_HEALTH (100). The CHECK keeps it
--                 non-negative; the death sequence in code restores it to full.
--   * `embarked`— true = aboard ship (the default; trading & flying enabled),
--                 false = on foot in the current region (mining enabled).
--
-- Forward-only and idempotent (`add column if not exists`). Existing players
-- become full-health and embarked, matching a fresh spawn. RLS already covers
-- `public.players` (read-own; service-role writes), and the `leaderboard` view
-- exposes neither column, so no policy/view change is needed.
-- ----------------------------------------------------------------------------

alter table public.players
  add column if not exists health integer not null default 100 check (health >= 0),
  add column if not exists embarked boolean not null default true;
