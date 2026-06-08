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
 * Per-unit price stickiness: the fraction by which ONE traded unit nudges the
 * price, COMPOUNDED over the quantity (geometric, NOT a per-unit ≥1 floor).
 * Selling multiplies the price by `(1 - PRICE_IMPACT)` per unit, buying by
 * `(1 + PRICE_IMPACT)` per unit (see `priceAfterSale` / `priceAfterPurchase`).
 *
 * Deliberately tiny so prices are HARD to move: a ~10-unit trade shifts a
 * 1000-credit price by under ~2% (≈ ±15cr), and it takes hundreds of units of
 * cumulative volume to swing a price substantially (≈500 units ≈ a 50% move).
 * Because the model is multiplicative there is NO per-unit minimum, so a single
 * unit of a cheap good rounds to no change at all — only real volume bites.
 */
export const PRICE_IMPACT = 0.0015;

// ---------------------------------------------------------------------------
// Living economy — slow recovery of the shared world.
//
// REGEN and PRICE_REVERT are deliberately "very slow": the world heals on a
// human-scale clock (hours/days), not per-command. Both are *rates per
// millisecond*; the impure adapters in `world.ts` compute `elapsedMs` from a
// stored timestamp and pass it in so these functions stay pure & deterministic.
// ---------------------------------------------------------------------------

/**
 * Abundance-units of depletion that regenerate per millisecond. Tuned so a
 * fully-drained ~1.0 vein recovers over ~24h of real time
 * (1.0 / 86_400_000ms ≈ 1.157e-8 per ms). Small on purpose — a mined-out planet
 * becomes worth revisiting "tomorrow", not on the next scan.
 */
export const REGEN_PER_MS = 1 / 86_400_000;

/**
 * Credits of price recovered toward `base` per millisecond. Tuned so a price
 * displaced by ~100 credits drifts back to base over ~several hours
 * (100 / (5 * 3_600_000ms) ≈ 5.56e-6 per ms ≈ 5e-6). A crashed or spiked price
 * settles back toward its baseline value while the market is left untraded.
 */
export const PRICE_REVERT_PER_MS = 5e-6;

/** Buy markup over the current price: a `buy` pays 150% of the sell price. */
export const BUY_MARKUP = 1.5;

/**
 * Remaining effective depletion after regeneration. `elapsedMs` is the time
 * since the deposit was last mined; `regenPerMs * elapsedMs` abundance-units
 * have healed back. Result is clamped to [0, totalDepleted]: it only shrinks,
 * never below 0 (a fully recovered vein reads as 0 depletion) and never above
 * the original depletion. Monotonically non-increasing in `elapsedMs`.
 */
export function regeneratedDepletion(
  totalDepleted: number,
  elapsedMs: number,
  regenPerMs: number = REGEN_PER_MS,
): number {
  if (!(totalDepleted > 0)) return 0;
  const recovered = Math.max(0, regenPerMs * elapsedMs);
  const remaining = totalDepleted - recovered;
  return Math.max(0, Math.min(totalDepleted, remaining));
}

/**
 * Effective price after mean-reversion toward `base`. Moves `price` toward
 * `base` by `revertPerMs * elapsedMs`, NEVER overshooting: a price below base
 * rises to at most base, a price above base falls to at least base, an
 * already-at-base price is unchanged. Stays ≥ `PRICE_FLOOR`. Monotonic toward
 * base in `elapsedMs`.
 */
export function priceTowardBase(
  price: number,
  base: number,
  elapsedMs: number,
  revertPerMs: number = PRICE_REVERT_PER_MS,
): number {
  const move = Math.max(0, revertPerMs * elapsedMs);
  let next: number;
  if (price < base) {
    next = Math.min(base, price + move);
  } else if (price > base) {
    next = Math.max(base, price - move);
  } else {
    next = price;
  }
  return Math.max(PRICE_FLOOR, next);
}

/** Per-unit buy cost: ceil(price * BUY_MARKUP). Always ≥ price (for price ≥ 0). */
export function buyUnitCost(price: number): number {
  return Math.ceil(Math.max(0, price) * BUY_MARKUP);
}

/**
 * The new GLOBAL market price after `qtyBought` units are BOUGHT at `price` —
 * the mirror of `priceAfterSale`. The price is multiplied by
 * `(1 + PRICE_IMPACT)` per unit (compounding over `qtyBought`) and rounded, so
 * it is monotonically NON-DECREASING in `qtyBought` and only actually rises once
 * the cumulative volume is large enough to round up — a single unit of a cheap
 * good leaves the price unchanged. Buying nothing is a no-op. Never below
 * `PRICE_FLOOR`. This is what lets sustained demand push the shared price up.
 */
export function priceAfterPurchase(price: number, qtyBought: number): number {
  if (qtyBought <= 0) return Math.max(PRICE_FLOOR, price);
  const raised = price * (1 + PRICE_IMPACT) ** qtyBought;
  return Math.max(PRICE_FLOOR, Math.round(raised));
}

// ---------------------------------------------------------------------------
// Crafting / ship upgrades.
//
// The first synthesis vertical. The upgrade *catalog* (ids, names, recipes)
// lives in `upgrades.ts` — these are just the pure knobs and predicates the
// catalog and the handlers share. Owning ≥ 1 of an upgrade activates its
// capability; the landing gate below is the only capability today.
// ---------------------------------------------------------------------------

/**
 * Sell-value markup of a crafted upgrade over its raw component cost
 * ("a bit above"). Locked by tests to (1, 2): an upgrade sells for more than
 * its parts but less than double. `upgradeValue` (in `upgrades.ts`) applies it.
 */
export const CRAFT_VALUE_MARKUP = 1.2;

/** Below this surface temperature (°C) a world is freezing — needs Antifreeze. */
export const FREEZING_C = 0;
/** Above this surface temperature (°C) a world is boiling — needs Ablative Shields. */
export const BOILING_C = 100;

/**
 * Whether the held resource quantities `have` cover every component of
 * `recipe` (resourceId -> qty). Pure. A missing component reads as 0 held.
 */
export function canCraft(
  have: Record<string, number>,
  recipe: Record<string, number>,
): boolean {
  for (const [resourceId, qty] of Object.entries(recipe)) {
    if ((have[resourceId] ?? 0) < qty) return false;
  }
  return true;
}

/**
 * The upgrade id required to land at `temperature`, or `null` if a bare ship
 * survives. `temp < FREEZING_C` → `"antifreeze_tanks"`; `temp > BOILING_C` →
 * `"ablative_shields"`; otherwise null. The boundary temps themselves
 * (FREEZING_C / BOILING_C) are survivable bare.
 */
export function landingRequirement(temperature: number): string | null {
  if (temperature < FREEZING_C) return "antifreeze_tanks";
  if (temperature > BOILING_C) return "ablative_shields";
  return null;
}

/**
 * Whether a player owning the upgrade ids in `owned` can land at `temperature`.
 * `{ ok: true }` when no upgrade is required or the required one is owned;
 * otherwise `{ ok: false, required }` naming the missing upgrade.
 */
export function canLand(
  temperature: number,
  owned: Iterable<string>,
): { ok: true } | { ok: false; required: string } {
  const required = landingRequirement(temperature);
  if (required === null) return { ok: true };
  for (const id of owned) {
    if (id === required) return { ok: true };
  }
  return { ok: false, required };
}

// ---------------------------------------------------------------------------
// Survival — the on-foot hazard model.
//
// Disembarked actions (mining; later: exploring/scavenging) happen on the
// planet's surface, where its `hazard` can wound you. The danger has two
// independent dials, BOTH rising with hazard: the *chance* an action harms you
// at all, and the *amount* of damage when it does. The handler supplies real
// randomness (two `Math.random()` rolls); these functions stay pure &
// deterministic by taking the rolls as parameters. Health is integer hit points
// in `[0, MAX_HEALTH]`; hitting 0 triggers the death sequence in `commands.ts`.
// ---------------------------------------------------------------------------

/** Maximum (and starting) hit points. */
export const MAX_HEALTH = 100;

/** Fraction of credits lost on death: `floor(credits * (1 - this))` survives. */
export const DEATH_GOLD_PENALTY = 0.1;

/**
 * The most damage a single disembarked action can deal, on a maximally hostile
 * world (hazard 1.0) with the worst magnitude roll. At MAX_HEALTH 100 this means
 * a savage world kills in a handful of mines, while a calm one is survivable.
 */
export const HAZARD_DAMAGE_MAX = 40;

/** Clamp a 0..1 quantity into `[0, 1]` (NaN-safe → 0). */
function clamp01(x: number): number {
  if (!(x > 0)) return 0;
  return x < 1 ? x : 1;
}

/**
 * Probability in `[0, 1]` that a disembarked action harms you. Rises with
 * hazard — directly proportional, so a calm world (hazard 0) is perfectly safe
 * and a maximally hostile one (hazard 1) always bites. Monotonically
 * non-decreasing in hazard.
 */
export function damageChance(hazard: number): number {
  return clamp01(hazard);
}

/**
 * Damage dealt by a HARMFUL disembarked action. Scales with hazard (the savage
 * danger) and with `roll` ∈ [0,1) for per-hit variability: the magnitude spans
 * roughly half-to-full of `HAZARD_DAMAGE_MAX * hazard`. A positive integer for
 * hazard > 0, monotonically non-decreasing in BOTH hazard and roll. Pure — the
 * caller supplies `roll`.
 */
export function damageAmount(hazard: number, roll: number): number {
  const h = clamp01(hazard);
  const variability = 0.5 + 0.5 * clamp01(roll); // [0.5, 1.0], non-decreasing in roll
  const raw = HAZARD_DAMAGE_MAX * h * variability;
  if (h <= 0) return 0;
  return Math.max(1, Math.round(raw));
}

/**
 * One disembarked-action hazard roll. `chanceRoll` / `magnitudeRoll` ∈ [0,1) are
 * supplied by the caller (the handler uses `Math.random()`; tests pass fixed
 * values). Returns the damage taken: 0 when `chanceRoll >= damageChance(hazard)`
 * (the action was harmless this time), else `damageAmount(hazard, magnitudeRoll)`.
 */
export function rollHazardDamage(
  hazard: number,
  chanceRoll: number,
  magnitudeRoll: number,
): number {
  if (chanceRoll >= damageChance(hazard)) return 0;
  return damageAmount(hazard, magnitudeRoll);
}

/**
 * Credits remaining after death: `floor(credits * (1 - DEATH_GOLD_PENALTY))`,
 * never negative. The difference from the prior balance is what was lost.
 */
export function creditsAfterDeath(credits: number): number {
  return Math.max(0, Math.floor(Math.max(0, credits) * (1 - DEATH_GOLD_PENALTY)));
}

// ---------------------------------------------------------------------------
// Wildlife — exploring, and on-foot combat with fauna (P5).
//
// Exploring a region (on foot) rolls one of three outcomes; encountering a
// hostile creature drops you into a simultaneous-damage combat loop. As with the
// hazard model above, the math is PURE: the handlers in `commands.ts` supply the
// real `Math.random()` rolls and the creature stats (from the `wildlife.ts`
// catalog), so these functions stay deterministic and unit-testable.
// ---------------------------------------------------------------------------

/**
 * Flat player attack power per combat round. A constant for now — no weapon /
 * attack upgrades yet (that's a later phase). Tuned so a bare pilot can kill the
 * weaker fauna in a few rounds but a savage beast is a real threat.
 */
export const PLAYER_BASE_ATTACK = 12;

/**
 * Outcome thresholds for one `explore`, partitioning the roll range `[0, 1)`:
 *   - `[0, 0.30)`   → scavenge (loot a material)
 *   - `[0.30, 0.65)`→ flora    (a harvestable plant)
 *   - `[0.65, 1)`   → fauna    (a creature)
 * Tunable here. (The bands are deliberately close so all three are common.)
 */
export const EXPLORE_SCAVENGE_MAX = 0.3;
export const EXPLORE_FLORA_MAX = 0.65;

/**
 * Map an explore roll in `[0, 1)` to its outcome. Pure & total: every roll
 * yields exactly one of the three outcomes (out-of-range rolls clamp to the
 * nearest band). See the threshold constants above.
 */
export function exploreOutcome(roll: number): "scavenge" | "flora" | "fauna" {
  if (roll < EXPLORE_SCAVENGE_MAX) return "scavenge";
  if (roll < EXPLORE_FLORA_MAX) return "flora";
  return "fauna";
}

/**
 * Resolve ONE simultaneous combat round: the player and the creature deal their
 * damage at the SAME time, so both can die in a single round. New HPs are
 * clamped to `≥ 0`; the `*Dead` flags report who (possibly both) hit 0. Pure —
 * no RNG (combat damage is flat in this phase). The handler reads
 * `PLAYER_BASE_ATTACK` and the creature's `attack` from the catalog and feeds
 * them in.
 */
export function combatRound(args: {
  playerHp: number;
  playerAtk: number;
  creatureHp: number;
  creatureAtk: number;
}): { playerHp: number; creatureHp: number; playerDead: boolean; creatureDead: boolean } {
  const playerHp = Math.max(0, args.playerHp - Math.max(0, args.creatureAtk));
  const creatureHp = Math.max(0, args.creatureHp - Math.max(0, args.playerAtk));
  return {
    playerHp,
    creatureHp,
    playerDead: playerHp <= 0,
    creatureDead: creatureHp <= 0,
  };
}

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
 * The new GLOBAL market price after `qtySold` units are sold at `price`. The
 * price is multiplied by `(1 - PRICE_IMPACT)` per unit (compounding over
 * `qtySold`) and rounded, so it is monotonically NON-INCREASING in `qtySold`
 * and only actually drops once the cumulative volume is large enough to round
 * down — a single unit of a cheap good leaves the price unchanged. Selling
 * nothing is a no-op. Floored at `PRICE_FLOOR`, never negative. This is what
 * makes the shared economy "remember" everyone's sales without letting a tiny
 * trade crater the price.
 */
export function priceAfterSale(price: number, qtySold: number): number {
  if (qtySold <= 0) return Math.max(PRICE_FLOOR, price);
  const dropped = price * (1 - PRICE_IMPACT) ** qtySold;
  return Math.max(PRICE_FLOOR, Math.round(dropped));
}
