-- ============================================================================
-- ship-piracy (Combat-2b) — co-located player piracy + the Mercenary Charter.
-- Forward-only, idempotent, and purely ADDITIVE (one nullable column + one new
-- table), so it is prod-safe to ship ahead like notoriety / ship-repair / the
-- manifold split / base-raids.
-- ============================================================================
-- The PvP loop: a pirate attacks a co-located player's ship, resolved
-- asynchronously against that player's stored snapshot through the ship-combat
-- resolver. A WIN loots a capped share of the victim's CARGO (credits are safe),
-- disables their ship in place (they repair on return — NOT relocated), and
-- leaves an aftermath log the victim sees on their next session; there is NO
-- permanent destruction. This migration adds the two pieces of state a piracy
-- leaves behind:
--
--   1. `players.pirated_at` — when this player was last successfully pirated.
--      Drives the per-victim cooldown (`piracyOnCooldown`) that keeps an offline
--      victim from being camped. Nullable; null = never pirated.
--
--   2. `public.piracy_log` — the aftermath log: one row per successful piracy
--      (who was robbed, who robbed them, what was taken, when). Unlike the
--      shared-world `base_raids` (public read), a robbery in transit is PRIVATE
--      to the VICTIM: RLS READ-OWN (the victim reads attacks on themselves);
--      service-role writes only.
-- ----------------------------------------------------------------------------

-- 1. The per-victim cooldown / last-pirated clock. Nullable (existing players
--    were never pirated), additive, no backfill.
alter table public.players
  add column if not exists pirated_at timestamptz;

comment on column public.players.pirated_at is
  'When this player was last successfully pirated (Combat-2b). Drives the '
  'per-victim piracy cooldown (piracyOnCooldown). Null = never pirated.';

-- 2. The aftermath log. `victim_id` is the robbed player (read-own);
--    `attacker_handle` the public-safe handle of the pirate; `loot` the jsonb
--    summary of cargo taken. `on delete cascade` clears a player's piracy
--    history when the player row is removed.
create table if not exists public.piracy_log (
  id              uuid primary key default gen_random_uuid(),
  victim_id       uuid not null references public.players (id) on delete cascade,
  attacker_handle text not null,
  loot            jsonb not null default '[]'::jsonb,
  attacked_at     timestamptz not null default now()
);

create index if not exists piracy_log_victim_idx on public.piracy_log (victim_id);

comment on table public.piracy_log is
  'Aftermath log of successful ship piracies (Combat-2b). Read-OWN (the victim '
  'reads attacks on themselves); service-role writes only. loot is a jsonb '
  '[{itemId,qty}] of the cargo taken (credits are never stolen).';

alter table public.piracy_log enable row level security;

-- Read-own: a victim reads the piracies committed against THEM (the same shape
-- as the inventory / completed_bounties / player_modules read-own policies). No
-- anon/authenticated write policy, so all writes go through the service role.
create policy "players read own piracy log"
  on public.piracy_log for select
  using (
    victim_id in (select id from public.players where user_id = auth.uid())
  );
