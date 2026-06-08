-- ============================================================================
-- fix-add-inventory — correct the add_inventory RPC to use the safe clamped
-- pattern that the newer RPCs (add_player_upgrade, add_base_storage,
-- add_player_material, add_upgrade_supply) already follow.
-- ============================================================================
-- The OLD function did:
--
--   INSERT INTO inventory (player_id, resource_id, qty)
--   VALUES (p_player, p_resource, p_amount)
--   ON CONFLICT DO UPDATE SET qty = inventory.qty + excluded.qty
--
-- This violated the qty >= 0 CHECK constraint in two ways:
--   1. On the INSERT arm: a negative p_amount (from removeInventory) was
--      inserted literally, failing the check immediately.
--   2. On the UPDATE arm: excluded.qty carries the raw negative value, so
--      a race where the row is inserted by a concurrent session and then
--      updated by this one would also produce a negative result.
--
-- FIX: mirror the newer RPCs exactly — clamp the insert arm with greatest(0, ...)
-- and use p_amount (not excluded.qty) in the update expression so the decrement
-- is applied correctly and the result is clamped at 0, never negative.
-- ============================================================================

create or replace function public.add_inventory(
  p_player   uuid,
  p_resource text,
  p_amount   integer
) returns integer language sql as $$
  insert into public.inventory (player_id, resource_id, qty)
  values (p_player, p_resource, greatest(0, p_amount))
  on conflict (player_id, resource_id)
    do update set qty = greatest(0, public.inventory.qty + p_amount)
  returning qty;
$$;
