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

export interface Ship {
  /** Stable id (the `players.ship_id` value + the `buyship <id>` argument). */
  id: string;
  /** Display name. */
  name: string;
  /** Cargo-hold capacity this ship grants (becomes `players.cargo_cap`). */
  cargoCap: number;
  /** Purchase price in credits (the starter is free at 0). */
  price: number;
  /** Optional flavor text. */
  blurb?: string;
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
    price: 0,
    blurb: "The standard-issue starter hull. Cramped, but it's yours and it flies.",
  },
  {
    id: "courier",
    name: "Courier",
    cargoCap: 150,
    price: 6_000,
    blurb: "A nimble light hauler — triple the hold for your first real trade runs.",
  },
  {
    id: "freighter",
    name: "Freighter",
    cargoCap: 500,
    price: 50_000,
    blurb: "A proper cargo vessel. Bulk minerals, big contract deliveries.",
  },
  {
    id: "hauler",
    name: "Hauler",
    cargoCap: 1_500,
    price: 250_000,
    blurb: "An industrial leviathan. The endgame hold — and the endgame price.",
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

/**
 * Resale value of a ship when trading up: `floor(price × TRADE_IN_FRACTION)`.
 * Always strictly below `price` for a priced ship (and 0 for the free starter),
 * so a swap nets a loss — the credit-sink discipline. Throws on unknown id.
 */
export function shipTradeIn(id: string): number {
  return Math.floor(getShip(id).price * TRADE_IN_FRACTION);
}
