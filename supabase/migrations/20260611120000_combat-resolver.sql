-- ============================================================================
-- combat-resolver (Combat-1b) — interactive ship combat + PvE bounty board.
-- ============================================================================
-- Forward-only and idempotent. The CENTREPIECE of the Combat pillar: a stateful
-- turn-by-turn ship-to-ship fight, proven against a PvE bounty board. Two
-- additions:
--
--   1. `players.combat` — the active ship-combat SESSION (a JSON blob: the
--      engaged bounty + both ships' snapshotted combat profiles + live hull/
--      shield + phase). `null` when not in a ship fight. Persists across
--      reconnects so a fight resumes where it left off (the combat-logging
--      penalty is a LATER phase — Combat-3). Distinct from `players.encounter`,
--      the on-foot wildlife fight.
--
--   2. `completed_bounties` — which procedurally-generated PvE bounties a player
--      has already collected. Bounties are generated per (hub, time-bucket) and
--      ROTATE (only completion persists), keyed by the deterministic
--      `bountiesAt` key (`<hub>|<bucket>|<slot>`); no FK (not a stored table).
--      The composite PK enforces once-per-instance: re-collecting the same key
--      is a no-op (the insert conflicts), but a fresh bucket yields fresh keys.
--      Direct mirror of `completed_contracts`.
--
-- Security model mirrors the existing per-player stores: `completed_bounties` is
-- read-own (like `completed_contracts`); all writes go through the service-role
-- client (which bypasses RLS); no anon/authenticated write policy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- players.combat — the active ship-combat session, a JSON blob. Defaults to
-- null (not fighting); existing players become validly "not in a ship fight".
-- Shape is owned in code (`ShipCombat` in src/lib/players/types.ts); like
-- `players.encounter` it's transient, so no enum / FK / check on its contents.
-- ----------------------------------------------------------------------------
alter table public.players
  add column if not exists combat jsonb;

-- ----------------------------------------------------------------------------
-- completed_bounties — which procedurally-generated PvE bounties a player has
-- collected. `bounty_key` is the deterministic id from `bountiesAt`
-- (`<hubKey>|<bucket>|<slot>`); no FK (bounties aren't a stored table). The
-- composite PK enforces once-per-instance: a double-collect of the same key
-- conflicts (no-op), but bounties rotate per bucket so fresh keys are huntable
-- again. Direct mirror of `completed_contracts`.
-- ----------------------------------------------------------------------------
create table if not exists public.completed_bounties (
  player_id    uuid        not null references public.players (id) on delete cascade,
  bounty_key   text        not null,
  completed_at timestamptz not null default now(),
  primary key (player_id, bounty_key)
);

comment on table public.completed_bounties is
  'Which procedurally-generated PvE bounties a player has collected. '
  'Read-own; service-role writes only. PK enforces once-per-instance.';

alter table public.completed_bounties enable row level security;

-- Players read their own bounty-completion rows (same shape as the inventory /
-- completed_contracts policies).
create policy "players read own completed bounties"
  on public.completed_bounties for select
  using (
    player_id in (select id from public.players where user_id = auth.uid())
  );
