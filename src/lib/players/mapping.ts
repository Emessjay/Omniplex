/**
 * Pure mapping between the snake_case `players` DB row and the camelCase
 * `Player` TS object. Kept separate from the DB-touching bootstrap so it can
 * be unit-tested without a Supabase client.
 */
import type { Player, PlayerRow } from "./types";

/** Map a raw `public.players` row to the camelCase `Player` shape. */
export function rowToPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    userId: row.user_id,
    handle: row.handle,
    credits: row.credits,
    fuel: row.fuel,
    warpFuel: row.warp_fuel,
    cargoCap: row.cargo_cap,
    shipId: row.ship_id,
    // Defensive default for old rows / fixtures predating the column (the
    // migration backfills existing rows to 100; this keeps the mapper total).
    shipCondition: row.ship_condition ?? 100,
    manifold: row.manifold,
    galaxy: row.galaxy,
    arm: row.arm,
    cluster: row.cluster,
    system: row.system,
    planet: row.planet,
    region: row.region,
    health: row.health,
    embarked: row.embarked,
    landed: row.landed,
    encounter: row.encounter ?? null,
    charted: row.charted,
    loadout: Array.isArray(row.loadout) ? row.loadout : [],
    combat: row.combat ?? null,
    notoriety: row.notoriety,
    notorietyUpdatedAt: row.notoriety_updated_at,
    createdAt: row.created_at,
  };
}
