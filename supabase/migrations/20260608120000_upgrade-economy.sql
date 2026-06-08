-- ============================================================================
-- upgrade-economy (P9a) — a finite, player-driven market SUPPLY for upgrades.
-- ============================================================================
-- Forward-only and idempotent. Ship upgrades became MANUFACTURED goods this
-- phase (produced at a base's production line from ship parts — code change, no
-- schema), and their buyable market stock is now finite:
--
--   • `buy <upgrade>` only works while supply remains, and decrements it.
--   • `sell <upgrade>` (and manufacturing then selling) increments it.
--
-- So the only way the buyable stock GROWS is players making upgrades and selling
-- them into the shared market. The upgrade *catalog* (ids, recipes, code-derived
-- prices) still lives in code (`src/lib/game/upgrades.ts`); this table stores
-- ONLY the shared supply count, like a coarse market depth.
--
-- Security model unchanged: PUBLIC read (the supply is a shared, public market,
-- like `markets`/`bases`); all writes go through the service-role client. No
-- anon/authenticated write policy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- upgrade_market — the shared buyable supply of each upgrade. `upgrade_id` is a
-- code catalog id (no FK to a DB upgrades table, matching `player_upgrades`).
-- A `supply >= 0` check + the RPC's greatest(0, ...) clamp keep it non-negative.
-- ----------------------------------------------------------------------------
create table if not exists public.upgrade_market (
  upgrade_id text primary key,
  supply     integer not null default 0 check (supply >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.upgrade_market is
  'Shared finite buyable supply per ship upgrade. Public read (shared market); '
  'service-role writes only. buy decrements, sell/manufacture increments. '
  'Catalog (ids/recipes/prices) lives in code.';

alter table public.upgrade_market enable row level security;

-- Public read: the supply is a shared market signal, visible to everyone.
-- No anon/authenticated write policy, so all writes go through the service role.
create policy "upgrade market is public read"
  on public.upgrade_market for select using (true);

-- ----------------------------------------------------------------------------
-- add_upgrade_supply — atomically adjust an upgrade's market supply by `p_delta`
-- (negative when someone buys one off the market, positive when someone sells
-- one in), creating the row on first touch. Mirror of `add_player_upgrade` /
-- `add_base_storage`: a single statement so a rapid double-submit can't lose an
-- update, clamped at 0 with greatest(...) so a stale over-buy can never drive
-- supply negative (handlers still validate supply > 0 before charging). Stamps
-- `updated_at = now()`. Returns the resulting supply.
-- ----------------------------------------------------------------------------
create or replace function public.add_upgrade_supply(
  p_upgrade text,
  p_delta integer
) returns integer
language sql
as $$
  insert into public.upgrade_market (upgrade_id, supply, updated_at)
  values (p_upgrade, greatest(0, p_delta), now())
  on conflict (upgrade_id)
    do update set supply = greatest(0, public.upgrade_market.supply + p_delta),
                  updated_at = now()
  returning supply;
$$;

comment on function public.add_upgrade_supply(text, integer) is
  'Atomic upgrade market-supply adjustment (race-safe; clamped at 0). Returns new supply.';

-- ----------------------------------------------------------------------------
-- Seed a small starter supply for each upgrade so the market isn't bare on day
-- one. `on conflict do nothing` keeps this idempotent and never clobbers a
-- supply that players have since moved by trading. The id list MUST stay in
-- lock-step with the code catalog (`UPGRADES` in `src/lib/game/upgrades.ts`).
-- ----------------------------------------------------------------------------
insert into public.upgrade_market (upgrade_id, supply) values
  ('ablative_shields', 3),
  ('antifreeze_tanks', 3)
on conflict (upgrade_id) do nothing;
