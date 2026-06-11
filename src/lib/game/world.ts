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
import type { Player, PlayerRow, PlayerEncounter } from "@/lib/players/types";
import { rowToPlayer } from "@/lib/players/mapping";
import { getResource, RESOURCES } from "@/lib/universe";
import {
  regeneratedDepletion,
  priceTowardBase,
  supplyTowardBaseline,
  UPGRADE_SUPPLY_BASELINE,
  PART_SUPPLY_BASELINE,
} from "./rules";
import { isPartId } from "./parts";
import { presentPlayerView, type PresentPlayer } from "./presence";

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
// System supply (system_supply) — the per-SYSTEM, self-reverting finite buyable
// SUPPLY of an item: a ship UPGRADE (P9a) or a ship PART (P12b). Keyed by
// `(location_key = systemKey, item_id)`. PUBLIC read (a shared market signal);
// service-role writes. `buy` decrements, `sell`/manufacture increments — per
// system. The catalog (ids, recipes, code-derived prices) still lives in code
// (`upgrades.ts`/`parts.ts`); this stores only the supply count.
//
// Reversion-on-read, persist-on-write (mirrors per-system PRICES from P12a):
// a system+item with no stored row reads as that item's code BASELINE
// (`UPGRADE_SUPPLY_BASELINE` / `PART_SUPPLY_BASELINE`), and every stored row is
// drifted back toward its baseline by the time since `updated_at` via the pure
// `supplyTowardBaseline`. Trades persist the resulting absolute supply +
// `updated_at = now` (`setSystemSupply`), so each system's stock self-corrects
// on its own clock with NO player present.
// ---------------------------------------------------------------------------

/** The baseline supply an item reverts toward — parts vs upgrades (vs default). */
function supplyBaseline(itemId: string): number {
  return isPartId(itemId) ? PART_SUPPLY_BASELINE : UPGRADE_SUPPLY_BASELINE;
}

/** Apply supply reversion-on-read: drift `stored` toward `itemId`'s baseline. */
function driftedSupply(stored: number, itemId: string, updatedAt: string): number {
  const t = Date.parse(updatedAt);
  const elapsed = Number.isNaN(t) ? 0 : Math.max(0, Date.now() - t);
  return supplyTowardBaseline(stored, supplyBaseline(itemId), elapsed);
}

/**
 * The current buyable supply of `itemId` in `locationKey` (a `systemKey`), with
 * reversion-on-read applied. A system with no stored row for this item defaults
 * to the item's baseline (untraded → normal stock). `buy`/`sell` read this
 * before mutating.
 */
export async function getSystemSupply(
  locationKey: string,
  itemId: string,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db
    .from("system_supply")
    .select("supply, updated_at")
    .eq("location_key", locationKey)
    .eq("item_id", itemId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return supplyBaseline(itemId); // lazy row → baseline
  const r = data as { supply: number; updated_at: string };
  return driftedSupply(r.supply, itemId, r.updated_at);
}

/**
 * The drifted stored supplies for `locationKey` as `{ itemId: supply }` (for
 * views/help). Only items with a STORED row appear; items with no row default to
 * their baseline — the caller merges baselines for the full catalog (most
 * systems start rowless, so most items read as baseline).
 */
export async function getSystemSupplies(
  locationKey: string,
): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("system_supply")
    .select("item_id, supply, updated_at")
    .eq("location_key", locationKey);
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    const r = row as { item_id: string; supply: number; updated_at: string };
    out[r.item_id] = driftedSupply(r.supply, r.item_id, r.updated_at);
  }
  return out;
}

/**
 * Persist an absolute new supply for `itemId` in `locationKey` (a `systemKey`),
 * stamping `updated_at = now` so reversion accrues forward from this trade.
 * UPSERTs on the `(location_key, item_id)` primary key, so the FIRST trade in a
 * system creates its row. Clamped ≥ 0 in SQL; returns the stored supply. The
 * supply-side analogue of `setMarketPrice`.
 */
export async function setSystemSupply(
  locationKey: string,
  itemId: string,
  supply: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("set_system_supply", {
    p_location: locationKey,
    p_item: itemId,
    p_supply: supply,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

// ---------------------------------------------------------------------------
// Player parts (player_parts) — ship parts carried in the ship's parts store
// (cargo), separate from the resource hold (`inventory`). Parts are a fully
// tradeable commodity (P12b): `buy <part>` lands them here, `sell <part>` pays
// out from here, and `deposit`/`withdraw` bridge them to/from a base silo
// (`base_storage`). Mirror of the `player_materials` adapters.
// ---------------------------------------------------------------------------

export interface PartStack {
  partId: string;
  qty: number;
}

/** A player's owned ship parts (qty > 0), ascending by id for stable display. */
export async function getPlayerParts(playerId: string): Promise<PartStack[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("player_parts")
    .select("part_id, qty")
    .eq("player_id", playerId)
    .gt("qty", 0)
    .order("part_id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    partId: (r as { part_id: string }).part_id,
    qty: (r as { qty: number }).qty,
  }));
}

/**
 * Atomically adjust a part count by `delta` (negative to sell/deposit); returns
 * the new qty. Clamped at 0 in SQL, but handlers validate ownership first.
 */
export async function addPlayerPart(
  playerId: string,
  partId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_player_part", {
    p_player: playerId,
    p_part: partId,
    p_delta: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

// ---------------------------------------------------------------------------
// Materials (player_materials) — harvested/looted/dropped goods. Ownership
// counts only; the catalog (names, values) lives in code (`materials.ts`).
// Direct mirror of the player_upgrades adapters above.
// ---------------------------------------------------------------------------

export interface MaterialStack {
  materialId: string;
  qty: number;
}

/** A player's owned materials (qty > 0), ascending by id for stable display. */
export async function getPlayerMaterials(playerId: string): Promise<MaterialStack[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("player_materials")
    .select("material_id, qty")
    .eq("player_id", playerId)
    .gt("qty", 0)
    .order("material_id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    materialId: (r as { material_id: string }).material_id,
    qty: (r as { qty: number }).qty,
  }));
}

/**
 * Atomically adjust a material count by `delta` (negative to sell); returns the
 * new qty. Clamped at 0 in SQL, but handlers validate ownership first.
 */
export async function addPlayerMaterial(
  playerId: string,
  materialId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_player_material", {
    p_player: playerId,
    p_material: materialId,
    p_delta: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

// ---------------------------------------------------------------------------
// Factions — reputation + completed contracts (Keystone 1a). Faction ids and
// contract keys are CODE-derived (`factions.ts`; contracts are procedurally
// generated per (hub, time-bucket) and never stored — only completion is). Both
// tables are per-player (read-own RLS); service-role writes. Mirrors the
// player_parts / player_materials adapters.
// ---------------------------------------------------------------------------

export interface ReputationStack {
  factionId: string;
  rep: number;
}

/** A player's reputation with every faction they have standing with (rep > 0). */
export async function getReputation(playerId: string): Promise<ReputationStack[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("player_reputation")
    .select("faction_id, rep")
    .eq("player_id", playerId)
    .gt("rep", 0)
    .order("faction_id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    factionId: (r as { faction_id: string }).faction_id,
    rep: (r as { rep: number }).rep,
  }));
}

/**
 * Atomically add `delta` reputation with a faction (positive on a fulfill);
 * returns the new standing. Clamped at 0 in SQL; mirror of `add_player_part`.
 */
export async function addReputation(
  playerId: string,
  factionId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_reputation", {
    p_player: playerId,
    p_faction: factionId,
    p_delta: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/**
 * Of the given contract `keys`, which has this player ALREADY fulfilled. Returns
 * a Set for O(1) membership when annotating the contract board. An empty input
 * short-circuits (no DB round-trip).
 */
export async function getCompletedContractKeys(
  playerId: string,
  keys: string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const db = getServerClient();
  const { data, error } = await db
    .from("completed_contracts")
    .select("contract_key")
    .eq("player_id", playerId)
    .in("contract_key", keys);
  if (error) throw error;
  return new Set((data ?? []).map((r) => (r as { contract_key: string }).contract_key));
}

/**
 * Record that the player has fulfilled the contract `contractKey`. Idempotent:
 * the `(player_id, contract_key)` PK makes a double-fulfill a no-op (the insert
 * is ignored on conflict). Service-role write.
 */
export async function markContractComplete(
  playerId: string,
  contractKey: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("completed_contracts")
    .upsert(
      { player_id: playerId, contract_key: contractKey },
      { onConflict: "player_id,contract_key", ignoreDuplicates: true },
    );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Exploration sites (Keystone 3) — which region sites a player has already
// salvaged. Sites are deterministic per region coord (`siteAt`); only the fact
// that a player has picked one clean is persisted, keyed by the 6-segment
// `regionKey`. Per-player (read-own RLS); service-role writes only. Mirrors the
// `completed_contracts` once-per-instance shape.
// ---------------------------------------------------------------------------

/**
 * Whether this player has ALREADY salvaged the site at `regionKey`. The
 * `(player_id, region_key)` PK makes salvage once-per-player-per-site. Returns
 * false when no row exists (not yet salvaged).
 */
export async function hasSalvaged(
  playerId: string,
  regionKey: string,
): Promise<boolean> {
  const db = getServerClient();
  const { data, error } = await db
    .from("salvaged_sites")
    .select("region_key")
    .eq("player_id", playerId)
    .eq("region_key", regionKey)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Record that the player has salvaged the site at `regionKey`. Idempotent: the
 * `(player_id, region_key)` PK makes a second salvage a no-op (the insert is
 * ignored on conflict). Service-role write.
 */
export async function markSalvaged(
  playerId: string,
  regionKey: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("salvaged_sites")
    .upsert(
      { player_id: playerId, region_key: regionKey },
      { onConflict: "player_id,region_key", ignoreDuplicates: true },
    );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Markets — per-SYSTEM resource prices (P12a). Each system has its own market
// row per resource, keyed by `location_key = systemKey(...)` (the 4-segment
// `"galaxy:arm:cluster:system"`). Trades read + write only the current system's
// rows, so prices move locally; travelling never moves a price. A system with no
// row yet defaults to the resource's catalog `base_value`, and every read drifts
// the stored price back toward that baseline (mean-reversion), so each system
// reverts on its own clock with NO player present. (Pre-P12 `'global'` rows are
// inert — never read or written — and may be cleaned up by a later migration.)
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

/**
 * Current prices for `locationKey` (a `systemKey`), keyed by resource id, with
 * drift-on-read applied. Every catalog resource is present: a resource with no
 * stored row for this system defaults to its `base_value` (the system simply
 * hasn't been traded yet), and stored rows override that default with their
 * reverted price. So callers (`sell`, `inventory`, `help`) always get a price
 * for everything they hold here.
 */
export async function getMarketPrices(
  locationKey: string,
): Promise<Record<string, number>> {
  const db = getServerClient();
  const { data, error } = await db
    .from("markets")
    .select("resource_id, price, updated_at")
    .eq("location_key", locationKey);
  if (error) throw error;
  // Default every resource to its catalog base value (untraded system), then
  // override with the drifted stored price wherever a row exists.
  const map: Record<string, number> = {};
  for (const r of RESOURCES) map[r.id] = r.baseValue;
  for (const row of data ?? []) {
    const r = row as { resource_id: string; price: number; updated_at: string };
    map[r.resource_id] = driftedPrice(r.price, r.resource_id, r.updated_at);
  }
  return map;
}

/**
 * Current price for one resource in `locationKey` (a `systemKey`) with
 * drift-on-read applied. Falls back to the resource's catalog `base_value` when
 * this system has no stored row yet (untraded → baseline price); returns null
 * only for an unknown resource id.
 */
export async function getMarketPrice(
  locationKey: string,
  resourceId: string,
): Promise<number | null> {
  const db = getServerClient();
  const { data, error } = await db
    .from("markets")
    .select("price, updated_at")
    .eq("location_key", locationKey)
    .eq("resource_id", resourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // No row for this system yet → the catalog baseline (unknown id → null).
    try {
      return getResource(resourceId).baseValue;
    } catch {
      return null;
    }
  }
  const r = data as { price: number; updated_at: string };
  return driftedPrice(r.price, resourceId, r.updated_at);
}

/**
 * Persist a new price for a resource in `locationKey` (a `systemKey`), stamping
 * `updated_at = now` so drift accrues forward from this trade. UPSERTs on the
 * `(location_key, resource_id)` primary key, so the FIRST trade in a system
 * creates its row (most systems start with no rows) and later trades update it.
 */
export async function setMarketPrice(
  locationKey: string,
  resourceId: string,
  price: number,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("markets")
    .upsert(
      {
        location_key: locationKey,
        resource_id: resourceId,
        price,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_key,resource_id" },
    );
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
 * Atomically bump a player's worlds-CHARTED count by 1 (Keystone 3b); returns the
 * new count. Called ONLY inside the first-discovery gate (`recordDiscovery`
 * returned true), so it fires exactly once per planet. Race-safe via the
 * `add_charted` RPC (mirrors `add_player_credits`).
 */
export async function incrementCharted(playerId: string): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_charted", {
    p_player: playerId,
    p_delta: 1,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/**
 * Set WARP fuel and full location in one update (warp). Region is always reset
 * to 0 and `landed` to false — you ARRIVE IN ORBIT of region 0's planet
 * (orbit-land); you must `land` to descend. Warp burns warp fuel; regular `fuel`
 * is untouched here (P2).
 */
export async function setWarpFuelAndLocation(
  playerId: string,
  warpFuel: number,
  loc: {
    galaxy: number;
    arm: number;
    cluster: number;
    system: number;
    planet: number;
  },
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({
      warp_fuel: warpFuel,
      galaxy: loc.galaxy,
      arm: loc.arm,
      cluster: loc.cluster,
      system: loc.system,
      planet: loc.planet,
      region: 0,
      landed: false,
    })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Set the player's GALAXY and full location in one update (hyperwarp — P3). The
 * ONLY mutator that changes `galaxy`; `warp`/`land` stay within the galaxy. No
 * fuel is charged here — the Hyperwarp Condensate IS the cost (the handler
 * consumes it separately). Region resets to 0; the handler supplies the fixed
 * entry point (arm 0 mod the destination's arm count, cluster/system/planet 0).
 */
export async function setGalaxyLocation(
  playerId: string,
  loc: {
    galaxy: number;
    arm: number;
    cluster: number;
    system: number;
    planet: number;
  },
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({
      galaxy: loc.galaxy,
      arm: loc.arm,
      cluster: loc.cluster,
      system: loc.system,
      planet: loc.planet,
      region: 0,
      landed: false,
    })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Move within the current system to another planet index AND set regular fuel in
 * one update, setting the surface state explicitly (orbit-land). Region resets to
 * 0. Used by `orbit <planet>` (landed=false — you fly to ORBIT it, burning the
 * distance fuel) and by the `land <planet>` combo (landed=true — orbit there then
 * descend; descent itself is free, so the fuel charged is the orbit hop only).
 * Warp fuel is untouched here.
 */
export async function setFuelPlanetLanded(
  playerId: string,
  fuel: number,
  planet: number,
  landed: boolean,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ fuel, planet, region: 0, landed })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Descend to the surface of the planet you're already orbiting (`land`, no arg).
 * Descent is FREE — no fuel change; just sets `landed=true` and resets region to
 * 0 (you touch down in region 0). The landing gate / rocky check is enforced in
 * the handler before this is called.
 */
export async function setLandedDescent(playerId: string): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ landed: true, region: 0 })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Lift off the surface back into orbit (`launch`): sets regular `fuel` (the
 * atmosphere climb is billed here) and `landed=false`, resetting region to 0
 * (region is nominal in orbit). Same planet — only the surface state changes.
 */
export async function setLaunch(playerId: string, fuel: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ fuel, landed: false, region: 0 })
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

/** Set absolute regular fuel (buy fuel). */
export async function setFuel(playerId: string, fuel: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db.from("players").update({ fuel }).eq("id", playerId);
  if (error) throw error;
}

/**
 * Swap the player's ship (`buyship`): set `ship_id` AND `cargo_cap` in one
 * update. The ship is the single SOURCE of cargo capacity, so the two MUST move
 * together — `cargoCap` is the new ship's catalog `cargoCap`. The credit charge
 * goes through the atomic `add_player_credits` RPC in the handler (validated
 * before this is called).
 */
export async function setShip(
  playerId: string,
  shipId: string,
  cargoCap: number,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ ship_id: shipId, cargo_cap: cargoCap })
    .eq("id", playerId);
  if (error) throw error;
}

/** Set absolute warp fuel (buy warpfuel). */
export async function setWarpFuel(playerId: string, warpFuel: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ warp_fuel: warpFuel })
    .eq("id", playerId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Survival state (health + embark). Health changes are read-compute-write on a
// single player's sequential commands (safe; same model as fuel). Death's
// credit penalty goes through the atomic `add_player_credits` RPC, not here.
// ---------------------------------------------------------------------------

/** Set the player's embark state (true = aboard ship, false = on foot). */
export async function setEmbarked(playerId: string, embarked: boolean): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ embarked })
    .eq("id", playerId);
  if (error) throw error;
}

/** Set the player's current health (the column CHECK enforces health ≥ 0). */
export async function setHealth(playerId: string, health: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ health })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Set the player's PUBLIC handle (shown in leaderboard / `who` / bases). Returns
 * `true` on success, `false` if the handle is already taken — the
 * `players.handle` UNIQUE constraint surfaces as a 23505, which the `rename`
 * handler reports as "that username is taken". All other errors throw. The
 * handler validates the handle's shape (`validateHandle`) before calling.
 */
export async function setHandle(
  playerId: string,
  handle: string,
): Promise<boolean> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ handle })
    .eq("id", playerId);
  if (error) {
    if ((error as { code?: string }).code === "23505") return false; // taken
    throw error;
  }
  return true;
}

/**
 * Set (or clear) the player's combat encounter. `null` ends combat (kill / flee
 * / death); a `{ faunaId, hp }` object starts or updates it. Stored in the
 * nullable `players.encounter` jsonb column.
 */
export async function setEncounter(
  playerId: string,
  encounter: PlayerEncounter | null,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ encounter })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Set health and embark state together (the death sequence: full health, back
 * aboard the ship). Location is left untouched — you wake where you fell.
 */
export async function setHealthAndEmbarked(
  playerId: string,
  health: number,
  embarked: boolean,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({ health, embarked })
    .eq("id", playerId);
  if (error) throw error;
}

/**
 * Emergency rescue (`distress`, player-guidance): dock the player at an orbital
 * outpost in their current system, fully healed and combat cleared, in ONE
 * write. Sets `planet` (the chosen outpost planet), `region = -1` (docked at the
 * orbital station), `embarked = true`, `landed = false`, `health` (the caller
 * passes `MAX_HEALTH`), and clears any encounter. Galaxy/arm/cluster/system are
 * unchanged — the rescue stays in-system (not exploitable as free long-haul
 * travel). The credit charge goes through the atomic `add_player_credits` RPC
 * separately. The handler validates + picks the destination before calling.
 */
export async function setDistressLocation(
  playerId: string,
  planet: number,
  health: number,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("players")
    .update({
      planet,
      region: -1,
      embarked: true,
      landed: false,
      health,
      encounter: null,
    })
    .eq("id", playerId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Bases (P7) — a player's claim on a region. PUBLIC READ (others see them), so
// these adapters return public-safe data (owner handle + name, never user_id).
// The base catalog/cost lives in code (`bases.ts`); the DB stores ownership.
// ---------------------------------------------------------------------------

/** A base as seen by others in a region: owner handle/id + optional name. */
export interface RegionBase {
  ownerId: string;
  handle: string;
  name: string | null;
}

/** A base the current player owns: where it is + its name. */
export interface OwnedBase {
  regionKey: string;
  name: string | null;
}

/**
 * Create a base for `ownerId` in `regionKey`. Returns true if it was created,
 * false if one already exists there for this player (the `(owner_id,
 * region_key)` unique constraint, surfaced as a 23505). All other errors throw.
 * Callers validate affordability + consume the cost before calling.
 */
export async function createBase(
  ownerId: string,
  regionKey: string,
  name?: string,
): Promise<boolean> {
  const db = getServerClient();
  const { error } = await db
    .from("bases")
    .insert({ owner_id: ownerId, region_key: regionKey, name: name ?? null });
  if (error) {
    if ((error as { code?: string }).code === "23505") return false; // duplicate
    throw error;
  }
  return true;
}

/**
 * The bases present in `regionKey` (any owner), with each owner's handle
 * resolved from the public leaderboard view. Public-safe — no user_id. Used by
 * `scan` to show the shared-world presence.
 */
export async function basesInRegion(regionKey: string): Promise<RegionBase[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("bases")
    .select("owner_id, name")
    .eq("region_key", regionKey)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as { owner_id: string; name: string | null }[];
  if (rows.length === 0) return [];

  // Resolve handles from the public leaderboard view (handle is public-safe).
  const ids = [...new Set(rows.map((r) => r.owner_id))];
  const { data: lb, error: lbErr } = await db
    .from("leaderboard")
    .select("id, handle")
    .in("id", ids);
  if (lbErr) throw lbErr;
  const handleById = new Map<string, string>();
  for (const row of lb ?? []) {
    const r = row as { id: string; handle: string };
    handleById.set(r.id, r.handle);
  }
  return rows.map((r) => ({
    ownerId: r.owner_id,
    handle: handleById.get(r.owner_id) ?? "unknown",
    name: r.name,
  }));
}

/** The bases a player owns (region key + name), oldest first. */
export async function basesOwnedBy(playerId: string): Promise<OwnedBase[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("bases")
    .select("region_key, name")
    .eq("owner_id", playerId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    regionKey: (r as { region_key: string }).region_key,
    name: (r as { name: string | null }).name,
  }));
}

// ---------------------------------------------------------------------------
// Base buildings + storage (P8a) — structures INSIDE a base (silos/excavators)
// and a base's stored items (silo contents). Public read (bases are public), so
// these reads are public-safe; writes go through the service role. The building
// *catalog* (kinds, costs) and the accrual math live in code (`bases.ts` /
// `rules.ts`); the DB stores ownership + mutable per-building state.
// ---------------------------------------------------------------------------

/** A structure inside a base: its id, kind, mutable state, and creation time. */
export interface BaseBuilding {
  id: string;
  kind: string;
  state: Record<string, unknown>;
  createdAt: string;
}

/** A base the current player owns, with the id needed to address its buildings. */
export interface OwnedBaseRow {
  id: string;
  name: string | null;
  /** The base's tier (1..MAX_BASE_TIER); scales its storage capacity. */
  tier: number;
}

/**
 * The base `ownerId` owns in `regionKey`, or null if they have none there. The
 * `(owner_id, region_key)` unique constraint guarantees at most one. Returns the
 * id (to address its buildings/storage) + name + tier.
 */
export async function getBaseInRegion(
  ownerId: string,
  regionKey: string,
): Promise<OwnedBaseRow | null> {
  const db = getServerClient();
  const { data, error } = await db
    .from("bases")
    .select("id, name, tier")
    .eq("owner_id", ownerId)
    .eq("region_key", regionKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as { id: string; name: string | null; tier: number | null };
  return { id: r.id, name: r.name, tier: r.tier ?? 1 };
}

/** Set a base's tier (the `upgrade base` mutator). Service-role write. */
export async function setBaseTier(baseId: string, tier: number): Promise<void> {
  const db = getServerClient();
  const { error } = await db.from("bases").update({ tier }).eq("id", baseId);
  if (error) throw error;
}

/** All buildings in a base, oldest first. */
export async function getBaseBuildings(baseId: string): Promise<BaseBuilding[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("base_buildings")
    .select("id, kind, state, created_at")
    .eq("base_id", baseId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      kind: string;
      state: Record<string, unknown> | null;
      created_at: string;
    };
    return { id: r.id, kind: r.kind, state: r.state ?? {}, createdAt: r.created_at };
  });
}

/** Insert a building of `kind` into a base with an initial `state` (default {}). */
export async function createBaseBuilding(
  baseId: string,
  kind: string,
  state: Record<string, unknown> = {},
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("base_buildings")
    .insert({ base_id: baseId, kind, state });
  if (error) throw error;
}

/** Overwrite a building's mutable `state` (e.g. an excavator's lastCollectedAt). */
export async function setBuildingState(
  buildingId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("base_buildings")
    .update({ state })
    .eq("id", buildingId);
  if (error) throw error;
}

/** A stored item in a base's storage. */
export interface StorageStack {
  itemId: string;
  qty: number;
}

/** A base's non-empty stored items (qty > 0), ascending by id for stable display. */
export async function getBaseStorage(baseId: string): Promise<StorageStack[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("base_storage")
    .select("item_id, qty")
    .eq("base_id", baseId)
    .gt("qty", 0)
    .order("item_id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    itemId: (r as { item_id: string }).item_id,
    qty: (r as { qty: number }).qty,
  }));
}

/**
 * Atomically adjust a base's stored quantity of an item by `delta` (negative to
 * withdraw); returns the new qty. Clamped at 0 in SQL, but handlers validate
 * holdings/capacity first.
 */
export async function addBaseStorage(
  baseId: string,
  itemId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_base_storage", {
    p_base: baseId,
    p_item: itemId,
    p_delta: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

// ---------------------------------------------------------------------------
// Crop-farm plots (crop-farming) — one row per crop sown into a base's crop
// farm. Public read (bases are public), so these reads are public-safe; writes
// go through the service role. The crop CATALOG + the `cropMature` growth rule
// live in code (`crops.ts` / `rules.ts`); the DB stores what's planted + when.
// No atomic-clamp RPC is needed (these are rows, not a counter) — plant inserts
// a row, harvest deletes the matured rows.
// ---------------------------------------------------------------------------

/** A crop sown into a base plot: its row id, the crop id, and when it was planted. */
export interface Plot {
  id: string;
  cropId: string;
  /** ISO timestamp the crop was planted (the growth clock `cropMature` reads). */
  plantedAt: string;
}

/** All crops planted in a base, oldest first. */
export async function getBasePlots(baseId: string): Promise<Plot[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("base_plots")
    .select("id, crop_id, planted_at")
    .eq("base_id", baseId)
    .order("planted_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const r = row as { id: string; crop_id: string; planted_at: string };
    return { id: r.id, cropId: r.crop_id, plantedAt: r.planted_at };
  });
}

/** Sow one crop into a base plot (the row's `planted_at` defaults to now()). */
export async function plantCrop(baseId: string, cropId: string): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("base_plots")
    .insert({ base_id: baseId, crop_id: cropId });
  if (error) throw error;
}

/** Delete the given (harvested) plot rows by id. No-op on an empty list. */
export async function removePlots(plotIds: string[]): Promise<void> {
  if (plotIds.length === 0) return;
  const db = getServerClient();
  const { error } = await db.from("base_plots").delete().in("id", plotIds);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Livestock (animal-husbandry) — one row per (base, animal) herd. Public read
// (bases are public), so these reads are public-safe; writes go through the
// service role. The animal CATALOG + the breed/feed rules live in code
// (`livestock.ts` / `rules.ts`); the DB stores head counts + the breed clock.
// `add_livestock` is the atomic clamped counter RPC (mirrors `add_base_storage`
// / `add_player_material`); `setLivestockBred` stamps the breed clock.
// ---------------------------------------------------------------------------

/** A herd of one animal type at a base: the animal id, head count, breed clock. */
export interface Herd {
  animalId: string;
  count: number;
  /** ISO timestamp the herd last bred (the clock the `livestockCanBreed` rule reads). */
  lastBredAt: string;
}

/** All herds at a base with count > 0, ascending by animal id for stable display. */
export async function getBaseLivestock(baseId: string): Promise<Herd[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("base_livestock")
    .select("animal_id, count, last_bred_at")
    .eq("base_id", baseId)
    .gt("count", 0)
    .order("animal_id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const r = row as { animal_id: string; count: number; last_bred_at: string };
    return { animalId: r.animal_id, count: r.count, lastBredAt: r.last_bred_at };
  });
}

/**
 * Atomically adjust a herd's head count by `delta` (negative to slaughter);
 * returns the new count. Clamped at 0 in SQL, but handlers validate
 * ownership/capacity first. On first ranch the row's `last_bred_at` defaults to
 * now().
 */
export async function addLivestock(
  baseId: string,
  animalId: string,
  delta: number,
): Promise<number> {
  const db = getServerClient();
  const { data, error } = await db.rpc("add_livestock", {
    p_base: baseId,
    p_animal: animalId,
    p_delta: delta,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** Stamp a herd's breed clock (`last_bred_at`) — called when feeding breeds it. */
export async function setLivestockBred(
  baseId: string,
  animalId: string,
  atIso: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from("base_livestock")
    .update({ last_bred_at: atIso })
    .eq("base_id", baseId)
    .eq("animal_id", animalId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Shared-world presence (foundation 3a). The co-located-players query: OTHER
// players standing in the SAME place (the full six-tier location tuple — same
// surface region, same-planet orbit `region = 0`, or same-outpost `region =
// -1`). Service-role read; PUBLIC-SAFE by construction — it SELECTs only the
// public columns (handle/ship/embark/landed) and resolves each row through
// `presentPlayerView`, which carries no `user_id`/email (the same projection
// discipline the public `leaderboard` view enforces). Polled (no realtime yet —
// 3b adds live arrive/leave + chat on top of this).
// ---------------------------------------------------------------------------

/** A location to look for co-located players at, plus the id to exclude (self). */
export interface PresenceQuery {
  /** The querying player's id — excluded from the result (you don't see yourself). */
  id: string;
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  planet: number;
  region: number;
}

/**
 * The OTHER players co-located with `loc` (`sameLocation` — the full location
 * tuple), as public-safe presence views. Excludes the querying player (`loc.id`)
 * and projects only handle/ship/state — never identity. The six `.eq()` filters
 * implement `sameLocation`; the `.neq("id", …)` excludes self.
 */
export async function playersHere(loc: PresenceQuery): Promise<PresentPlayer[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("players")
    .select("handle, ship_id, embarked, landed")
    .eq("galaxy", loc.galaxy)
    .eq("arm", loc.arm)
    .eq("cluster", loc.cluster)
    .eq("system", loc.system)
    .eq("planet", loc.planet)
    .eq("region", loc.region)
    .neq("id", loc.id)
    .order("handle", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const r = row as {
      handle: string;
      ship_id: string;
      embarked: boolean;
      landed: boolean;
    };
    return presentPlayerView({
      handle: r.handle,
      shipId: r.ship_id,
      embarked: r.embarked,
      landed: r.landed,
    });
  });
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

/**
 * Top explorers by worlds CHARTED (Keystone 3b), from the public-safe leaderboard
 * view (now exposing `charted`). Players who haven't charted anything (0) are
 * excluded so the board shows real explorers. The cartography rank/title is
 * derived render-side from `charted` (`cartographyRank`).
 */
export async function topByCharted(
  limit: number,
): Promise<{ handle: string; charted: number }[]> {
  const db = getServerClient();
  const { data, error } = await db
    .from("leaderboard")
    .select("handle, charted")
    .gt("charted", 0)
    .order("charted", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as { handle: string; charted: number }[];
}
