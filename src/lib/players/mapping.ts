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
    cargoCap: row.cargo_cap,
    sector: row.sector,
    system: row.system,
    planet: row.planet,
    createdAt: row.created_at,
  };
}
