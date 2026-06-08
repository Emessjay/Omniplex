-- ============================================================================
-- Omniplex — initial schema (MVP mutable state)
-- ============================================================================
-- Migration naming convention: `<UTC timestamp YYYYMMDDHHMMSS>_<slug>.sql`
-- (Supabase CLI ordering). Migrations are append-only and forward-only —
-- extend the schema with NEW migration files; do not edit landed ones.
--
-- Design principle (see DESIGN.md): the procedural universe is NOT stored.
-- Static planet attributes are recomputed from hash(WORLD_SEED, coords).
-- Only MUTABLE state lives here — players, what they carry, what they've
-- changed about the world, who discovered what, and market prices.
--
-- Security model: all gameplay writes go through the server using the
-- SERVICE ROLE key, which bypasses RLS. The anon/authenticated clients get
-- READ access only, scoped by the policies below. There are intentionally
-- NO insert/update/delete policies for anon/authenticated — that denies
-- those operations to the browser while the service role still works.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto (already available on Supabase).
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- resources — static catalog of harvestable materials.
-- Seeded below; extended by later workers. Public read.
-- ----------------------------------------------------------------------------
create table if not exists public.resources (
  id          text primary key,                       -- stable slug, e.g. 'iron'
  name        text not null,
  -- rarity tier: 1 common … 5 legendary (savage/high-hazard planets carry
  -- the rarest). Kept as a small int so pricing/gen can scale off it.
  rarity      smallint not null default 1 check (rarity between 1 and 5),
  base_value  integer not null check (base_value >= 0),  -- credits per unit, baseline
  description text
);

comment on table public.resources is
  'Static catalog of harvestable resources. Seed data; service-role writes only.';

-- ----------------------------------------------------------------------------
-- players — one per authenticated user. Identity + ship + location.
-- Location is integer galaxy coordinates (sector → system → planet), matching
-- the procedural addressing scheme; nothing about the planet itself is stored.
-- ----------------------------------------------------------------------------
create table if not exists public.players (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  handle     text not null unique,
  credits    bigint not null default 1000 check (credits >= 0),
  fuel       integer not null default 100 check (fuel >= 0),
  cargo_cap  integer not null default 50 check (cargo_cap >= 0),
  -- current location (galaxy coordinates)
  sector     integer not null default 0,
  system     integer not null default 0,
  planet     integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.players is
  'One player per auth user. Authoritative state; service-role writes only.';

-- ----------------------------------------------------------------------------
-- inventory — what each player is carrying. One row per (player, resource).
-- ----------------------------------------------------------------------------
create table if not exists public.inventory (
  player_id   uuid not null references public.players (id) on delete cascade,
  resource_id text not null references public.resources (id),
  qty         integer not null default 0 check (qty >= 0),
  primary key (player_id, resource_id)
);

comment on table public.inventory is
  'Per-player resource holdings. Service-role writes only.';

-- ----------------------------------------------------------------------------
-- world_deltas — the shared, persisted mutations to the otherwise-procedural
-- world: resource depletion, claims, placed structures, etc. Keyed by a
-- canonical location key string (e.g. 's:3/y:12/p:4'); `kind` discriminates
-- the payload shape. Append-friendly; readers reduce deltas over a location.
-- ----------------------------------------------------------------------------
create table if not exists public.world_deltas (
  id           bigint generated always as identity primary key,
  location_key text not null,
  kind         text not null,                  -- 'depletion' | 'claim' | 'structure' | …
  payload      jsonb not null default '{}'::jsonb,
  player_id    uuid references public.players (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists world_deltas_location_idx
  on public.world_deltas (location_key);
create index if not exists world_deltas_location_kind_idx
  on public.world_deltas (location_key, kind);

comment on table public.world_deltas is
  'Persisted mutations to the procedural world (depletion/claims/structures), '
  'keyed by canonical location_key. Public read; service-role writes only.';

-- ----------------------------------------------------------------------------
-- discoveries — first-finder record per planet. One row per planet key; the
-- first INSERT wins (unique pk), which is how "first to discover" is awarded.
-- ----------------------------------------------------------------------------
create table if not exists public.discoveries (
  planet_key    text primary key,
  player_id     uuid not null references public.players (id) on delete cascade,
  discovered_at timestamptz not null default now()
);

create index if not exists discoveries_player_idx
  on public.discoveries (player_id);

comment on table public.discoveries is
  'First-discoverer record per planet (pk enforces first-find). Public read.';

-- ----------------------------------------------------------------------------
-- markets — resource prices. MVP uses a single global market: location_key
-- defaults to 'global'. Schema already supports per-location markets later.
-- ----------------------------------------------------------------------------
create table if not exists public.markets (
  location_key text not null default 'global',
  resource_id  text not null references public.resources (id),
  price        integer not null check (price >= 0),
  updated_at   timestamptz not null default now(),
  primary key (location_key, resource_id)
);

comment on table public.markets is
  'Resource prices (MVP: one global market). Public read; service-role writes.';

-- ============================================================================
-- Row-Level Security
-- ============================================================================
-- Enable RLS on every table. With RLS enabled and no permissive policy for a
-- given command, that command is denied to anon/authenticated. The service
-- role bypasses RLS entirely, so all gameplay writes still work server-side.

alter table public.resources    enable row level security;
alter table public.players      enable row level security;
alter table public.inventory    enable row level security;
alter table public.world_deltas enable row level security;
alter table public.discoveries  enable row level security;
alter table public.markets      enable row level security;

-- Public world / catalog / leaderboard reads: anyone (anon or authed) may read.
create policy "resources are public read"
  on public.resources for select using (true);

create policy "world deltas are public read"
  on public.world_deltas for select using (true);

create policy "discoveries are public read"
  on public.discoveries for select using (true);

create policy "markets are public read"
  on public.markets for select using (true);

-- Players: read your own full row.
create policy "players read own row"
  on public.players for select
  using (auth.uid() = user_id);

-- Inventory: read your own holdings.
create policy "players read own inventory"
  on public.inventory for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );

-- Public leaderboard view: exposes ONLY non-sensitive columns (handle,
-- credits, location) for every player, without leaking user_id via the
-- players RLS policy. `security_invoker = false` (the default for views)
-- means it runs with the view owner's rights and is not blocked by the
-- per-row players policy above. Granted to anon + authenticated for the
-- "who's online / richest" and discovery boards.
create or replace view public.leaderboard as
  select
    p.id,
    p.handle,
    p.credits,
    p.sector,
    p.system,
    p.planet,
    p.created_at
  from public.players p;

comment on view public.leaderboard is
  'Public-safe projection of players (no user_id) for leaderboards.';

grant select on public.leaderboard to anon, authenticated;

-- ============================================================================
-- Seed data — resource catalog (rarity 1 common … 5 legendary).
-- Gives downstream workers something to mine/sell immediately.
-- ============================================================================
insert into public.resources (id, name, rarity, base_value, description) values
  ('iron',      'Iron Ore',         1,    5, 'Ubiquitous structural metal.'),
  ('silica',    'Silica',           1,    4, 'Common glassy mineral; basis of electronics.'),
  ('copper',    'Copper',           2,   12, 'Conductive metal, widely useful.'),
  ('titanium',  'Titanium',         3,   40, 'Lightweight, strong; favored for hulls.'),
  ('iridium',   'Iridium',          4,  120, 'Dense, corrosion-proof rare metal.'),
  ('xenon',     'Xenon Crystal',    4,  160, 'Volatile crystal harvested from hazard worlds.'),
  ('voidstone', 'Voidstone',        5,  500, 'Legendary material from the most savage planets.')
on conflict (id) do nothing;

-- Seed a baseline global market so 'sell' has prices from day one.
insert into public.markets (location_key, resource_id, price)
  select 'global', id, base_value from public.resources
on conflict (location_key, resource_id) do nothing;
