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
