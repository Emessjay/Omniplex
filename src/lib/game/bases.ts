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
export const STRUCTURE_KINDS = ["silo", "excavator", "production_line"] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

/** True iff `kind` is a buildable in-base structure (silo/excavator/production_line). */
export function isStructureKind(kind: string): kind is StructureKind {
  return (STRUCTURE_KINDS as readonly string[]).includes(kind);
}

/**
 * What each in-base structure costs to `build` — tunable. Keys are the literal
 * `credits` (charged against the balance) or a mineral id (consumed from cargo).
 * Silos are cheaper (raw storage); excavators cost more (active machinery); a
 * production line is the priciest (it manufactures advanced parts).
 */
export const BUILDING_BUILD_COST: Readonly<Record<StructureKind, Readonly<Record<string, number>>>> = {
  silo: { credits: 300, iron: 5 },
  excavator: { credits: 400, titanium: 3, iron: 5 },
  production_line: { credits: 600, titanium: 5, copper: 5 },
};

/** The cost map for one structure kind. */
export function buildingCost(kind: StructureKind): Readonly<Record<string, number>> {
  return BUILDING_BUILD_COST[kind];
}

/** The credits portion of a cost map (the `credits` line, 0 if absent). */
export function creditsOf(cost: Record<string, number>): number {
  return cost.credits ?? 0;
}

/** The mineral ingredients of a cost map (everything except `credits`). */
export function mineralsOf(cost: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(cost).filter(([k]) => k !== "credits"));
}
