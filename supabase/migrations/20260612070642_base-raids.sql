-- ============================================================================
-- base-raids (Combat-2a) — base defenses + async raiding. Forward-only,
-- idempotent, and purely ADDITIVE (one nullable column + one new table), so it
-- is prod-safe to ship ahead like notoriety / ship-repair / the manifold split.
-- ============================================================================
-- The first PvP loop: a raider fights another player's base DEFENSES (turrets /
-- shield generators) through the ship-combat resolver. A WIN loots a capped share
-- of the base's silo, knocks the defenses offline for a cooldown, and leaves an
-- aftermath log the owner sees; there is NO permanent destruction. This migration
-- adds the two pieces of state that survive a raid:
--
--   1. `bases.raided_at` — when the base was last successfully raided. Drives the
--      cooldown (`raidOnCooldown`) that keeps an offline owner from being camped,
--      AND the "defenses recharging" window. Nullable; null = never raided.
--
--   2. `public.base_raids` — the aftermath log: one row per successful raid
--      (which base, who raided it, what they took, when). Like `bases`, it is a
--      shared-world event: PUBLIC READ, service-role writes only.
-- ----------------------------------------------------------------------------

-- 1. The cooldown / last-raided clock. Nullable (existing bases were never
--    raided), additive, no backfill.
alter table public.bases
  add column if not exists raided_at timestamptz;

comment on column public.bases.raided_at is
  'When the base was last successfully raided (Combat-2a). Drives the raid '
  'cooldown (raidOnCooldown) + the defenses-recharging window. Null = never raided.';

-- 2. The aftermath log. `raider_handle` is the public-safe handle (not a user
--    id), `loot` the jsonb summary of what was taken. `on delete cascade` clears
--    a base's raid history when the base is removed.
create table if not exists public.base_raids (
  id            uuid primary key default gen_random_uuid(),
  base_id       uuid not null references public.bases (id) on delete cascade,
  raider_handle text not null,
  loot          jsonb not null default '[]'::jsonb,
  raided_at     timestamptz not null default now()
);

create index if not exists base_raids_base_idx on public.base_raids (base_id);

comment on table public.base_raids is
  'Aftermath log of successful base raids (Combat-2a). Public read (a shared-world '
  'event, like bases); service-role writes only. loot is a jsonb [{itemId,qty}].';

alter table public.base_raids enable row level security;

-- Public read: a raid is shared-world news, like a base. No anon/authenticated
-- write policy, so all writes go through the service role.
create policy "base raids are public read"
  on public.base_raids for select using (true);
