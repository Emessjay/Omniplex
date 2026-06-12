/**
 * Ship catalog (Keystone 2a) — the source of truth for the ships a player can
 * fly, the way `RESOURCES` is for raw minerals and `UPGRADES`/`PARTS` are for
 * ship gear. Pure catalog math: no IO, no `server-only`, so the resolver, the
 * `shipyard`/`buyship` handlers, the renderer, and unit tests all share it.
 *
 * A ship is, this phase, purely a CARGO HOLD at a PRICE: bigger holds cost
 * steeply more, making the top ship the keystone credit SINK (wealth finally
 * buys something aspirational) and the hauling/trade enabler (more cargo ⇒
 * bigger hauls and contract deliveries). Fuel/speed/module-slot stats and
 * production-built ships are LATER phases — this catalog deliberately carries
 * only `cargoCap` + `price`.
 *
 * INVARIANTS (locked by `ships.test.ts`):
 *  - `STARTER_SHIP_ID` resolves to a ship whose `cargoCap` equals the
 *    `players.cargo_cap` table default (50) and whose `price` is 0 — so a fresh
 *    player flies the starter for free with the spawn-default hold.
 *  - `SHIPS` is strictly ascending in BOTH `cargoCap` and `price` (no dominated
 *    ship — every step up is a real trade of credits for cargo).
 *  - `shipTradeIn(id) = floor(price × TRADE_IN_FRACTION)` with
 *    `TRADE_IN_FRACTION < 1`, so reselling toward an upgrade is always a LOSS
 *    (a sink, never a profit pump).
 *
 * Extend by adding to `SHIPS` (keep it ascending); the ship is the single
 * SOURCE of a player's cargo capacity — buying one sets `players.cargo_cap`
 * from its `cargoCap`, so every existing `player.cargoCap` check keeps working.
 */

import { partValue } from "./parts";
import { isIngotId, ingotValue } from "./ingots";

export interface Ship {
  /** Stable id (the `players.ship_id` value + the `buyship <id>` argument). */
  id: string;
  /** Display name. */
  name: string;
  /** Cargo-hold capacity this ship grants (becomes `players.cargo_cap`). */
  cargoCap: number;
  /**
   * Base hull integrity (Combat-1b) — the ship's structural HP in ship-to-ship
   * combat, before any module bonuses. ASCENDING with class (a bigger hull on a
   * bigger ship), so a heavier ship can soak more punishment. `loadoutStats`
   * uses this as `hullMax`; the resolver tracks `playerHull` down from it. A
   * combat profile, NOT cargo — distinct from `cargoCap`.
   */
  hull: number;
  /**
   * Module-slot count (Combat-1a): how many ship modules this hull can fit at
   * once. Strictly ascending with cargo/price (shuttle 2 → hauler 5). Any module
   * type fits any slot (shallow model — no per-slot-type counts). The fitting
   * rules in `modules.ts` cap a loadout's length at this value.
   */
  slots: number;
  /** Purchase price in credits (the starter is free at 0). */
  price: number;
  /** Optional flavor text. */
  blurb?: string;
  /**
   * Production recipe (Keystone 2b) — `(partId | ingotId) -> qty` consumed from a
   * base's silo to BUILD this ship via `produce <ship>`, the materials-not-cash
   * alternative to `buyship`. Absent on the starter `shuttle` (not buildable).
   * Its summed input value is always strictly below `price` (see
   * `shipRecipeValue`), so building is the cheaper-but-laborious path.
   */
  recipe?: Record<string, number>;
}

/**
 * Fraction of a ship's price recovered as trade-in when buying a different
 * ship. `< 1` so swapping ships always burns value — the credit-sink discipline
 * (you never profit by churning ships).
 */
export const TRADE_IN_FRACTION = 0.7;

/**
 * The ship ladder, ascending in cargo & price. `shuttle` is the free starter
 * (cargo 50 = the spawn default); each rung trades a steep credit cost for a
 * bigger hold, culminating in the `hauler` as a serious wealth sink. Tunable.
 */
export const SHIPS: readonly Ship[] = [
  {
    id: "shuttle",
    name: "Shuttle",
    cargoCap: 50,
    slots: 2,
    hull: 80,
    price: 0,
    blurb: "The standard-issue starter hull. Cramped, but it's yours and it flies.",
  },
  {
    id: "courier",
    name: "Courier",
    cargoCap: 150,
    slots: 3,
    hull: 140,
    price: 6_000,
    blurb: "A nimble light hauler — triple the hold for your first real trade runs.",
    // ≈ 3,580 cr of parts (< 6,000 buy price).
    recipe: { hull_plating: 8, circuit_board: 6, alloy_beam: 2 },
  },
  {
    id: "freighter",
    name: "Freighter",
    cargoCap: 500,
    slots: 4,
    hull: 320,
    price: 50_000,
    blurb: "A proper cargo vessel. Bulk minerals, big contract deliveries.",
    // ≈ 26,450 cr of parts + ingots (< 50,000 buy price).
    recipe: {
      hull_plating: 40,
      circuit_board: 30,
      alloy_beam: 20,
      sensor_array: 10,
      titanium_ingot: 20,
    },
  },
  {
    id: "hauler",
    name: "Hauler",
    cargoCap: 1_500,
    slots: 5,
    hull: 600,
    price: 250_000,
    blurb: "An industrial leviathan. The endgame hold — and the endgame price.",
    // ≈ 121,920 cr of parts + ingots (< 250,000 buy price).
    recipe: {
      hull_plating: 150,
      circuit_board: 100,
      alloy_beam: 80,
      sensor_array: 60,
      titanium_ingot: 100,
      iridium_ingot: 40,
    },
  },
] as const;

/** Valid ship ids. */
export const SHIP_IDS: readonly string[] = SHIPS.map((s) => s.id);

/** The ship a new player flies (free, cargo 50 = the players-table default). */
export const STARTER_SHIP_ID = "shuttle";

const BY_ID: ReadonlyMap<string, Ship> = new Map(SHIPS.map((s) => [s.id, s]));

/** Whether `id` is a known ship id. */
export function isShipId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a ship by id. Throws on unknown ids (mirrors `getResource` /
 * `getPart`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getShip(id: string): Ship {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown ship id: ${id}`);
  return s;
}

/** A ship's cargo-hold capacity. Throws on unknown id. */
export function shipCargoCap(id: string): number {
  return getShip(id).cargoCap;
}

/** A ship's module-slot count (Combat-1a). Throws on unknown id. */
export function shipSlots(id: string): number {
  return getShip(id).slots;
}

/** A ship's base hull integrity for ship combat (Combat-1b). Throws on unknown id. */
export function shipHull(id: string): number {
  return getShip(id).hull;
}

/**
 * Resale value of a ship when trading up: `floor(price × TRADE_IN_FRACTION)`.
 * Always strictly below `price` for a priced ship (and 0 for the free starter),
 * so a swap nets a loss — the credit-sink discipline. Throws on unknown id.
 */
export function shipTradeIn(id: string): number {
  return Math.floor(getShip(id).price * TRADE_IN_FRACTION);
}

/**
 * The production recipe (`(partId | ingotId) -> qty`) used to BUILD this ship via
 * `produce <ship>` (Keystone 2b), or `null` for the starter `shuttle` (which has
 * no recipe and can't be built). Throws on unknown ship ids (via `getShip`).
 */
export function shipRecipeOf(id: string): Record<string, number> | null {
  return getShip(id).recipe ?? null;
}

/**
 * Whether `id` is a real ship that can be BUILT at a base (has a recipe) — i.e.
 * any ship except the starter. The starter `shuttle` is excluded.
 */
export function isBuildableShip(id: string): boolean {
  return isShipId(id) && shipRecipeOf(id) !== null;
}

/**
 * Summed input value of a ship's build recipe: Σ qty × per-item value, where a
 * part input is valued at `partValue` and an ingot input at `ingotValue`. The
 * materials cost of building the ship, by construction strictly below its cash
 * `price` (the producer's payoff — building is cheaper than buying). Returns 0
 * for a non-buildable ship (the starter, which has no recipe). Throws on unknown
 * ship ids (via `getShip`).
 */
export function shipRecipeValue(id: string): number {
  const recipe = shipRecipeOf(id);
  if (recipe === null) return 0;
  let total = 0;
  for (const [itemId, qty] of Object.entries(recipe)) {
    const unit = isIngotId(itemId) ? ingotValue(itemId) : partValue(itemId);
    total += unit * qty;
  }
  return total;
}
