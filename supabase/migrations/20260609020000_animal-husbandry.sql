-- ============================================================================
-- animal-husbandry — livestock pens at a base: ranch → feed/breed → slaughter.
-- ============================================================================
-- Phase 3 (final) of the industrial/agricultural expansion (after blast-furnace
-- and crop-farming). A livestock pen (a `base_buildings.kind = 'livestock_pen'`
-- row — free-text column, no migration needed for the kind itself) holds
-- animals. This migration adds the one new table the ranching loop needs:
-- `base_livestock`, one row per (base, animal) herd, plus an atomic clamped RPC
-- to adjust head counts. The animal CATALOG (ids, biomes, feed crops, breed
-- times, products, acquire costs), the per-pen capacity, and the breed/feed
-- rules all live in code (`livestock.ts` / `rules.ts`); the DB only persists the
-- herd counts + the breed clock.
--
-- Forward-only and idempotent.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- base_livestock — a herd of one animal type at a base. `animal_id` is a code
-- catalog id (see `livestock.ts`), so there is NO FK — the same pattern as
-- `base_storage.item_id` / inventory / player_materials. `count` is clamped
-- `>= 0` by both the column check and the RPC's greatest(0, ...) clamp.
-- `last_bred_at` is the breed clock the `livestockCanBreed` rule reads. Like the
-- other base-scoped tables (`base_buildings` / `base_storage` / `base_plots`),
-- it is PUBLIC READ (bases are part of the shared-world presence, so their
-- livestock are too); all writes go through the service role. `on delete
-- cascade` removes a base's herds when the base is removed. Pen CAPACITY is
-- enforced in code (LIVESTOCK_PEN_CAPACITY × #livestock_pen), so there is no
-- DB-side capacity constraint.
-- ----------------------------------------------------------------------------
create table if not exists public.base_livestock (
  base_id      uuid not null references public.bases (id) on delete cascade,
  animal_id    text not null,
  count        integer not null default 0 check (count >= 0),
  last_bred_at timestamptz not null default now(),
  primary key (base_id, animal_id)
);

create index if not exists base_livestock_base_idx on public.base_livestock (base_id);

comment on table public.base_livestock is
  'Herds of livestock penned at a base (animal-husbandry). Public read (bases '
  'are public); service-role writes only. animal_id is a code catalog id (no '
  'FK); last_bred_at is the breed clock read by the livestockCanBreed rule.';

alter table public.base_livestock enable row level security;

-- Public read: livestock are part of the shared-world presence, like bases. No
-- anon/authenticated write policy, so all writes go through the service role.
create policy "base livestock are public read"
  on public.base_livestock for select using (true);

-- ----------------------------------------------------------------------------
-- add_livestock — atomically adjust a herd's head count by `p_delta` (negative
-- to slaughter), creating the row on first ranch. Direct mirror of
-- `add_inventory` / `add_base_storage` / `add_player_material`: a single
-- statement so a rapid double-submit can't lose an update, clamped at 0 with
-- greatest(...) so a stale over-slaughter can never drive the count negative
-- (handlers still validate ownership/capacity first). Returns the resulting
-- count. `last_bred_at` is left to its default on insert and untouched on
-- update — breed-clock stamping is a separate update (the world adapter
-- `setLivestockBred`), so feeding-to-breed advances the clock independently.
-- ----------------------------------------------------------------------------
create or replace function public.add_livestock(
  p_base uuid,
  p_animal text,
  p_delta integer
) returns integer
language sql
as $$
  insert into public.base_livestock (base_id, animal_id, count)
  values (p_base, p_animal, greatest(0, p_delta))
  on conflict (base_id, animal_id)
    do update set count = greatest(0, public.base_livestock.count + p_delta)
  returning count;
$$;

comment on function public.add_livestock(uuid, text, integer) is
  'Atomic livestock head-count adjustment (race-safe; clamped at 0). Returns new count.';
