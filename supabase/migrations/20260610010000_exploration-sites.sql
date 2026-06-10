-- ============================================================================
-- exploration-sites (Keystone 3) — findable derelicts / ruins / anomalies.
-- ============================================================================
-- Forward-only and idempotent. Adds the persistence for `salvage`: which
-- exploration sites a player has already picked clean.
--
--   `salvaged_sites` — one row per (player, salvaged region site). Sites
--   themselves are PURE & deterministic (recomputed from the seed via
--   `siteAt`/`siteLoot`; never stored), so the only state worth persisting is
--   the fact that a given player has already salvaged the site in a given
--   region. The composite PK (player_id, region_key) enforces
--   once-per-player-per-site: a second `salvage` of the same region conflicts
--   (no-op). `region_key` is the 6-segment `regionKey` (a free-form procedural
--   coord, no FK — mirrors `world_deltas.location_key`). Read-OWN (per-player,
--   like `completed_contracts` / `inventory`); service-role writes only.
--
-- Security model mirrors the existing per-player stores: read-own RLS, all
-- writes through the service-role client (which bypasses RLS); no anon/
-- authenticated write policy.
-- ============================================================================

create table if not exists public.salvaged_sites (
  player_id   uuid        not null references public.players (id) on delete cascade,
  region_key  text        not null,
  salvaged_at timestamptz not null default now(),
  primary key (player_id, region_key)
);

comment on table public.salvaged_sites is
  'Which deterministic exploration sites (per region) a player has salvaged. '
  'Sites are recomputed from the seed (siteAt/siteLoot); only salvage state is '
  'stored. Read-own; service-role writes only. PK enforces once-per-player-per-site.';

alter table public.salvaged_sites enable row level security;

-- Players read their own salvage rows (same shape as the inventory policy).
create policy "players read own salvaged sites"
  on public.salvaged_sites for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );
