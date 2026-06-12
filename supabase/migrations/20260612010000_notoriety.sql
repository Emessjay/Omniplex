-- ============================================================================
-- notoriety / heat (the shared Combat ⇄ Trade axis). Forward-only, idempotent.
-- ============================================================================
-- A single player "heat" stat that BOTH pillars feed: Combat (piracy, attacking
-- the unwanted, base raids — Combat-2) and Trade (illicit businesses, smuggling
-- — a later Trade phase), and that drives the law's response. Building it once
-- here means neither pillar re-invents it.
--
-- This migration ships the MECHANIC ONLY: the stat, its decay clock, and the
-- atomic adjust RPC. The ACTS that RAISE it call `add_notoriety` (Combat-2 /
-- Trade); there are no callers yet. Heat decays toward 0 over time (lying low),
-- realized on read off `notoriety_updated_at` — the apply-on-read / stamp-on-
-- write discipline mirroring `markets.updated_at` + `priceTowardBase`.
--
-- Heat is NOT public: it rides the existing `players` row (no new table, no RLS
-- change) and is deliberately NOT exposed on the public `leaderboard` view.
-- ============================================================================

-- 1. The heat stat. Default 0 = clean, never negative (mirrors the survival/fuel
--    columns); existing players start clean (no backfill, forward-only).
alter table public.players
  add column if not exists notoriety integer not null default 0 check (notoriety >= 0);

-- 2. The decay clock — heat cools from this timestamp on read, and any change
--    re-stamps it (mirror of `markets.updated_at`). Defaults to now() so existing
--    rows start with a sensible clock.
alter table public.players
  add column if not exists notoriety_updated_at timestamptz not null default now();

-- 3. Atomic heat adjust — the hook Combat-2 / Trade call on an illicit act.
--    Clamped at 0 (heat never goes negative) and STAMPS the decay clock so decay
--    accrues forward from this change. Returns the new value. Mirror of
--    `add_reputation` / `add_player_credits`. The caller is expected to pass a
--    delta against the already-DECAYED value (see `world.addNotoriety`), so the
--    stored row stays consistent with the apply-on-read model.
create or replace function public.add_notoriety(
  p_player uuid,
  p_delta  integer
) returns integer
language sql
as $$
  update public.players
     set notoriety = greatest(0, notoriety + p_delta),
         notoriety_updated_at = now()
   where id = p_player
  returning notoriety;
$$;

comment on function public.add_notoriety(uuid, integer) is
  'Atomic heat/notoriety adjust (clamped >= 0). Stamps notoriety_updated_at. Returns new value.';
