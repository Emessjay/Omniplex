import "server-only";

/**
 * World-state data access — thin adapters over the authoritative (service-role)
 * Supabase client. Everything mutable lives here; the procedural universe is
 * never stored (see `src/lib/universe/`). Handlers call these; the math lives
 * in `rules.ts`.
 *
 * Concurrency notes:
 *  - Depletion is APPEND-ONLY (`world_deltas` rows), so two simultaneous mines
 *    can never lose a delta — readers sum them. No read-modify-write.
 *  - Inventory and credits use the atomic `add_inventory` / `add_player_credits`
 *    SQL functions (see `*_command-core.sql`) so a fast double-click can't
 *    corrupt a total.
 *  - Market price and the player's fuel/location are read-compute-write
 *    (best-effort for MVP, per spec): a true simultaneous double-sell could
 *    under-drift the price, but a single player's sequential commands are safe.
 */

import { getServerClient } from "@/lib/supabase/server";
import type { Player, PlayerRow } from "@/lib/players/types";
import { rowToPlayer } from "@/lib/players/mapping";

const GLOBAL_MARKET = "global";

/** Re-read the authoritative player row by id (post-mutation refresh). */
export async function getPlayerById(id: string): Promise<Player | null> {
  const db = getServerClient();
  const { data, error } = await db
    .from("players")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToPlayer(data as PlayerRow) : null;
}

// ---------------------------------------------------------------------------
// Depletion (world_deltas, kind='depletion'). Keyed by planetKey; payload is
// { resourceId, amount } where amount is abundance consumed (see rules.ts).
// ---------------------------------------------------------------------------

interface DepletionPayload {
  resourceId: string;
  amount: number;
}

/** Total depletion per resource for a planet, reduced over all delta rows. */
export async function getDepletionMap(
  planetKey: string,
): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("world_deltas")
    .select("payload")
    .eq("location_key", planetKey)
    .eq("kind", "depletion");
  if (error) throw error;
  const map: Record<string, number> = {};
  for (const row of data ?? []) {
    const p = (row as { payload: DepletionPayload }).payload;
    if (p && typeof p.resourceId === "string" && typeof p.amount === "number") {
      map[p.resourceId] = (map[p.resourceId] ?? 0) + p.amount;
    }
  }
  return map;
}

/** Append a depletion delta (append-only; safe under concurrency). */
export async function recordDepletion(
  planetKey: string,
  resourceId: string,
  amount: number,
  playerId: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db.from("world_deltas").insert({
    location_key: planetKey,
    kind: "depletion",
    payload: { resourceId, amount } satisfies DepletionPayload,
    player_id: playerId,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Discoveries (first-visitor per planet). The planet_key PK makes the first
// INSERT the winner; a conflicting insert means someone got there first.
// ---------------------------------------------------------------------------

/**
 * Record a discovery for `planetKey`. Returns true iff THIS call was the first
 * (i.e. the row was inserted), false if it already existed. Uses an
 * ignore-duplicates upsert so a race resolves to exactly one discoverer.
 */
export async function recordDiscovery(
  planetKey: string,
  playerId: string,
): Promise<boolean> {
  const db = getServerClient();
  const { data, error } = await db
    .from("discoveries")
    .upsert(
      { planet_key: planetKey, player_id: playerId },
      { onConflict: "planet_key", ignoreDuplicates: true },
    )
    .select("planet_key");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** The set of systemKeys that have at least one discovered planet. */
export async function discoveredSystemKeys(): Promise<Set<string>> {
  const db = getServerClient();
  const { data, error } = await db.from("discoveries").select("planet_key");
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) {
    const key = (row as { planet_key: string }).planet_key;
    const idx = key.lastIndexOf(":");
    if (idx > 0) set.add(key.slice(0, idx));
  }
  return set;
}

// ---------------------------------------------------------------------------
// Inventory.
// ---------------------------------------------------------------------------

export interface InventoryStack {
  resourceId: string;
  qty: number;
}

/** A player's non-empty cargo stacks. */
export async function getInventory(playerId: string): Promise<InventoryStack[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("inventory")
    .select("resource_id, qty")
    .eq("player_id", playerId)
    .gt("qty", 0);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    resourceId: (r as { resource_id: string }).resource_id,
    qty: (r as { qty: number }).qty,
  }));
}

/** Total units carried (cargo used). */
export async function getCargoUsed(playerId: string): Promise<number> {
  const stacks = await getInventory(playerId);
  return stacks.reduce((sum, s) => sum + s.qty, 0);
}

/** Atomically add `amount` units of a resource to cargo; returns new qty. */
export async function addInventory(
  playerId: string,
  resourceId: string,
  amount: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_inventory", {
    p_player: playerId,
    p_resource: resourceId,
    p_amount: amount,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** Remove a resource stack from cargo entirely (used by `sell`). */
export async function clearInventory(
  playerId: string,
  resourceId: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("inventory")
    .delete()
    .eq("player_id", playerId)
    .eq("resource_id", resourceId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Markets (single global market for MVP).
// ---------------------------------------------------------------------------

/** Current global prices, keyed by resource id. */
export async function getMarketPrices(): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("markets")
    .select("resource_id, price")
    .eq("location_key", GLOBAL_MARKET);
  if (error) throw error;
  const map: Record<string, number> = {};
  for (const row of data ?? []) {
    map[(row as { resource_id: string }).resource_id] = (
      row as { price: number }
    ).price;
  }
  return map;
}

/** Current global price for one resource (null if the market has no row). */
export async function getMarketPrice(resourceId: string): Promise<number | null> {
  const db = getServerClient();
  const { data, error } = await db
    .from("markets")
    .select("price")
    .eq("location_key", GLOBAL_MARKET)
    .eq("resource_id", resourceId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data as { price: number }).price : null;
}

/** Persist a new global price for a resource (best-effort write). */
export async function setMarketPrice(
  resourceId: string,
  price: number,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("markets")
    .update({ price, updated_at: new Date().toISOString() })
    .eq("location_key", GLOBAL_MARKET)
    .eq("resource_id", resourceId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Player mutations.
// ---------------------------------------------------------------------------

/** Atomically add `delta` credits (may be negative); returns new balance. */
export async function addPlayerCredits(
  playerId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_player_credits", {
    p_player: playerId,
    p_amount: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** Set fuel and full location in one update (warp). */
export async function setFuelAndLocation(
  playerId: string,
  fuel: number,
  loc: { sector: number; system: number; planet: number },
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ fuel, sector: loc.sector, system: loc.system, planet: loc.planet })
    .eq("id", playerId);
  if (error) throw error;
}

/** Move within the current system to a new planet index (land). */
export async function setPlanet(playerId: string, planet: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ planet })
    .eq("id", playerId);
  if (error) throw error;
}

/** Set absolute fuel (buy fuel). */
export async function setFuel(playerId: string, fuel: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db.from("players").update({ fuel }).eq("id", playerId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Leaderboards (`who`). Reads public-safe data only.
// ---------------------------------------------------------------------------

export interface BoardRow {
  id: string;
  handle: string;
  credits: number;
}

/** Top players by credits (from the public leaderboard view). */
export async function topByCredits(limit: number): Promise<BoardRow[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("leaderboard")
    .select("id, handle, credits")
    .order("credits", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as BoardRow[];
}

/** Top players by discovery count, with handles resolved from leaderboard. */
export async function topByDiscoveries(
  limit: number,
): Promise<{ handle: string; count: number }[]> {
  const db = getServerClient();
  const { data, error } = await db.from("discoveries").select("player_id");
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const pid = (row as { player_id: string | null }).player_id;
    if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  const { data: lb, error: lbErr } = await db
    .from("leaderboard")
    .select("id, handle");
  if (lbErr) throw lbErr;
  const handleById = new Map<string, string>();
  for (const row of lb ?? []) {
    const r = row as { id: string; handle: string };
    handleById.set(r.id, r.handle);
  }

  return [...counts.entries()]
    .map(([id, count]) => ({ handle: handleById.get(id) ?? "unknown", count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
