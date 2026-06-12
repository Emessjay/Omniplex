/**
 * Bases catalog + build-cost rules (P7) — the pure, code-side source of truth
 * for what it costs to establish a base, the way `upgrades.ts` is for ship gear.
 *
 * A base is a player's claim on a region; other players see it (see the `bases`
 * table + `world.ts` adapters + `scan`). This phase is the base ITSELF plus its
 * cross-player visibility — buildings INSIDE bases (excavators / silos /
 * production lines) are P8, which will extend the `build` command's structure
 * domain beyond the single `base` it accepts today.
 *
 * The build cost is a tunable constant. It mixes `credits` with mineral
 * ingredients (mined resources consumed from the cargo hold), all in one record
 * so `canAffordBase` can check the whole bill uniformly; the handler splits the
 * `credits` line off the mineral lines when it charges + consumes.
 */

/**
 * What it costs to `build base` in a region — tunable. Keys are either the
 * literal `credits` (charged against the player's balance) or a mineral id
 * (consumed from the cargo hold). A modest bill: a little titanium + iron, plus
 * a credits fee, so a base is an investment but reachable early.
 */
export const BASE_BUILD_COST: Readonly<Record<string, number>> = {
  credits: 500,
  titanium: 2,
  iron: 5,
};

/** The credits portion of the build cost (the `credits` line of `BASE_BUILD_COST`). */
export const BASE_BUILD_CREDITS: number = BASE_BUILD_COST.credits ?? 0;

/**
 * The mineral ingredients of the build cost (everything except `credits`),
 * `{ resourceId: qty }`. Consumed from the cargo hold when building.
 */
export const BASE_BUILD_MINERALS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(BASE_BUILD_COST).filter(([k]) => k !== "credits"),
);

/**
 * Whether `have` covers every line of `cost`. `have` maps each cost key (the
 * literal `credits` and each mineral id) to the amount the player has on hand;
 * `canAffordBase` returns true iff every required amount is met. Pure — the
 * handler builds `have` from the live credit balance + cargo before charging.
 */
export function canAffordBase(
  have: Record<string, number>,
  cost: Record<string, number> = BASE_BUILD_COST,
): boolean {
  return Object.entries(cost).every(([key, need]) => (have[key] ?? 0) >= need);
}

// ---------------------------------------------------------------------------
// Buildings inside a base (P8a: silos + excavators). Like `BASE_BUILD_COST`,
// each is a tunable cost map mixing the literal `credits` key with mineral ids
// (consumed from the cargo hold). `canAffordBase` checks any of them uniformly.
// ---------------------------------------------------------------------------

/**
 * The in-base structures buildable today (beyond the base itself): P8a's silo
 * (storage) and excavator (passive ore drain), plus P8b's production_line (turns
 * siloed raw minerals into advanced ship parts via `produce`). Grows further in
 * later phases.
 */
export const STRUCTURE_KINDS = [
  "silo",
  "excavator",
  "production_line",
  // P13: power plants. Excavators + production lines only run when a base's
  // plants supply enough power (see `basePower` in `rules.ts`). Thermal favors
  // hot regions; solar favors thin-atmosphere worlds — siting is a real choice.
  "thermal_plant",
  "solar_array",
  // blast-furnace phase: smelts siloed raw metal into ingots via `produce
  // <ingot>`. A power consumer like the production line (heavy industry); see
  // `BLAST_FURNACE_POWER_DEMAND` / `basePower` in `rules.ts`.
  "blast_furnace",
  // crop-farming phase: provides planting PLOTS for `plant`/`harvest`.
  // Deliberately NOT power-gated (agriculture is natural, not industrial), so it
  // contributes no term to `basePower`. See `CROP_FARM_PLOTS` in `rules.ts`.
  "crop_farm",
  // animal-husbandry phase: holds livestock for `ranch`/`feed`/`slaughter`. Like
  // the crop farm, agriculture — NOT power-gated. Each pen provides
  // `LIVESTOCK_PEN_CAPACITY` head (see `rules.ts`).
  "livestock_pen",
  // base-raids phase (Combat-2a): DEFENSE buildings. A `turret` arms the base's
  // attack profile, a `shield_generator` its shield (see `baseDefenseStats` in
  // `combat.ts`). Both are POWER-GATED consumers (`TURRET_POWER_DEMAND` /
  // `SHIELD_POWER_DEMAND` in `rules.ts`) — an unpowered base can't run its guns,
  // which is exactly what makes it raidable. They never reduce capacity; they
  // turn a base into the "enemy" an attacker's `raid` fights.
  "turret",
  "shield_generator",
] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

/** True iff `kind` is a buildable in-base structure (silo/excavator/.../plants). */
export function isStructureKind(kind: string): kind is StructureKind {
  return (STRUCTURE_KINDS as readonly string[]).includes(kind);
}

/**
 * What each in-base structure costs to `build` — tunable. Keys are the literal
 * `credits` (charged against the balance) or a mineral id (consumed from cargo).
 * Silos are cheaper (raw storage); excavators cost more (active machinery); a
 * production line is the priciest (it manufactures advanced parts). Power plants
 * (P13) sit in the excavator/line price band — a real investment that powers the
 * consumers you build.
 */
export const BUILDING_BUILD_COST: Readonly<Record<StructureKind, Readonly<Record<string, number>>>> = {
  silo: { credits: 300, iron: 5 },
  excavator: { credits: 400, titanium: 3, iron: 5 },
  production_line: { credits: 600, titanium: 5, copper: 5 },
  thermal_plant: { credits: 500, iron: 5, copper: 5 },
  solar_array: { credits: 500, silica: 5, copper: 5 },
  // Heavy industry — the priciest structure (it opens the smelting tier).
  blast_furnace: { credits: 700, iron: 8, copper: 4 },
  // Agriculture — a modest, early-reachable cost (no power plant needed to run
  // it). Provides `CROP_FARM_PLOTS` planting plots.
  crop_farm: { credits: 350, iron: 4 },
  // Agriculture — a livestock pen (also not power-gated). Holds
  // `LIVESTOCK_PEN_CAPACITY` head; slightly pricier than a crop farm.
  livestock_pen: { credits: 400, iron: 5 },
  // Defense (Combat-2a) — a turret arms the base; a shield generator protects it.
  // Priced in the industrial band (metals + credits): a real investment in
  // keeping a base raid-proof, gated further by needing power to run.
  turret: { credits: 500, iron: 6, titanium: 3 },
  shield_generator: { credits: 600, copper: 5, titanium: 4 },
};

/** The cost map for one structure kind. */
export function buildingCost(kind: StructureKind): Readonly<Record<string, number>> {
  return BUILDING_BUILD_COST[kind];
}

// ---------------------------------------------------------------------------
// Base tiers (Keystone 2c). A base has a tier (1..MAX_BASE_TIER); `upgrade base`
// raises it by one, multiplying the base's storage capacity (see
// `baseTierMultiplier`/`baseCapacity` in `rules.ts`). The upgrade is an ONGOING
// production sink: it costs credits plus siloed PARTS/INGOTS (not raw cargo
// minerals — these are advanced goods consumed from the silo), and the bill
// scales UP with the current tier so leveling deepens the longer you climb.
// ---------------------------------------------------------------------------

/**
 * What it costs to upgrade a base from `currentTier` → `currentTier + 1`, in
 * credits plus siloed PART/INGOT ids — a deepening sink that scales UP with the
 * current tier (both the credits and every part/ingot line grow with `tier`).
 * Defined for tiers `1 .. MAX_BASE_TIER - 1` (the handler refuses upgrades at
 * MAX_BASE_TIER before calling this). Like `BASE_BUILD_COST`, the `credits` key
 * is charged against the wallet; the remaining keys (real `parts.ts`/`ingots.ts`
 * ids) are consumed from `base_storage` (the silo). Tunable. Pure.
 */
export function baseUpgradeCost(currentTier: number): Record<string, number> {
  const t = Math.max(1, Math.floor(currentTier));
  return {
    credits: 1000 * t,
    iron_ingot: 5 * t,
    titanium_ingot: 3 * t,
    hull_plating: 2 * t,
  };
}

/** The credits portion of a tier-upgrade cost (charged against the balance). */
export function upgradeCredits(currentTier: number): number {
  return creditsOf(baseUpgradeCost(currentTier));
}

/**
 * The siloed PART/INGOT ingredients of a tier-upgrade cost (everything except
 * `credits`), `{ itemId: qty }`. Consumed from `base_storage` when upgrading.
 */
export function upgradeMinerals(currentTier: number): Record<string, number> {
  return mineralsOf(baseUpgradeCost(currentTier));
}

/** The credits portion of a cost map (the `credits` line, 0 if absent). */
export function creditsOf(cost: Record<string, number>): number {
  return cost.credits ?? 0;
}

/** The mineral ingredients of a cost map (everything except `credits`). */
export function mineralsOf(cost: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(cost).filter(([k]) => k !== "credits"));
}
