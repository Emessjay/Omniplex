-- base-tiers (Keystone 2c): a base has a TIER (1..MAX_BASE_TIER); `upgrade base`
-- raises it, multiplying the base's storage capacity (see `baseTierMultiplier` /
-- `baseCapacity` in src/lib/game/rules.ts). Existing bases default to tier 1, so
-- there is no behavior change until a player upgrades. Forward-only/idempotent.

alter table public.bases
  add column if not exists tier integer not null default 1 check (tier >= 1);
