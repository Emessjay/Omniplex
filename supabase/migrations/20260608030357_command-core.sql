-- ============================================================================
-- Omniplex — command-core: atomic mutation helpers
-- ============================================================================
-- Forward-only. The init migration created the tables; this adds SQL functions
-- the command pipeline uses for race-safe accumulation of per-player totals.
--
-- WHY: a player clicking `mine` (or `sell`) twice in quick succession issues
-- two overlapping requests. A read-modify-write of `inventory.qty` /
-- `players.credits` could lose an update. These functions push the increment
-- into a single SQL statement so the DB serializes it. Depletion is already
-- append-only (`world_deltas`), and discoveries are first-INSERT-wins via the
-- planet_key PK, so those need no helper.
--
-- Writes still happen via the service-role client, which bypasses RLS; these
-- functions exist purely for atomicity, not for privilege.
-- ============================================================================

-- Atomically add `p_amount` units of a resource to a player's cargo, creating
-- the stack on first mine. Returns the resulting quantity.
create or replace function public.add_inventory(
  p_player uuid,
  p_resource text,
  p_amount integer
) returns integer
language sql
as $$
  insert into public.inventory (player_id, resource_id, qty)
  values (p_player, p_resource, p_amount)
  on conflict (player_id, resource_id)
    do update set qty = public.inventory.qty + excluded.qty
  returning qty;
$$;

comment on function public.add_inventory(uuid, text, integer) is
  'Atomic cargo increment (race-safe under rapid mines). Returns new qty.';

-- Atomically adjust a player's credit balance by `p_amount` (negative to
-- spend). Returns the new balance. The players.credits >= 0 check constraint
-- rejects an overspend; handlers validate before calling so that never fires.
create or replace function public.add_player_credits(
  p_player uuid,
  p_amount bigint
) returns bigint
language sql
as $$
  update public.players
     set credits = credits + p_amount
   where id = p_player
  returning credits;
$$;

comment on function public.add_player_credits(uuid, bigint) is
  'Atomic credit adjustment (race-safe). Returns new balance.';
