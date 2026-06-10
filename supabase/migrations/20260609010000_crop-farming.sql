-- ============================================================================
-- crop-farming — planting plots inside a base's crop farm.
-- ============================================================================
-- Phase 2 of the industrial/agricultural expansion (after blast-furnace). A
-- crop farm (a `base_buildings.kind = 'crop_farm'` row — free-text column, no
-- migration needed for the kind itself) provides planting PLOTS. This migration
-- adds the one new table the farming loop needs: `base_plots`, one row per
-- sown crop. The crop CATALOG (ids, biomes, grow times, yields), the per-farm
-- plot count, and the `cropMature` rule all live in code (`crops.ts` /
-- `rules.ts`); the DB only persists what's planted + when.
--
-- Forward-only and idempotent.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- base_plots — a crop sown into one of a base's crop-farm plots. `crop_id` is a
-- code catalog id (see `crops.ts`), so there is NO FK — the same pattern as
-- `base_storage.item_id` / inventory / player_materials. `planted_at` is the
-- growth clock the `cropMature` rule reads. Like the other base-scoped tables
-- (`base_buildings` / `base_storage`), plots are PUBLIC READ (bases are part of
-- the shared-world presence, so their plots are too); all writes go through the
-- service role. `on delete cascade` removes a base's plots when the base is
-- removed. Plot CAPACITY is enforced in code (CROP_FARM_PLOTS × #crop_farm), so
-- there is no DB-side capacity constraint.
-- ----------------------------------------------------------------------------
create table if not exists public.base_plots (
  id         uuid primary key default gen_random_uuid(),
  base_id    uuid not null references public.bases (id) on delete cascade,
  crop_id    text not null,
  planted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists base_plots_base_idx on public.base_plots (base_id);

comment on table public.base_plots is
  'Crops sown into a base''s crop-farm plots (crop-farming). Public read (bases '
  'are public); service-role writes only. crop_id is a code catalog id (no FK); '
  'planted_at is the growth clock read by the cropMature rule.';

alter table public.base_plots enable row level security;

-- Public read: plots are part of the shared-world presence, like bases. No
-- anon/authenticated write policy, so all writes go through the service role.
create policy "base plots are public read"
  on public.base_plots for select using (true);
