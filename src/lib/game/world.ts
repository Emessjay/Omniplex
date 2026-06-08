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
import { getResource } from "@/lib/universe";
import { regeneratedDepletion, priceTowardBase } from "./rules";

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
// Depletion (world_deltas, kind='depletion'). Keyed by a location key — now the
// 4-segment `regionKey` (depletion is per-region since planet-regions), though
// these adapters are agnostic to the key's shape. Payload is
// { resourceId, amount } where amount is abundance consumed (see rules.ts).
// ---------------------------------------------------------------------------

interface DepletionPayload {
  resourceId: string;
  amount: number;
}

/** Total depletion per resource for a location, reduced over all delta rows. */
export async function getDepletionMap(
  locationKey: string,
): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("world_deltas")
    .select("payload")
    .eq("location_key", locationKey)
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

/**
 * Effective depletion per resource for a planet, with ore *regen-on-read*
 * applied. For each resource we replay its depletion deltas in chronological
 * order, decaying the running depletion toward 0 over the gap *between* deltas
 * (via the pure `regeneratedDepletion`) before adding each new mine on top, and
 * finally decaying over the gap to `now`. The returned shape matches
 * `getDepletionMap`, so callers feed it straight into `effectiveAbundance`.
 *
 * Why replay rather than regen the raw sum by the latest gap: depletion that
 * had already healed before a later mine must stay forgiven. A naive
 * `regen(sum, now − lastDelta)` resurrects it — the ever-growing sum would make
 * full recovery take longer the more a planet has *ever* been mined. Replaying
 * keeps recovery a flat ~24h no matter the history, and a fresh delta still
 * resets the clock (it's added after the decay, with the final decay measured
 * from it).
 *
 * Impure by design: `Date.now()` lives here (not in the pure `rules.ts`).
 */
export async function getEffectiveDepletionMap(
  locationKey: string,
): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("world_deltas")
    .select("payload, created_at")
    .eq("location_key", locationKey)
    .eq("kind", "depletion")
    .order("created_at", { ascending: true });
  if (error) throw error;

  // Per resource: the running depletion and the timestamp it was last updated.
  const depletion: Record<string, number> = {};
  const lastAt: Record<string, number> = {};
  for (const row of data ?? []) {
    const r = row as { payload: DepletionPayload; created_at: string };
    const p = r.payload;
    if (!p || typeof p.resourceId !== "string" || typeof p.amount !== "number") {
      continue;
    }
    const t = Date.parse(r.created_at);
    if (Number.isNaN(t)) continue;
    const id = p.resourceId;
    const prev = depletion[id] ?? 0;
    const prevAt = lastAt[id] ?? t;
    // Heal what accrued before this mine, then stack the new depletion on top.
    depletion[id] = regeneratedDepletion(prev, Math.max(0, t - prevAt)) + p.amount;
    lastAt[id] = t;
  }

  // Final decay from each resource's last delta to "now".
  const now = Date.now();
  const effective: Record<string, number> = {};
  for (const id of Object.keys(depletion)) {
    effective[id] = regeneratedDepletion(
      depletion[id]!,
      Math.max(0, now - (lastAt[id] ?? now)),
    );
  }
  return effective;
}

/** Append a depletion delta (append-only; safe under concurrency). */
export async function recordDepletion(
  locationKey: string,
  resourceId: string,
  amount: number,
  playerId: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db.from("world_deltas").insert({
    location_key: locationKey,
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
// Ship upgrades (player_upgrades). Ownership counts only; the catalog (recipes,
// prices) lives in code (`upgrades.ts`). Owning ≥ 1 activates a capability.
// ---------------------------------------------------------------------------

export interface UpgradeStack {
  upgradeId: string;
  qty: number;
}

/** A player's owned upgrades (qty > 0), ascending by id for stable display. */
export async function getPlayerUpgrades(playerId: string): Promise<UpgradeStack[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("player_upgrades")
    .select("upgrade_id, qty")
    .eq("player_id", playerId)
    .gt("qty", 0)
    .order("upgrade_id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    upgradeId: (r as { upgrade_id: string }).upgrade_id,
    qty: (r as { qty: number }).qty,
  }));
}

/** The set of upgrade ids a player owns (qty > 0) — the capability set. */
export async function getOwnedUpgradeIds(playerId: string): Promise<Set<string>> {
  const stacks = await getPlayerUpgrades(playerId);
  return new Set(stacks.map((s) => s.upgradeId));
}

/**
 * Atomically adjust an upgrade count by `delta` (negative to sell); returns the
 * new qty. Clamped at 0 in SQL, but handlers validate ownership/credits first.
 */
export async function addPlayerUpgrade(
  playerId: string,
  upgradeId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_player_upgrade", {
    p_player: playerId,
    p_upgrade: upgradeId,
    p_delta: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** Remove `amount` units of a resource from cargo atomically; returns new qty. */
export async function removeInventory(
  playerId: string,
  resourceId: string,
  amount: number,
): Promise<number> {
  return addInventory(playerId, resourceId, -amount);
}

// ---------------------------------------------------------------------------
// Markets (single global market for MVP).
// ---------------------------------------------------------------------------

/**
 * Apply price mean-reversion *on read*: drift the stored price back toward the
 * resource's `base_value` by the time since its last trade (`updated_at`),
 * rounded to an integer (the `markets.price` column is an integer ≥ 0, and
 * `priceTowardBase` already floors at `PRICE_FLOOR`). Persisted prices are only
 * updated on a trade (`setMarketPrice` stamps `updated_at = now`), so drift
 * accrues forward from the last trade — "apply-on-read, persist-on-write".
 */
function driftedPrice(stored: number, resourceId: string, updatedAt: string): number {
  let base: number;
  try {
    base = getResource(resourceId).baseValue;
  } catch {
    return stored; // unknown id (shouldn't happen for seeded markets): no drift
  }
  const t = Date.parse(updatedAt);
  const elapsed = Number.isNaN(t) ? 0 : Math.max(0, Date.now() - t);
  return Math.round(priceTowardBase(stored, base, elapsed));
}

/** Current global prices (drift-on-read applied), keyed by resource id. */
export async function getMarketPrices(): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("markets")
    .select("resource_id, price, updated_at")
    .eq("location_key", GLOBAL_MARKET);
  if (error) throw error;
  const map: Record<string, number> = {};
  for (const row of data ?? []) {
    const r = row as { resource_id: string; price: number; updated_at: string };
    map[r.resource_id] = driftedPrice(r.price, r.resource_id, r.updated_at);
  }
  return map;
}

/**
 * Current global price for one resource with drift-on-read applied (null if the
 * market has no row).
 */
export async function getMarketPrice(resourceId: string): Promise<number | null> {
  const db = getServerClient();
  const { data, error } = await db
    .from("markets")
    .select("price, updated_at")
    .eq("location_key", GLOBAL_MARKET)
    .eq("resource_id", resourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as { price: number; updated_at: string };
  return driftedPrice(r.price, resourceId, r.updated_at);
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

/**
 * Set fuel and full location in one update (warp). Region is always reset to 0
 * — you touch down in region 0 of the arrival planet.
 */
export async function setFuelAndLocation(
  playerId: string,
  fuel: number,
  loc: { sector: number; system: number; planet: number },
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({
      fuel,
      sector: loc.sector,
      system: loc.system,
      planet: loc.planet,
      region: 0,
    })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Move within the current system to a new planet index (land). Region resets to
 * 0 — landing always puts you down in region 0, even when re-landing the planet
 * you're already on.
 */
export async function setPlanet(playerId: string, planet: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ planet, region: 0 })
    .eq("id", playerId);
  if (error) throw error;
}

/** Set the player's current region index within the planet (jump). */
export async function setRegion(playerId: string, region: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ region })
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
