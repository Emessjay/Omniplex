-- ============================================================================
-- Omniplex — ship-upgrades: permanent craftable/tradeable ship upgrades
-- ============================================================================
-- Forward-only. Adds per-player ownership of ship upgrades (Ablative Shields,
-- Antifreeze Tanks, …) plus an atomic increment helper, mirroring the
-- inventory model in the init + command-core migrations.
--
-- The upgrade *catalog* (ids, names, recipes, derived prices) lives in code
-- (`src/lib/game/upgrades.ts`), NOT the DB — upgrades are not in `markets`
-- and have no per-row price. This table stores only ownership counts.
--
-- Security model unchanged: players read their own rows; all writes go through
-- the service-role client (which bypasses RLS). No anon/authenticated write
-- policy, matching every other table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- player_upgrades — how many of each upgrade a player owns. Owning ≥ 1 makes
-- the upgrade's capability active (the landing gate). `upgrade_id` is a code
-- catalog id, so there is intentionally no FK to a DB upgrades table.
-- ----------------------------------------------------------------------------
create table if not exists public.player_upgrades (
  player_id  uuid not null references public.players (id) on delete cascade,
  upgrade_id text not null,
  qty        integer not null default 0 check (qty >= 0),
  primary key (player_id, upgrade_id)
);

comment on table public.player_upgrades is
  'Per-player ship-upgrade ownership counts. Catalog lives in code; '
  'service-role writes only.';

alter table public.player_upgrades enable row level security;

-- Players read their own upgrade rows (same shape as the inventory policy).
create policy "players read own upgrades"
  on public.player_upgrades for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- add_player_upgrade — atomically adjust an upgrade count by `p_delta`
-- (negative to sell), creating the row on first acquire. Mirror of
-- `add_inventory`: pushes the increment into one statement so a rapid
-- double-submit can't lose/duplicate an update. Clamps the result at 0 with
-- greatest(...) so a stale over-sell can never drive qty negative (the check
-- constraint would otherwise abort); handlers still validate ownership first.
-- Returns the resulting quantity.
-- ----------------------------------------------------------------------------
create or replace function public.add_player_upgrade(
  p_player uuid,
  p_upgrade text,
  p_delta integer
) returns integer
language sql
as $$
  insert into public.player_upgrades (player_id, upgrade_id, qty)
  values (p_player, p_upgrade, greatest(0, p_delta))
  on conflict (player_id, upgrade_id)
    do update set qty = greatest(0, public.player_upgrades.qty + p_delta)
  returning qty;
$$;

comment on function public.add_player_upgrade(uuid, text, integer) is
  'Atomic ship-upgrade count adjustment (race-safe; clamped at 0). Returns new qty.';
