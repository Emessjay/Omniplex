-- ============================================================================
-- wildlife (P5) — materials ownership + the combat-encounter state.
-- ============================================================================
-- Fleshes out the on-foot survival loop. Two additions, both forward-only and
-- idempotent:
--
--   1. `player_materials` — per-player ownership of MATERIALS (harvested flora,
--      slain-fauna parts, scavenged minerals/relics), exactly mirroring
--      `player_upgrades`: a (player_id, material_id, qty) table with a qty≥0
--      check, RLS read-own, service-role-only writes, and an atomic
--      `add_player_material(player, material, delta)` increment RPC. The
--      material *catalog* (ids, names, values) lives in code
--      (`src/lib/game/materials.ts`), so there is intentionally no FK to a DB
--      materials table and no per-row price (materials sell at a fixed value,
--      like upgrades — not in `markets`, no drift).
--
--   2. `players.encounter jsonb` — the combat state. NULL means "not in combat";
--      otherwise `{ "faunaId": text, "hp": int }` names the creature you're
--      facing and its remaining HP. Set when you meet fauna while exploring,
--      cleared on kill / flee / death.
--
-- Security model unchanged: players read their own rows; all writes go through
-- the service-role client (which bypasses RLS). No anon/authenticated write
-- policy, matching every other table.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- player_materials — how many of each material a player owns. `material_id` is a
-- code catalog id, so (like `player_upgrades.upgrade_id`) there is no FK to a DB
-- materials table.
-- ----------------------------------------------------------------------------
create table if not exists public.player_materials (
  player_id   uuid not null references public.players (id) on delete cascade,
  material_id text not null,
  qty         integer not null default 0 check (qty >= 0),
  primary key (player_id, material_id)
);

comment on table public.player_materials is
  'Per-player material ownership counts (harvested/looted/dropped goods). '
  'Catalog lives in code; service-role writes only.';

alter table public.player_materials enable row level security;

-- Players read their own material rows (same shape as the inventory/upgrade policies).
create policy "players read own materials"
  on public.player_materials for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- add_player_material — atomically adjust a material count by `p_delta`
-- (negative to sell), creating the row on first acquire. Direct mirror of
-- `add_player_upgrade`: one statement so a rapid double-submit can't lose or
-- duplicate an update, clamped at 0 with greatest(...) so a stale over-sell can
-- never drive qty negative (handlers still validate ownership first). Returns
-- the resulting quantity.
-- ----------------------------------------------------------------------------
create or replace function public.add_player_material(
  p_player uuid,
  p_material text,
  p_delta integer
) returns integer
language sql
as $$
  insert into public.player_materials (player_id, material_id, qty)
  values (p_player, p_material, greatest(0, p_delta))
  on conflict (player_id, material_id)
    do update set qty = greatest(0, public.player_materials.qty + p_delta)
  returning qty;
$$;

comment on function public.add_player_material(uuid, text, integer) is
  'Atomic material count adjustment (race-safe; clamped at 0). Returns new qty.';

-- ----------------------------------------------------------------------------
-- players.encounter — the active-combat state. NULL = not in combat; otherwise
-- { faunaId, hp }. Added idempotently; existing players default to NULL (not in
-- combat), matching a fresh spawn. RLS on `public.players` already covers reads
-- (read-own; service-role writes), and the `leaderboard` view doesn't expose the
-- column, so no policy/view change is needed.
-- ----------------------------------------------------------------------------
alter table public.players
  add column if not exists encounter jsonb;
