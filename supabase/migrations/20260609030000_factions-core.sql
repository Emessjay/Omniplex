-- ============================================================================
-- factions-core (Keystone 1a) — NPC factions, contracts, reputation.
-- ============================================================================
-- Forward-only and idempotent. Adds the DEMAND side of the economy: two
-- per-player tables tracking standing with the (code-catalog) factions and which
-- procedurally-generated contracts a player has already fulfilled.
--
--   1. `player_reputation` — a player's standing with each faction. Grows when a
--      contract is fulfilled. Faction ids are a CODE catalog (`factions.ts`), so
--      there's no FK to a DB table (mirrors `player_parts.part_id` /
--      `player_materials.material_id`). Read-OWN (per-player, like `players` /
--      `inventory`); service-role writes only. rep is kept ≥ 0 by a check
--      constraint plus the RPC's greatest(0, ...) clamp.
--
--   2. `completed_contracts` — which contracts a player has already fulfilled.
--      Contracts are procedurally generated per (hub, time-bucket) and ROTATE
--      (only completion persists). The composite PK (player_id, contract_key)
--      makes a contract once-per-instance: re-fulfilling the SAME contract key is
--      a no-op (the insert conflicts), but a fresh bucket yields fresh keys so
--      the loop is repeatable across rotations. Read-OWN; service-role writes.
--
-- Security model mirrors the existing per-player stores: read-own RLS, all
-- writes through the service-role client (which bypasses RLS); no anon/
-- authenticated write policy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- player_reputation — per-player standing with each faction. `faction_id` is a
-- code catalog id (no FK). Direct mirror of `player_parts` / `player_materials`.
-- ----------------------------------------------------------------------------
create table if not exists public.player_reputation (
  player_id  uuid    not null references public.players (id) on delete cascade,
  faction_id text    not null,
  rep        integer not null default 0 check (rep >= 0),
  primary key (player_id, faction_id)
);

comment on table public.player_reputation is
  'Per-player faction reputation. Faction catalog lives in code; read-own; '
  'service-role writes only. Grows when contracts are fulfilled.';

alter table public.player_reputation enable row level security;

-- Players read their own reputation rows (same shape as the inventory policy).
create policy "players read own reputation"
  on public.player_reputation for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- add_reputation — atomically adjust a player's standing with a faction by
-- `p_delta` (positive on fulfill), creating the row on first gain. Direct mirror
-- of `add_player_part`: one statement (race-safe), clamped at 0 with
-- greatest(...) so it can never go negative. Returns the resulting reputation.
-- ----------------------------------------------------------------------------
create or replace function public.add_reputation(
  p_player  uuid,
  p_faction text,
  p_delta   integer
) returns integer
language sql
as $$
  insert into public.player_reputation (player_id, faction_id, rep)
  values (p_player, p_faction, greatest(0, p_delta))
  on conflict (player_id, faction_id)
    do update set rep = greatest(0, public.player_reputation.rep + p_delta)
  returning rep;
$$;

comment on function public.add_reputation(uuid, text, integer) is
  'Atomic faction-reputation adjustment (race-safe; clamped at 0). Returns new rep.';

-- ----------------------------------------------------------------------------
-- completed_contracts — which procedurally-generated contracts a player has
-- already fulfilled. `contract_key` is the deterministic contract id from
-- `factions.contractsAt` (`<locationKey>|<bucket>|<slot>`); no FK (contracts
-- aren't a stored table). The composite PK enforces once-per-instance: a double-
-- fulfill of the same key conflicts (no-op), but contracts rotate per bucket so
-- fresh keys are fulfillable again.
-- ----------------------------------------------------------------------------
create table if not exists public.completed_contracts (
  player_id    uuid        not null references public.players (id) on delete cascade,
  contract_key text        not null,
  completed_at timestamptz not null default now(),
  primary key (player_id, contract_key)
);

comment on table public.completed_contracts is
  'Which procedurally-generated faction contracts a player has fulfilled. '
  'Read-own; service-role writes only. PK enforces once-per-instance.';

alter table public.completed_contracts enable row level security;

-- Players read their own completion rows.
create policy "players read own completed contracts"
  on public.completed_contracts for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );
