-- ============================================================================
-- supply-market (P12b) — per-system, self-reverting buyable SUPPLY + tradeable
-- ship parts.
-- ============================================================================
-- Forward-only and idempotent. Two additions:
--
--   1. `system_supply` — the finite buyable supply of an item (a ship UPGRADE or
--      a ship PART) is now PER-SYSTEM, keyed by (location_key = systemKey,
--      item_id). Rows are LAZY: a system+item with no row reads as that item's
--      code-defined baseline (`UPGRADE_SUPPLY_BASELINE` / `PART_SUPPLY_BASELINE`
--      in `rules.ts`). Every read drifts the stored supply back toward that
--      baseline by the time since `updated_at` (the supply-side mirror of the
--      per-system price mean-reversion from P12a), so each system's stock
--      self-corrects on its own clock with NO player present. This SUPERSEDES the
--      old GLOBAL `upgrade_market` table from P9a — those rows are now inert
--      (never read or written) and left in place (forward-only; a later migration
--      may drop them).
--
--   2. `player_parts` — ship parts are now a fully tradeable commodity. Bought
--      parts ride in the player's ship "parts store" (this table), separate from
--      the resource cargo hold (`inventory`) the way `player_materials` /
--      `player_upgrades` are. `deposit`/`withdraw` bridge parts between this store
--      and a base silo (`base_storage`); `produce` still consumes parts from the
--      silo. Exactly mirrors `player_materials`.
--
-- Security model unchanged: `system_supply` is PUBLIC read (a shared market
-- signal, like `markets`/`upgrade_market`/`bases`); `player_parts` is read-own
-- (like `inventory`/`player_materials`). All writes go through the service-role
-- client (which bypasses RLS); no anon/authenticated write policy. supply & qty
-- are kept ≥ 0 by a check constraint plus the RPCs' greatest(0, ...) clamp.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- system_supply — per-system finite buyable supply of an item. `item_id` is a
-- code catalog id (an upgrade id OR a part id; they don't collide), so — like
-- `upgrade_market.upgrade_id` / `base_storage.item_id` — there is no FK to a DB
-- catalog table. Lazy rows: the absence of a row means "baseline" (resolved in
-- code on read), so most systems start rowless and a row is created on the first
-- trade there.
-- ----------------------------------------------------------------------------
create table if not exists public.system_supply (
  location_key text    not null,
  item_id      text    not null,
  supply       integer not null default 0 check (supply >= 0),
  updated_at   timestamptz not null default now(),
  primary key (location_key, item_id)
);

comment on table public.system_supply is
  'Per-system finite buyable supply per item (upgrade or ship part), keyed by '
  '(systemKey, item_id). Public read (shared market); service-role writes only. '
  'Lazy rows default to a code baseline; reads drift stored supply toward it.';

alter table public.system_supply enable row level security;

-- Public read: the supply is a shared market signal, visible to everyone.
-- No anon/authenticated write policy, so all writes go through the service role.
create policy "system supply is public read"
  on public.system_supply for select using (true);

-- ----------------------------------------------------------------------------
-- set_system_supply — atomically UPSERT a system+item's supply to an absolute
-- value, stamping `updated_at = now()`. An absolute setter (not a delta) because
-- the model is apply-on-read / persist-on-write: the handler reads the
-- reverted-toward-baseline supply (baseline when no row exists yet), applies the
-- trade, and persists the resulting absolute value here — exactly like
-- `setMarketPrice` does for per-system prices (P12a). Clamped at 0 with
-- greatest(...) so it can never go negative (handlers validate supply before
-- charging). A single statement, so a rapid double-submit can't lose the write.
-- Returns the stored supply.
-- ----------------------------------------------------------------------------
create or replace function public.set_system_supply(
  p_location text,
  p_item     text,
  p_supply   integer
) returns integer
language sql
as $$
  insert into public.system_supply (location_key, item_id, supply, updated_at)
  values (p_location, p_item, greatest(0, p_supply), now())
  on conflict (location_key, item_id)
    do update set supply = greatest(0, p_supply),
                  updated_at = now()
  returning supply;
$$;

comment on function public.set_system_supply(text, text, integer) is
  'Atomic per-system supply upsert (absolute set; clamped at 0; stamps updated_at). Returns new supply.';

-- ----------------------------------------------------------------------------
-- player_parts — per-player ownership of ship parts carried in the ship's parts
-- store (cargo). `part_id` is a code catalog id (no FK), exactly mirroring
-- `player_materials` / `player_upgrades`. Parts bought on the market land here;
-- `deposit` moves them into a base silo to be consumed by `produce`.
-- ----------------------------------------------------------------------------
create table if not exists public.player_parts (
  player_id uuid    not null references public.players (id) on delete cascade,
  part_id   text    not null,
  qty       integer not null default 0 check (qty >= 0),
  primary key (player_id, part_id)
);

comment on table public.player_parts is
  'Per-player ship-part ownership (ship cargo parts store). Catalog lives in '
  'code; read-own; service-role writes only.';

alter table public.player_parts enable row level security;

-- Players read their own part rows (same shape as the inventory/material policies).
create policy "players read own parts"
  on public.player_parts for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- add_player_part — atomically adjust a part count by `p_delta` (negative to
-- sell/deposit), creating the row on first acquire. Direct mirror of
-- `add_player_material`: one statement (race-safe), clamped at 0 with
-- greatest(...) so a stale over-sell can never drive qty negative (handlers
-- still validate ownership first). Returns the resulting quantity.
-- ----------------------------------------------------------------------------
create or replace function public.add_player_part(
  p_player uuid,
  p_part   text,
  p_delta  integer
) returns integer
language sql
as $$
  insert into public.player_parts (player_id, part_id, qty)
  values (p_player, p_part, greatest(0, p_delta))
  on conflict (player_id, part_id)
    do update set qty = greatest(0, public.player_parts.qty + p_delta)
  returning qty;
$$;

comment on function public.add_player_part(uuid, text, integer) is
  'Atomic ship-part count adjustment (race-safe; clamped at 0). Returns new qty.';
