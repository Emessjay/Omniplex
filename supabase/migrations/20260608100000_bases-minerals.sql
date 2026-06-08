-- ============================================================================
-- bases-minerals (P7) — player bases + more / biome-specific minerals.
-- ============================================================================
-- Opens the production track with two foundations, both forward-only and
-- idempotent:
--
--   1. `bases` — a player's claim on a region. ONE base per (player, region),
--      but multiple players may base in the same region. Unlike most game
--      tables, bases are PUBLIC READ (like `world_deltas`): other players see
--      where you've built, so the shared-world presence is visible (`scan`).
--      Writes still go through the service role only.
--
--   2. New minerals — additional resources for the catalog, several of them
--      BIOME-SPECIFIC (they only appear in regions of certain biomes; the
--      biome filtering lives in gen.ts / `mineralsForBiome`). Seeded into
--      `public.resources` + the global `markets` so they're sellable, kept in
--      lock-step with the code catalog (`src/lib/universe/resources.ts`).
--
-- Buildings INSIDE bases (excavators / silos / production lines) are P8 — this
-- migration is the base row + its visibility only.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- bases — one per (owner, region). `region_key` is the 6-segment region
-- location key (see gen.ts `regionKey`); it is a free-form coordinate string,
-- so there is no FK to a regions table (the universe is procedural, not stored).
-- ----------------------------------------------------------------------------
create table if not exists public.bases (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.players (id) on delete cascade,
  region_key text not null,
  name       text,
  created_at timestamptz not null default now(),
  unique (owner_id, region_key)
);

create index if not exists bases_region_idx on public.bases (region_key);

comment on table public.bases is
  'Player bases (one per owner+region). Public read (others see your bases); '
  'service-role writes only.';

alter table public.bases enable row level security;

-- Public read: anyone (anon or authed) may see bases — they are shared-world
-- presence, like world_deltas / discoveries. No anon/authenticated write
-- policy, so all writes go through the service role (which bypasses RLS).
create policy "bases are public read"
  on public.bases for select using (true);

-- ----------------------------------------------------------------------------
-- New minerals — extend the catalog. Several are BIOME-SPECIFIC (their `biomes`
-- restriction lives in the code catalog; the DB just needs the row + a price so
-- they're sellable). Mirrors `src/lib/universe/resources.ts` exactly; if the two
-- drift, that is a bug. `on conflict do nothing` keeps this idempotent and lets
-- the code catalog stay the source of truth for biome restrictions.
-- ----------------------------------------------------------------------------
insert into public.resources (id, name, rarity, base_value, description) values
  ('cobalt',        'Cobalt',        2,   18, 'Hard ferromagnetic metal; appears broadly.'),
  ('pyrite',        'Pyrite',        2,   28, 'Fool''s gold — surfaces only on volcanic worlds.'),
  ('verdite',       'Verdite',       2,   36, 'Green metamorphic stone of jungle regions.'),
  ('aquamarine',    'Aquamarine',    3,   85, 'Sea-blue beryl found only in oceanic regions.'),
  ('radium_salt',   'Radium Salt',   4,  130, 'Luminous salt from irradiated & toxic regions.'),
  ('prismatic_gem', 'Prismatic Gem', 4,  150, 'Refractive gem grown only in crystalline regions.')
on conflict (id) do nothing;

-- Seed the global market price for the new minerals (= base_value), so they sell
-- from day one. `select ... from resources` covers exactly the new ids (existing
-- ones already have a market row, left untouched by the conflict clause).
insert into public.markets (location_key, resource_id, price)
  select 'global', id, base_value from public.resources
on conflict (location_key, resource_id) do nothing;
