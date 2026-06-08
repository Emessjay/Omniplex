/**
 * Pure gameplay rules — the math behind every command.
 *
 * LOAD-BEARING: these functions are heavily unit-tested (see
 * `command-core.test.ts`) and are the single source of truth for fuel,
 * mining, and pricing math. They are PURE — no DB, no env, no `Date`, no
 * `Math.random`. DB handlers in `src/lib/game/` stay thin by pushing all
 * arithmetic here. The next economy/production vertical builds on these
 * signatures, so extend additively rather than reshaping them.
 */

// ---------------------------------------------------------------------------
// Tuning constants. Exported so handlers, render, and the data adapters share
// one definition of each knob. Documented inline; tweak here, nowhere else.
// ---------------------------------------------------------------------------

/** Fuel burned per unit of `warpDistance`. Warp cost = ceil(distance * this). */
export const FUEL_PER_DISTANCE = 1;

/** Credits charged per unit of fuel at `buy fuel`. */
export const FUEL_PRICE_PER_UNIT = 3;

/**
 * Units a single `mine` extracts from a perfectly-rich (abundance 1.0)
 * deposit, before the cargo-space cap. Yield scales down with abundance.
 */
export const MINE_MAX_UNITS = 10;

/**
 * Abundance (in the planet's [0,1] scale) consumed per unit mined. A fresh
 * abundance-1.0 deposit is exhausted after roughly
 * `1 / (MINE_MAX_UNITS * DEPLETION_PER_UNIT)` full mines — i.e. the shared
 * world visibly "runs dry" after a handful of visits.
 */
export const DEPLETION_PER_UNIT = 0.02;

/** A market price never falls below this floor (also the hard non-negative bound). */
export const PRICE_FLOOR = 1;

/**
 * Fraction of the current price each unit sold knocks off, rounded UP to an
 * integer (so each unit always moves the price by at least 1). This makes the
 * per-unit impact proportional to value — selling legendary goods drifts the
 * price by more credits than dumping common ore.
 */
export const MARKET_IMPACT = 0.02;

// ---------------------------------------------------------------------------
// Navigation.
// ---------------------------------------------------------------------------

/**
 * Fuel required to warp `distance` (from `warpDistance`). `fuelCost(0) === 0`;
 * for distance > 0 the result is a positive integer, and the function is
 * non-decreasing in distance.
 */
export function fuelCost(distance: number): number {
  if (!(distance > 0)) return 0; // covers 0, negative, and NaN guards
  return Math.ceil(distance * FUEL_PER_DISTANCE);
}

// ---------------------------------------------------------------------------
// Mining.
// ---------------------------------------------------------------------------

/**
 * Remaining abundance of a deposit after `depleted` (in abundance units) has
 * been mined out of an original `base`. Clamped to [0, base]: never negative,
 * never above base, exactly 0 once depletion meets or exceeds base.
 */
export function effectiveAbundance(base: number, depleted: number): number {
  if (!(base > 0)) return 0;
  const remaining = base - Math.max(0, depleted);
  if (remaining <= 0) return 0;
  return Math.min(base, remaining);
}

/**
 * Units mined in one `mine`. Returns 0 when there is no abundance left or no
 * cargo space. Otherwise a positive integer, bounded by `cargoSpace`, that
 * scales with `abundance` (monotonically non-decreasing in abundance for a
 * fixed cargo space). Deterministic — no RNG.
 */
export function miningYield(args: { abundance: number; cargoSpace: number }): number {
  const { abundance, cargoSpace } = args;
  if (abundance <= 0 || cargoSpace <= 0) return 0;
  const raw = Math.ceil(Math.min(1, abundance) * MINE_MAX_UNITS);
  return Math.max(1, Math.min(raw, Math.floor(cargoSpace)));
}

// ---------------------------------------------------------------------------
// Economy.
// ---------------------------------------------------------------------------

/** Credits earned selling `qty` units at `price`. Always non-negative. */
export function sellValue(price: number, qty: number): number {
  return Math.max(0, price * qty);
}

/**
 * The new GLOBAL market price after `qtySold` units are sold at `price`. Each
 * unit drops the price by `ceil(price * MARKET_IMPACT)` (≥ 1), so the result
 * strictly decreases in `qtySold` for `qtySold > 0` until it hits the floor of
 * `PRICE_FLOOR`. Never below the floor, never negative. This is what makes the
 * shared economy "remember" everyone's sales.
 */
export function priceAfterSale(price: number, qtySold: number): number {
  if (qtySold <= 0) return Math.max(PRICE_FLOOR, price);
  const dropPerUnit = Math.max(1, Math.ceil(price * MARKET_IMPACT));
  return Math.max(PRICE_FLOOR, price - qtySold * dropPerUnit);
}
