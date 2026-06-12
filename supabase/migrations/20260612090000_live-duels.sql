-- ============================================================================
-- live-duels (Combat-3) — live, co-located PvP duels + combat-logging. Forward-
-- only, idempotent, and purely ADDITIVE (one nullable players column + one new
-- table + one function), so it is prod-safe to ship ahead like notoriety /
-- ship-repair / the manifold split / base-raids / ship-piracy.
--
-- The two-mode combat model: an ASYNC fight (Combat-1b/2a/2b) rides on the
-- existing `players.combat` jsonb; a LIVE duel keeps its server-authoritative,
-- turn-synchronized state in the shared `public.live_duels` row below, with BOTH
-- players' `players.combat` carrying a small `{kind:"duel", duelId, role}` jsonb
-- pointer (NO schema change — the column is untyped at the DB level).
-- ============================================================================

-- 1. The ONLINE heartbeat. `last_seen_at` is stamped on every command
--    (`world.touchLastSeen`); Combat-3 reads it as the conservative online
--    signal (`attack`/`pirate` a co-located target ⇒ LIVE duel only when the
--    target was recently seen; stale ⇒ the safe async-snapshot path) and to
--    corroborate a duel disconnect (silent past the grace ⇒ combat-logging).
--    Nullable + additive, no backfill (old rows read null = "never seen").
alter table public.players
  add column if not exists last_seen_at timestamptz;

comment on column public.players.last_seen_at is
  'When this player last issued a command (Combat-3 heartbeat). The conservative '
  'ONLINE signal: a recent value ⇒ a co-located attack starts a LIVE duel; stale '
  '⇒ the async snapshot fight. Also corroborates a duel disconnect. Null = never.';

-- 2. The shared, server-authoritative live-duel session. ONE row per active
--    duel; both participants point at it via `players.combat`. The `turn` is the
--    concurrency LOCK: a round's resolve write bumps `turn` and clears both
--    choices only if `turn` is unchanged (a CAS), so two concurrent `engage`
--    requests resolve a turn EXACTLY ONCE. The `*_stats` jsonb hold each side's
--    immutable `ShipCombatStats` snapshot (taken at duel start); the scalar
--    hull/shield/range/phase columns are the mutable per-round state the resolver
--    reads + writes; `*_debuffs` carry the pending next-round subsystem modifiers.
create table if not exists public.live_duels (
  id               uuid primary key default gen_random_uuid(),
  -- The co-location Realtime channel the duel broadcasts on (manifold-scoped:
  -- co-located ⇒ same channel ⇒ same manifold, so a duel never crosses manifolds).
  channel          text not null,
  attacker_id      uuid not null references public.players (id) on delete cascade,
  defender_id      uuid not null references public.players (id) on delete cascade,
  -- Denormalized public handles, for the combat log / broadcasts / aftermath.
  attacker_handle  text not null,
  defender_handle  text not null,
  phase            text not null default 'approach',     -- 'approach' | 'exchange'
  turn             integer not null default 0,           -- the CAS version
  range            text,                                  -- 'close' | 'mid' | 'long' | null
  attacker_stats   jsonb not null,                        -- immutable ShipCombatStats snapshot
  defender_stats   jsonb not null,
  attacker_hull    integer not null,
  attacker_shield  integer not null,
  defender_hull    integer not null,
  defender_shield  integer not null,
  attacker_debuffs jsonb not null default '{}'::jsonb,    -- {weapon?, evade?} pending next round
  defender_debuffs jsonb not null default '{}'::jsonb,
  attacker_choice  text,                                  -- this turn's maneuver, null until committed
  defender_choice  text,
  turn_deadline    timestamptz,                           -- per-turn timer (auto-pass / forfeit)
  status           text not null default 'active',        -- 'active' | 'done'
  winner_id        uuid references public.players (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists live_duels_attacker_idx on public.live_duels (attacker_id);
create index if not exists live_duels_defender_idx on public.live_duels (defender_id);

comment on table public.live_duels is
  'Shared, server-authoritative live PvP duel sessions (Combat-3). Read-'
  'PARTICIPANT (each side reads duels they are in); service-role writes only. The '
  'turn column is the resolve LOCK (a turn-CAS) so a round resolves exactly once '
  'under concurrent engage requests.';

alter table public.live_duels enable row level security;

-- Read-participant: a player reads only the duels they ATTACK or DEFEND (the
-- same shape as the inventory / piracy_log read-own policies, widened to either
-- side). No anon/authenticated write policy, so all writes go through the
-- service role (which bypasses RLS).
create policy "players read own live duels"
  on public.live_duels for select
  using (
    attacker_id in (select id from public.players where user_id = auth.uid())
    or defender_id in (select id from public.players where user_id = auth.uid())
  );

-- 3. Atomic per-turn choice recording with a compare-on-turn guard. Records the
--    role's maneuver ONLY for the current `turn` (a stale-turn submission — one
--    that arrives after the round already resolved and bumped the turn — no-ops),
--    and returns whether BOTH choices are now present so the caller knows to try
--    resolving. The actual round resolution runs in Node (it reuses the tested
--    resolveApproach/resolveExchange) and persists via a turn-CAS update, so this
--    function only does the choice write; it never resolves. Mirror of the other
--    atomic mutators (`add_notoriety` etc.).
create or replace function public.submit_duel_choice(
  p_duel   uuid,
  p_role   text,
  p_choice text,
  p_turn   integer
) returns boolean
language sql
as $$
  -- A data-modifying CTE: the UPDATE always runs, guarded on the current turn +
  -- active status (a stale-turn or finished-duel write matches no row), and its
  -- RETURNING yields the POST-update choices for THIS round. Reading the result
  -- from the CTE (not a fresh SELECT, which shares the statement snapshot and so
  -- wouldn't see the update) gives the true "both committed?" flag; an empty CTE
  -- (guard failed / unknown duel) coalesces to false. Mirror of the other atomic
  -- mutators (`add_notoriety` etc.) — pure `language sql`, no plpgsql.
  with upd as (
    update public.live_duels
       set attacker_choice = case when p_role = 'attacker' then p_choice else attacker_choice end,
           defender_choice = case when p_role = 'defender' then p_choice else defender_choice end,
           updated_at = now()
     where id = p_duel
       and turn = p_turn
       and status = 'active'
    returning attacker_choice, defender_choice
  )
  select coalesce(
    (select (attacker_choice is not null and defender_choice is not null) from upd),
    false
  );
$$;

comment on function public.submit_duel_choice(uuid, text, text, integer) is
  'Record a duel role''s maneuver for the CURRENT turn only (compare-on-turn '
  'guard). Returns whether both choices are now present. Resolution + the turn-'
  'CAS bump happen in Node; this only writes the choice.';
