-- ============================================================================
-- combat-fitting (Combat-1a) — ship modules + persisted loadouts.
-- ============================================================================
-- Forward-only and idempotent. The FITTING foundation for the Combat pillar:
-- players acquire ship modules (manufactured via `produce`, like upgrades) and
-- fit them into their ship's module slots. Two additions:
--
--   1. `player_modules` — per-player ownership of ship modules (the gear the
--      player owns, fitted or not). `module_id` is a code-catalog id (no FK),
--      exactly mirroring `player_parts` / `player_materials` / `player_upgrades`.
--
--   2. `players.loadout` — the FITTED module-id list (a JSON array of module ids,
--      order = slot order; an id may repeat if you own + fit duplicates). Bounded
--      in code to the current ship's slot count and trimmed on a ship change.
--
-- Security model unchanged: `player_modules` is read-own (like
-- `inventory`/`player_parts`); all writes go through the service-role client
-- (which bypasses RLS); no anon/authenticated write policy. qty is kept ≥ 0 by a
-- check constraint plus the RPC's greatest(0, ...) clamp.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- player_modules — per-player ownership of ship modules (the fitting gear).
-- `module_id` is a code catalog id (`src/lib/game/modules.ts`), so — like
-- `player_parts.part_id` — there is no FK to a DB catalog table.
-- ----------------------------------------------------------------------------
create table if not exists public.player_modules (
  player_id uuid    not null references public.players (id) on delete cascade,
  module_id text    not null,
  qty       integer not null default 0 check (qty >= 0),
  primary key (player_id, module_id)
);

comment on table public.player_modules is
  'Per-player ship-module ownership (the fitting gear). Catalog lives in code; '
  'read-own; service-role writes only.';

alter table public.player_modules enable row level security;

-- Players read their own module rows (same shape as the inventory/part policies).
create policy "players read own modules"
  on public.player_modules for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- add_player_module — atomically adjust a module count by `p_delta` (negative to
-- sell/consume), creating the row on first acquire. Direct mirror of
-- `add_player_part`: one statement (race-safe), clamped at 0 with greatest(...)
-- so a stale over-remove can never drive qty negative (handlers still validate
-- ownership first). Returns the resulting quantity.
-- ----------------------------------------------------------------------------
create or replace function public.add_player_module(
  p_player uuid,
  p_module text,
  p_delta  integer
) returns integer
language sql
as $$
  insert into public.player_modules (player_id, module_id, qty)
  values (p_player, p_module, greatest(0, p_delta))
  on conflict (player_id, module_id)
    do update set qty = greatest(0, public.player_modules.qty + p_delta)
  returning qty;
$$;

comment on function public.add_player_module(uuid, text, integer) is
  'Atomic ship-module count adjustment (race-safe; clamped at 0). Returns new qty.';

-- ----------------------------------------------------------------------------
-- players.loadout — the FITTED module-id list, a JSON array of module ids in
-- slot order. Defaults to the empty loadout; existing players become validly
-- "nothing fitted". Bounded + trimmed in code (to the ship's slot count).
-- ----------------------------------------------------------------------------
alter table public.players
  add column if not exists loadout jsonb not null default '[]'::jsonb;
