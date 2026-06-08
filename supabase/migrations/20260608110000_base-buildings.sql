-- ============================================================================
-- base-buildings (P8a) — silos + excavators inside a base.
-- ============================================================================
-- The first half of P8: infrastructure that lives INSIDE a P7 base. Both
-- additions are forward-only and idempotent.
--
--   1. `base_buildings` — the structures in a base. Today two kinds: `silo`
--      (storage capacity) and `excavator` (passively drains the region's ore
--      into storage on `collect`). `state jsonb` carries per-building mutable
--      data — for an excavator, `{ "lastCollectedAt": <iso> }`, the timestamp
--      collection last accrued from. Like `bases`, buildings are PUBLIC READ
--      (bases are visible to others, so their buildings are too); writes go
--      through the service role only.
--
--   2. `base_storage` — per-base, per-item stored quantity (a `silo`'s contents).
--      `item_id` is a resource id for now (P8b extends it to materials/advanced
--      goods). A (base_id, item_id) row with a qty>=0 check, public read, and an
--      atomic `add_base_storage(base, item, delta)` RPC mirroring `add_inventory`
--      (clamped at 0 so a stale over-withdraw can never drive qty negative).
--
-- Production lines / advanced materials are P8b — NOT in this migration.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- base_buildings — structures inside a base. `kind` is a code-side enum
-- (`'silo' | 'excavator'`), validated by the handler; no DB enum so future
-- kinds (P8b production lines) need no migration to the type. `on delete
-- cascade` removes a base's buildings when the base is removed.
-- ----------------------------------------------------------------------------
create table if not exists public.base_buildings (
  id         uuid primary key default gen_random_uuid(),
  base_id    uuid not null references public.bases (id) on delete cascade,
  kind       text not null,
  state      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists base_buildings_base_idx on public.base_buildings (base_id);

comment on table public.base_buildings is
  'Structures inside a base (silo/excavator). Public read (bases are public); '
  'service-role writes only. state jsonb holds per-building mutable data '
  '(excavator: { lastCollectedAt }).';

alter table public.base_buildings enable row level security;

-- Public read: buildings are part of the shared-world presence, like `bases`.
-- No anon/authenticated write policy, so all writes go through the service role.
create policy "base buildings are public read"
  on public.base_buildings for select using (true);

-- ----------------------------------------------------------------------------
-- base_storage — what a base is holding (a silo's contents). One row per
-- (base, item); `qty >= 0` enforced by both the column check and the RPC's
-- greatest(0, ...) clamp. `item_id` is a code catalog id (a resource id today),
-- so there is no FK — the same pattern as inventory / player_materials.
-- ----------------------------------------------------------------------------
create table if not exists public.base_storage (
  base_id uuid not null references public.bases (id) on delete cascade,
  item_id text not null,
  qty     integer not null default 0 check (qty >= 0),
  primary key (base_id, item_id)
);

comment on table public.base_storage is
  'Per-base stored item quantities (silo contents). Public read; service-role '
  'writes only. item_id is a code catalog id (resource id for now).';

alter table public.base_storage enable row level security;

-- Public read: bases (and therefore their stores) are visible to others.
create policy "base storage is public read"
  on public.base_storage for select using (true);

-- ----------------------------------------------------------------------------
-- add_base_storage — atomically adjust a base's stored quantity of an item by
-- `p_delta` (negative to withdraw), creating the row on first deposit. Direct
-- mirror of `add_inventory` / `add_player_material`: a single statement so a
-- rapid double-submit can't lose an update, clamped at 0 with greatest(...) so a
-- stale over-withdraw can never drive qty negative (handlers still validate
-- holdings/capacity first). Returns the resulting quantity.
-- ----------------------------------------------------------------------------
create or replace function public.add_base_storage(
  p_base uuid,
  p_item text,
  p_delta integer
) returns integer
language sql
as $$
  insert into public.base_storage (base_id, item_id, qty)
  values (p_base, p_item, greatest(0, p_delta))
  on conflict (base_id, item_id)
    do update set qty = greatest(0, public.base_storage.qty + p_delta)
  returning qty;
$$;

comment on function public.add_base_storage(uuid, text, integer) is
  'Atomic base-storage adjustment (race-safe; clamped at 0). Returns new qty.';
