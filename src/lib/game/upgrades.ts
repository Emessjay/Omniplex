/**
 * Ship-upgrade catalog — the source of truth for craftable/tradeable
 * permanent upgrades, the way `RESOURCES` is for minerals.
 *
 * This is the first crafting/synthesis vertical: an `Upgrade` has a `recipe`
 * (resourceId -> qty consumed) and a derived sell value a bit above its raw
 * component cost (`CRAFT_VALUE_MARKUP`, defined in `rules.ts`). Owning ≥ 1 of an
 * upgrade activates its capability (the landing gate in `rules.ts`). Pricing is
 * fully code-derived — upgrades are NOT in the `markets` table and never drift.
 *
 * Keep it general: more upgrades/recipes drop in by extending `UPGRADES`. The
 * recipe component *resources* are fixed by the spec; quantities are tuned here.
 */
import { getResource } from "@/lib/universe";
import { CRAFT_VALUE_MARKUP } from "./rules";

export interface Upgrade {
  id: "ablative_shields" | "antifreeze_tanks";
  name: string;
  /** resourceId -> quantity consumed to craft one. */
  recipe: Record<string, number>;
}

/**
 * The two starting upgrades. Recipes are modest (a little titanium + more of a
 * common ore), so the component cost — and thus the derived sell value — stays
 * in a sane band. Components are spec-fixed; quantities are our call.
 */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: "ablative_shields",
    name: "Ablative Shields",
    recipe: { titanium: 2, silica: 4 },
  },
  {
    id: "antifreeze_tanks",
    name: "Antifreeze Tanks",
    recipe: { titanium: 2, iron: 4 },
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

/** The recipe (resourceId -> qty) for an upgrade. Throws on unknown id. */
export function recipeOf(id: string): Record<string, number> {
  return getUpgrade(id).recipe;
}

/**
 * Raw component cost of an upgrade: Σ qty × resource base value. The floor under
 * its sell value (`upgradeValue` adds the craft markup on top).
 */
export function recipeCost(id: string): number {
  const recipe = recipeOf(id);
  let total = 0;
  for (const [resourceId, qty] of Object.entries(recipe)) {
    total += getResource(resourceId).baseValue * qty;
  }
  return total;
}

/**
 * What an upgrade sells for: `recipeCost` marked up by `CRAFT_VALUE_MARKUP`
 * ("a bit above" component cost), rounded to an integer. Buying costs
 * `buyUnitCost(upgradeValue(id))` (the existing 1.5× market markup).
 */
export function upgradeValue(id: string): number {
  return Math.round(recipeCost(id) * CRAFT_VALUE_MARKUP);
}
