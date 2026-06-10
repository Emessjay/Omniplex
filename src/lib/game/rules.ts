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

import type { Atmosphere } from "@/lib/universe/types";
import { atmosphereDensity } from "@/lib/universe";

// `atmosphereDensity` is a physical property of an atmosphere type, so it lives
// in the (pure) universe layer now. Re-exported here because the fuel/orbital
// math (`takeoffCost`) and the solar-power curve below both read it, and existing
// importers expect it from `rules`.
export { atmosphereDensity };

// ---------------------------------------------------------------------------
// Tuning constants. Exported so handlers, render, and the data adapters share
// one definition of each knob. Documented inline; tweak here, nowhere else.
// ---------------------------------------------------------------------------

/** Warp fuel burned per unit of `warpDistance`. Warp cost = ceil(distance * this). */
export const WARP_FUEL_PER_DISTANCE = 1;

/**
 * Two fuels (P2). Regular fuel moves you BETWEEN PLANETS within a system
 * (`land` — takeoff + interplanetary travel); warp fuel makes the long
 * system-and-larger `warp` jumps. Warp fuel is deliberately a fair bit pricier
 * to buy than regular fuel (the long-haul drive burns the premium stuff).
 */
export const REGULAR_FUEL_PRICE_PER_UNIT = 3;
export const WARP_FUEL_PRICE_PER_UNIT = 9;

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
 * Whether the SILOED quantities `siloed` cover every input of a production
 * `recipe` (resourceId -> qty per unit) scaled to make `qty` parts. Pure; the
 * production-line analogue of `canCraft` (which checks a single recipe against
 * cargo). A missing input reads as 0 stored. `qty <= 0` is vacuously true (the
 * handler rejects non-positive quantities before producing).
 */
export function canProduce(
  siloed: Record<string, number>,
  recipe: Record<string, number>,
  qty: number = 1,
): boolean {
  if (qty <= 0) return true;
  for (const [resourceId, perUnit] of Object.entries(recipe)) {
    if ((siloed[resourceId] ?? 0) < perUnit * qty) return false;
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

// ---------------------------------------------------------------------------
// Emergency services (`distress`) — the anti-softlock safety net (player-guidance).
//
// `distress` always rescues you (teleport to the nearest station + full heal),
// even when broke, but it stings: it charges a large flat FEE, capped at
// whatever you can pay so it NEVER fails for lack of funds and NEVER drives
// credits negative. The pure cost function takes the player's current credits;
// the handler picks the destination + applies the atomic mutations.
// ---------------------------------------------------------------------------

/**
 * The flat emergency-services fee. Deliberately large — `distress` is a last
 * resort, not cheap travel — but `distressCost` caps it at what you actually
 * have, so it always succeeds (the true safety net).
 */
export const DISTRESS_FEE = 5000;

/**
 * What an emergency rescue costs given the player's current `credits`:
 * `min(credits, DISTRESS_FEE)`. Always `≥ 0` and `≤ credits` (never drives the
 * balance negative — the rescue is guaranteed) and `≤ DISTRESS_FEE` (the wealthy
 * pay the full sting). Pure.
 */
export function distressCost(credits: number, fee: number = DISTRESS_FEE): number {
  const have = Math.max(0, credits);
  return Math.min(have, fee);
}

// ---------------------------------------------------------------------------
// First-discovery bounty (Keystone 3) — exploration pays immediately. The first
// player to chart a planet (the `discoveries` insert wins exactly once per
// planet) earns this flat credit reward. Modest by design: a nice nudge to
// explore, not a primary income source. Awarded in the scan flow off the
// existing once-only discovery gate, so it can never double-pay.
// ---------------------------------------------------------------------------

/** Flat credit reward for being the first to chart a planet. */
export const DISCOVERY_BOUNTY = 250;

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

/**
 * Health after eating a food that heals `healAmount` from `currentHp`, NEVER
 * overhealing past `maxHp`: `min(maxHp, currentHp + max(0, healAmount))`. Pure.
 * Eating at full HP is a no-op (returns `maxHp`); a negative/zero heal can't
 * reduce health. The `eat` handler floors the input HP at the live value.
 */
export function healValue(
  currentHp: number,
  healAmount: number,
  maxHp: number = MAX_HEALTH,
): number {
  return Math.min(maxHp, currentHp + Math.max(0, healAmount));
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
// Bases — buildings & storage (P8a: silos + excavators).
//
// Silos give a base storage CAPACITY; excavators slowly, passively drain the
// region's ore over real time and funnel it into that storage AUTOMATICALLY
// (P13 — realized lazily on base reads, power-gated; there is no `collect`).
// As with mining and regen, the math is PURE and time is passed in as
// `elapsedMs` — the handlers in `commands.ts` supply `now` (Date.now()) and the
// per-region effective abundance (already regen+depletion-adjusted), so these
// stay deterministic and unit-testable. The extracted ore is written back as
// ordinary per-region depletion (`recordDepletion`), so excavation drains the
// SHARED region exactly like manual mining — no separate model.
// ---------------------------------------------------------------------------

/**
 * Per-silo storage capacity, in units. A base's total storage capacity is
 * `SILO_CAPACITY * (number of silos)` (see `baseCapacity`). Tunable.
 */
export const SILO_CAPACITY = 1000;

/**
 * Ore units a single excavator drains per millisecond from a perfectly-rich
 * (abundance 1.0) deposit. Deliberately small — excavators "slowly drain over
 * time": at this rate a full-abundance deposit yields ~10 units/hour per
 * excavator (3_600_000ms / 360_000 = 10), so meaningful accrual takes hours, not
 * seconds. Yield scales down with the deposit's (effective) abundance.
 */
export const EXCAVATOR_RATE_PER_MS = 1 / 360_000;

/**
 * Ore units a single excavator has accrued for a deposit of `abundance` over
 * `elapsedMs`, BEFORE storage-capacity clamping. 0 when `abundance <= 0` or
 * `elapsedMs <= 0`; otherwise `floor(min(1, abundance) * elapsedMs * ratePerMs)`
 * — a non-negative integer that grows monotonically with both abundance and
 * elapsed time. Pure — the handler supplies the real elapsed time and the
 * deposit's current effective abundance.
 */
export function excavatorYield(
  abundance: number,
  elapsedMs: number,
  ratePerMs: number = EXCAVATOR_RATE_PER_MS,
): number {
  if (!(abundance > 0) || !(elapsedMs > 0)) return 0;
  const a = abundance < 1 ? abundance : 1;
  return Math.floor(a * elapsedMs * ratePerMs);
}

/**
 * Total storage capacity of a base with `siloCount` silos: `SILO_CAPACITY`
 * per silo. 0 with no silos. Negative/fractional counts are floored at 0 / down
 * defensively (the caller passes an integer building count).
 */
export function baseCapacity(siloCount: number): number {
  return SILO_CAPACITY * Math.max(0, Math.floor(siloCount));
}

// ---------------------------------------------------------------------------
// Base power (P13) — power plants supply, consumers (excavators + production
// lines) demand, and a base runs its consumers only when supply ≥ demand.
//
// Two plant kinds, each favoring a different environment so SITING is a real
// choice: THERMAL output rises with the region's temperature (great on scorching
// volcanic worlds, near-useless in deep cold); SOLAR output rises as the
// atmosphere THINS (great on vacuum/thin worlds, choked under a dense one). The
// curves are PURE — temperature/atmosphere are passed in (the impure adapters in
// `commands.ts` read them from the universe), no `Date`/RNG/IO here.
//
// Tuned so a single appropriately-sited plant powers a small base (one
// excavator/line), while stacking consumers needs more plants. The gate is
// deliberately all-or-nothing (`powered`); brownouts/batteries are out of scope.
// ---------------------------------------------------------------------------

/** Power one excavator draws. Fixed; > 0 (a consumer always demands power). */
export const EXCAVATOR_POWER_DEMAND = 4;
/** Power one production line draws — pricier than an excavator (heavier machinery). */
export const PRODUCTION_LINE_POWER_DEMAND = 6;
/** Power one blast furnace draws — heavy industry, on par with a production line. */
export const BLAST_FURNACE_POWER_DEMAND = 6;

/**
 * Thermal plant power per °C above `THERMAL_FLOOR_C`. Tuned so a warm region
 * (≳30°C) lets one plant clear an excavator's demand, and a scorching one powers
 * several consumers.
 */
export const THERMAL_OUTPUT_PER_DEG = 0.05;
/** Below this temperature a thermal plant produces nothing (no heat to harvest). */
export const THERMAL_FLOOR_C = -50;

/** Solar power one array makes in a vacuum (atmosphere density 0) — the ceiling. */
export const SOLAR_OUTPUT_MAX = 10;
/** Solar power lost per unit of `atmosphereDensity` (thicker air → less sunlight). */
export const SOLAR_OUTPUT_PER_DENSITY = 4;

/**
 * Power one THERMAL plant produces in a region of `temperature` (°C). Rises
 * linearly with temperature above `THERMAL_FLOOR_C` and is clamped at 0 below it,
 * so it is non-negative and monotonically non-decreasing in temperature. A cold
 * world yields ~nothing; a hot one yields a lot — thermal favors hot worlds.
 */
export function thermalOutput(temperature: number): number {
  return Math.max(0, (temperature - THERMAL_FLOOR_C) * THERMAL_OUTPUT_PER_DEG);
}

/**
 * Power one SOLAR array produces under `atmosphere`. Falls with
 * `atmosphereDensity` (a thinner atmosphere lets more sunlight reach the panels),
 * clamped at 0, so it is non-negative and strictly higher under a thinner
 * atmosphere than a thicker one — solar favors thin-atmosphere/vacuum worlds.
 */
export function solarOutput(atmosphere: Atmosphere): number {
  return Math.max(0, SOLAR_OUTPUT_MAX - SOLAR_OUTPUT_PER_DENSITY * atmosphereDensity(atmosphere));
}

/**
 * Net power balance for a base: total plant `supply` (thermal + solar, sited by
 * the region's `temperature` and the planet's `atmosphere`) minus total consumer
 * `demand` (excavators + production lines). `powered` is `supply >= demand` — an
 * all-or-nothing gate (no brownouts). With no consumers, demand is 0 and the base
 * is trivially powered. Pure & deterministic. Designed to extend: a new plant
 * kind adds a term to `supply`, a new consumer adds one to `demand`.
 */
export function basePower(args: {
  thermalPlants: number;
  solarArrays: number;
  excavators: number;
  productionLines: number;
  blastFurnaces: number;
  temperature: number;
  atmosphere: Atmosphere;
}): { supply: number; demand: number; powered: boolean } {
  const supply =
    Math.max(0, args.thermalPlants) * thermalOutput(args.temperature) +
    Math.max(0, args.solarArrays) * solarOutput(args.atmosphere);
  const demand =
    Math.max(0, args.excavators) * EXCAVATOR_POWER_DEMAND +
    Math.max(0, args.productionLines) * PRODUCTION_LINE_POWER_DEMAND +
    Math.max(0, args.blastFurnaces) * BLAST_FURNACE_POWER_DEMAND;
  return { supply, demand, powered: supply >= demand };
}

// ---------------------------------------------------------------------------
// Agriculture — crop farms + plots (crop-farming phase).
//
// A crop farm is a (non-power-gated) base structure that provides planting
// PLOTS. A player sows a biome-appropriate crop into a free plot (`plant`), it
// grows over real time, and they gather it for a crop material (`harvest`). As
// with regen / excavators / supply reversion, growth is TIME-BASED and the math
// stays PURE: the handler supplies `nowMs` (Date.now()) and the crop's `growMs`
// (from `crops.ts`), so `cropMature` never reads the clock. Deliberately NOT
// power-gated — farming is natural, not industrial (a contrast with excavators /
// production lines / blast furnaces).
// ---------------------------------------------------------------------------

/**
 * Planting plots one crop farm provides. A base's total plot capacity is
 * `CROP_FARM_PLOTS * (number of crop farms)`. Tunable.
 */
export const CROP_FARM_PLOTS = 4;

/**
 * Whether a crop planted at `plantedAtMs` is ripe at `nowMs`, given its `growMs`
 * growth time: `nowMs - plantedAtMs >= growMs`. False before the grow time has
 * elapsed, true exactly at and after it; monotonically non-decreasing in elapsed
 * time. Pure — the handler supplies `Date.now()`; this never reads the clock.
 */
export function cropMature(plantedAtMs: number, nowMs: number, growMs: number): boolean {
  return nowMs - plantedAtMs >= growMs;
}

// ---------------------------------------------------------------------------
// Livestock — ranching + feeding/breeding (animal-husbandry phase).
//
// A livestock pen is a (non-power-gated, like the crop farm) base structure
// that holds animals. A player acquires a head (`ranch`), feeds it crop
// materials (`feed`) to breed the herd over real time, and slaughters head for
// product materials (`slaughter`). As with crop growth, breeding is TIME-BASED
// and the math stays PURE: the handler supplies `nowMs` (Date.now()) and the
// animal's `breedMs` (from `livestock.ts`), so `livestockCanBreed` never reads
// the clock. There is no disease/starvation this phase — not feeding simply
// stalls breeding (no decay).
// ---------------------------------------------------------------------------

/**
 * Head a single livestock pen holds. A base's total livestock capacity is
 * `LIVESTOCK_PEN_CAPACITY * (number of livestock pens)`, counting all animals
 * across types. Tunable.
 */
export const LIVESTOCK_PEN_CAPACITY = 20;

/**
 * Fraction of the current herd that breeds per cycle (rounded down, floored at
 * one new head for any non-empty herd). Tunable; see `breedOffspring`.
 */
export const LIVESTOCK_BREED_RATE = 0.5;

/**
 * Whether a herd last bred at `lastBredAtMs` may breed again at `nowMs`, given
 * the animal's `breedMs` cycle: `nowMs - lastBredAtMs >= breedMs`. False before
 * the cycle has elapsed, true exactly at and after it; monotonically
 * non-decreasing in elapsed time. Pure — the handler supplies `Date.now()`.
 */
export function livestockCanBreed(lastBredAtMs: number, nowMs: number, breedMs: number): boolean {
  return nowMs - lastBredAtMs >= breedMs;
}

/**
 * Feed required to feed a whole herd: `count * qtyPerHead`. Zero for an empty
 * (or non-positive) herd; at least `qtyPerHead` for a single head; strictly
 * increasing in head count. Pure.
 */
export function feedAmount(count: number, qtyPerHead: number): number {
  if (count <= 0) return 0;
  return count * qtyPerHead;
}

/**
 * Offspring a herd of `count` head produces in one breed cycle:
 * `max(1, floor(count * LIVESTOCK_BREED_RATE))` for a non-empty herd, 0 for an
 * empty one. Non-decreasing in `count`. The CALL SITE caps this to the pen's
 * remaining capacity so a breed can't overflow the pen. Pure.
 */
export function breedOffspring(count: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.floor(count * LIVESTOCK_BREED_RATE));
}

// ---------------------------------------------------------------------------
// Navigation (P2: two fuels + orbital mechanics).
//
// Travel splits into two pools with two cost models:
//   * WARP fuel (`warp`, system-and-larger jumps): cost scales ONLY with the
//     generalized `warpDistance` — see `warpFuelCost`.
//   * REGULAR fuel (`land`, planet-to-planet within a system): cost is takeoff
//     (atmosphere + gravity) PLUS an interplanetary component that scales with
//     the TIME-VARYING distance between the two planets' orbits — see
//     `regularFuelCost`. Region `jump` is free (no interplanetary move).
//
// Everything here is PURE & DETERMINISTIC: the caller passes `timeMs`
// (`Date.now()` in the handlers); these functions never read the clock or RNG.
// ---------------------------------------------------------------------------

/**
 * Warp fuel required to traverse `distance` (from `warpDistance`).
 * `warpFuelCost(0) === 0`; for distance > 0 the result is a positive integer,
 * and the function is non-decreasing in distance. Scales ONLY with distance
 * (no takeoff / planet terms — that's regular fuel's job). Replaces the old
 * single `fuelCost` for warps.
 */
export function warpFuelCost(distance: number): number {
  if (!(distance > 0)) return 0; // covers 0, negative, and NaN guards
  return Math.ceil(distance * WARP_FUEL_PER_DISTANCE);
}

/** The three orbital fields of a planet that the orbital math depends on. */
export interface OrbitLike {
  orbitalRadius: number;
  orbitalPeriod: number;
  orbitalPhase: number;
}

/**
 * A planet's position in its orbital plane at absolute time `timeMs`. The orbit
 * is a circle of `orbitalRadius` swept at a constant angular rate set by
 * `orbitalPeriod`, starting from `orbitalPhase` at t=0:
 *   angle = orbitalPhase + 2π · (timeMs / orbitalPeriod)
 * Pure & periodic — `planetPosition(o, t)` equals `planetPosition(o, t + period)`.
 * A non-positive period degenerates to a fixed point at the phase angle.
 */
export function planetPosition(
  orbit: OrbitLike,
  timeMs: number,
): { x: number; y: number } {
  const sweep = orbit.orbitalPeriod > 0 ? (2 * Math.PI * timeMs) / orbit.orbitalPeriod : 0;
  const angle = orbit.orbitalPhase + sweep;
  return {
    x: orbit.orbitalRadius * Math.cos(angle),
    y: orbit.orbitalRadius * Math.sin(angle),
  };
}

/**
 * Euclidean distance between two planets' orbital positions at `timeMs`. Always
 * ≥ 0, symmetric in its two orbit arguments, and (because the two planets sweep
 * at different rates) it VARIES with `timeMs` — the same pair is generally a
 * different distance apart at a different time. Pure.
 */
export function interplanetaryDistance(
  a: OrbitLike,
  b: OrbitLike,
  timeMs: number,
): number {
  const pa = planetPosition(a, timeMs);
  const pb = planetPosition(b, timeMs);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** Base regular-fuel cost of a takeoff before atmosphere/gravity scaling. */
export const TAKEOFF_BASE = 2;
/** How much each unit of atmosphere density ADDS to the pre-gravity takeoff. */
export const TAKEOFF_ATM_COEF = 1.5;
/** Regular fuel per unit of interplanetary distance (the inter component). */
export const INTERPLANETARY_FUEL_PER_DISTANCE = 0.5;

/**
 * Regular fuel to lift off a planet: atmosphere density adds (lightly,
 * additively) to a base, then the whole thing is multiplied (linearly) by
 * gravity — a thick-aired, high-gravity world is the costliest to leave:
 *   (TAKEOFF_BASE + TAKEOFF_ATM_COEF · atmosphereDensity(atm)) · gravity
 * Positive for gravity > 0; rises with both atmosphere density and gravity.
 * Not rounded (the integer rounding happens in `regularFuelCost`).
 */
export function takeoffCost(atmosphere: Atmosphere, gravity: number): number {
  const g = Math.max(0, gravity);
  return (TAKEOFF_BASE + TAKEOFF_ATM_COEF * atmosphereDensity(atmosphere)) * g;
}

/**
 * Regular fuel to fly from planet `from` to planet `to` at time `timeMs`:
 * the takeoff cost from `from` PLUS an interplanetary component scaled from the
 * (time-varying) `interplanetaryDistance` between the two orbits. The two
 * components are ADDITIVE; the result is a positive integer (`ceil`, so it is
 * always ≥ the takeoff component alone). Pure — `timeMs` is supplied by the
 * caller.
 *
 * SUPERSEDED for the player-facing travel commands by the orbit-land split
 * (`orbitFuelCost` + `launchFuelCost`): orbiting bills the interplanetary
 * distance only, launch bills the atmosphere/gravity climb only, and descent is
 * free. Kept here because it is the canonical "what a planet-to-planet hop used
 * to cost as one lump" function and is still exercised by the fuel-orbital unit
 * suite. Do not charge it as a single piece in commands.
 */
export function regularFuelCost(
  from: { atmosphere: Atmosphere; gravity: number; orbit: OrbitLike },
  to: { orbit: OrbitLike },
  timeMs: number,
): number {
  const takeoff = takeoffCost(from.atmosphere, from.gravity);
  const inter = INTERPLANETARY_FUEL_PER_DISTANCE * interplanetaryDistance(from.orbit, to.orbit, timeMs);
  return Math.max(1, Math.ceil(takeoff + inter));
}

/**
 * Regular fuel to ORBIT from one planet to another within a system (orbit-land):
 * the interplanetary half of the old `regularFuelCost`, with NO takeoff/atmosphere
 * term. Cost = `ceil(INTERPLANETARY_FUEL_PER_DISTANCE * interplanetaryDistance)`.
 * 0 to self (you don't move), a positive integer between distinct planets, and
 * TIME-VARYING (the planets sweep their orbits). Orbiting selects/flies to a
 * planet without descending, so it never pays the atmosphere climb — that is
 * billed separately on `launch`. Pure — `timeMs` is supplied by the caller.
 */
export function orbitFuelCost(from: OrbitLike, to: OrbitLike, timeMs: number): number {
  return Math.ceil(INTERPLANETARY_FUEL_PER_DISTANCE * interplanetaryDistance(from, to, timeMs));
}

/**
 * Regular fuel to LAUNCH off a planet's surface back into orbit (orbit-land):
 * the atmosphere/gravity half of the old `regularFuelCost`, with NO distance
 * term — it depends only on the world you're climbing out of. Equal to
 * `takeoffCost(atmosphere, gravity)` (the handler `ceil`s it to a whole fuel
 * unit). Descent (`land`) is free; the climb back out is where the atmosphere is
 * billed. Pure — exactly two parameters (no time/distance input).
 */
export function launchFuelCost(atmosphere: Atmosphere, gravity: number): number {
  return takeoffCost(atmosphere, gravity);
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

// ---------------------------------------------------------------------------
// Biofuel — the anti-softlock conversion (P12a).
//
// `craft biofuel <flora|animal material>` refines plant/animal materials into
// REGULAR fuel so a pilot can never be permanently stranded with an empty tank
// in deep space (where the economy — `buy fuel` — is now gated to settlements /
// outposts). It is deliberately INEFFICIENT: only `BIOFUEL_EFFICIENCY` of the
// materials' credit value comes back as fuel, so it is always a value loss vs
// just selling the materials and buying fuel at a market — a last resort, never
// an economy. Pure & deterministic (the handler validates ownership + persists).
// ---------------------------------------------------------------------------

/**
 * Fraction of a refined material's credit value that is recovered as fuel; the
 * rest is lost in the conversion. Strictly < 1, so `biofuelYield` always obeys
 * the loss invariant regardless of the fuel price. Tunable.
 */
export const BIOFUEL_EFFICIENCY = 0.5;

/**
 * Regular-fuel units produced by refining `qty` units of a material worth
 * `materialValue` credits each. Recovers `BIOFUEL_EFFICIENCY` of the materials'
 * total credit value and converts it to fuel at `REGULAR_FUEL_PRICE_PER_UNIT`,
 * floored to a whole unit. A non-negative integer; 0 for non-positive inputs.
 * Monotonically non-decreasing in both `materialValue` and `qty`.
 *
 * LOSS INVARIANT (the reason biofuel exists only as a last resort): the credit
 * value of the fuel produced is STRICTLY LESS than the credit value of the
 * materials consumed — `biofuelYield(v, q) * REGULAR_FUEL_PRICE_PER_UNIT
 * < v * q` for all `v, q > 0`. Because `fuel ≤ v·q·EFF / PRICE`, we get
 * `fuel · PRICE ≤ v·q·EFF < v·q` since `EFF < 1`.
 */
export function biofuelYield(materialValue: number, qty: number): number {
  if (!(materialValue > 0) || !(qty > 0)) return 0;
  const recoveredCredits = materialValue * qty * BIOFUEL_EFFICIENCY;
  return Math.floor(recoveredCredits / REGULAR_FUEL_PRICE_PER_UNIT);
}

// ---------------------------------------------------------------------------
// Per-system, self-reverting market SUPPLY (P12b).
//
// The finite buyable supply of upgrades AND ship parts is now PER-SYSTEM and
// gradually reverts toward a "normal" baseline over real time, with NO player
// present — a system bought out by demand slowly restocks; one flooded by
// players selling slowly drains back. This is the SUPPLY-side mirror of
// `priceTowardBase`'s mean-reversion: the same apply-on-read, persist-on-write
// discipline, with `elapsedMs` passed in (the impure adapters in `world.ts`
// compute it from a stored `updated_at` and supply `now`), so the math stays
// pure & deterministic. A system+item with no stored row reads as its baseline.
// ---------------------------------------------------------------------------

/**
 * The "normal" buyable stock of an upgrade each system reverts toward (the old
 * P9a global seed). A bought-out system climbs back up to this; an over-sold one
 * settles back down to it.
 */
export const UPGRADE_SUPPLY_BASELINE = 3;

/**
 * The "normal" buyable stock of a ship part each system reverts toward. A bit
 * higher than upgrades — parts are the bulk commodity traded in P12b.
 */
export const PART_SUPPLY_BASELINE = 5;

/**
 * Units of supply that revert toward the baseline per millisecond. Deliberately
 * small ("gradual"): at ~1 unit/hour a bought-out system creeps back to a
 * baseline of a handful over several hours, on the same human-scale clock as
 * `PRICE_REVERT_PER_MS`. A rate per ms, like the other living-economy knobs.
 */
export const SUPPLY_REVERT_PER_MS = 1 / 3_600_000;

/**
 * Effective supply after reverting toward `baseline` over `elapsedMs`. Moves
 * `supply` toward `baseline` by `ratePerMs * elapsedMs`, NEVER overshooting: a
 * supply below baseline rises to at most baseline, one above falls to at least
 * baseline, one already at baseline is unchanged. Clamped ≥ 0 and rounded to an
 * integer (the stored `supply` column is an integer ≥ 0). The supply-side mirror
 * of `priceTowardBase`; monotonic toward baseline in `elapsedMs`. Pure.
 */
export function supplyTowardBaseline(
  supply: number,
  baseline: number,
  elapsedMs: number,
  ratePerMs: number = SUPPLY_REVERT_PER_MS,
): number {
  const move = Math.max(0, ratePerMs * elapsedMs);
  let next: number;
  if (supply < baseline) {
    next = Math.min(baseline, supply + move);
  } else if (supply > baseline) {
    next = Math.max(baseline, supply - move);
  } else {
    next = supply;
  }
  return Math.max(0, Math.round(next));
}
