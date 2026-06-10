/**
 * Ship-upgrade catalog — the source of truth for manufactured/tradeable
 * permanent upgrades, the way `RESOURCES` is for minerals and `PARTS` is for
 * intermediate ship parts.
 *
 * P9a turned upgrades into MANUFACTURED goods: an `Upgrade` has a `recipe` of
 * **ship parts** (P8b — `hull_plating`, `alloy_beam`, …) consumed at a base's
 * production line via `produce` (NOT manual `craft`, which now only cooks food).
 * Its derived sell value is a bit above the summed value of its part inputs
 * (`CRAFT_VALUE_MARKUP`, defined in `rules.ts`) — now a much higher absolute
 * number than the old raw-mineral recipes, since parts are valuable. Owning ≥ 1
 * activates the upgrade's capability (the landing gate in `rules.ts`).
 *
 * The buy PRICE stays fully code-derived (upgrades are NOT in the `markets`
 * table and never drift); what's new in P9a is a finite, player-driven buyable
 * SUPPLY (the `upgrade_market` table): `buy` decrements it, `sell`/manufacture
 * increments it. The supply gate is the pure `canBuyFromSupply` below.
 *
 * Keep it general: more upgrades/recipes drop in by extending `UPGRADES`. Recipe
 * keys are PART ids (validated against `PARTS`); quantities are tuned here.
 */
import { getPart } from "./parts";
import { CRAFT_VALUE_MARKUP } from "./rules";

export interface Upgrade {
  id: "ablative_shields" | "antifreeze_tanks" | "radiation_shield";
  name: string;
  /** partId -> quantity consumed at a production line to manufacture one. */
  recipe: Record<string, number>;
}

/**
 * The two starting upgrades, now manufactured from ship parts. Recipes mix a
 * couple of structural parts so the summed part value — and thus the derived
 * sell value — stays in a sane (if high) band. Part ids are validated by the
 * seeded suite; quantities are our call.
 */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: "ablative_shields",
    name: "Ablative Shields",
    recipe: { hull_plating: 2, alloy_beam: 1 },
  },
  {
    id: "antifreeze_tanks",
    name: "Antifreeze Tanks",
    recipe: { circuit_board: 2, sensor_array: 1 },
  },
  {
    // cascade 0b: gates operating on lethally-irradiated coreward surfaces, the
    // sibling of the freezing/boiling landing gear. Heavy hull + sensors to keep
    // the radiation out — its summed part value is the priciest of the three.
    id: "radiation_shield",
    name: "Radiation Shield",
    recipe: { hull_plating: 2, sensor_array: 2, alloy_beam: 1 },
  },
] as const;

/** Valid upgrade ids. */
export const UPGRADE_IDS: readonly string[] = UPGRADES.map((u) => u.id);

const BY_ID: ReadonlyMap<string, Upgrade> = new Map(
  UPGRADES.map((u) => [u.id, u]),
);

/** Whether `id` is a known upgrade id. */
export function isUpgradeId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up an upgrade by id. Throws on unknown ids (mirrors `getResource`) so a
 * typo surfaces loudly rather than producing `undefined`.
 */
export function getUpgrade(id: string): Upgrade {
  const u = BY_ID.get(id);
  if (!u) throw new Error(`unknown upgrade id: ${id}`);
  return u;
}

/** The recipe (partId -> qty) for an upgrade. Throws on unknown id. */
export function recipeOf(id: string): Record<string, number> {
  return getUpgrade(id).recipe;
}

/**
 * Part-input cost of an upgrade: Σ qty × `partValue`. The floor under its sell
 * value (`upgradeValue` adds the craft markup on top). Throws on an unknown
 * upgrade id or a recipe referencing an unknown part.
 */
export function recipeCost(id: string): number {
  const recipe = recipeOf(id);
  let total = 0;
  for (const [partId, qty] of Object.entries(recipe)) {
    total += getPart(partId).value * qty;
  }
  return total;
}

/**
 * What an upgrade sells for: `recipeCost` (summed part value) marked up by
 * `CRAFT_VALUE_MARKUP` ("a bit above" its part inputs), rounded to an integer.
 * Buying costs `buyUnitCost(upgradeValue(id))` (the existing 1.5× market markup).
 */
export function upgradeValue(id: string): number {
  return Math.round(recipeCost(id) * CRAFT_VALUE_MARKUP);
}

/**
 * The finite-supply buy gate (P9a): an upgrade can be bought off the market only
 * while shared `supply` remains. Pure — the impure supply read lives in
 * `world.ts`; `buy` validates this before charging, and `sell`/manufacture grow
 * the supply so the only way the buyable stock rises is players making + selling
 * upgrades.
 */
export function canBuyFromSupply(supply: number): boolean {
  return supply > 0;
}
