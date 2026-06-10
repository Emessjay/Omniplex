/**
 * Ship-parts catalog — the source of truth for ADVANCED materials manufactured
 * at a base's production line, the way `RESOURCES` is for raw minerals and
 * `UPGRADES` is for ship gear.
 *
 * A part is an INTERMEDIATE good (P8b): a `recipe` of inputs consumed from a
 * base's silo storage to manufacture one, plus a sell `value` that is always
 * comfortably ABOVE its input cost (manufacturing adds value). Parts live in
 * `base_storage` (its `item_id` is free-text — no new column), are produced by
 * the `produce` command, and feed ship-upgrade manufacture (P9a — Ablative
 * Shields / Antifreeze Tanks consume parts) plus the finite per-system market
 * supply (P12b — parts are now a tradeable commodity).
 *
 * SMELTING REWIRE (blast-furnace phase): part recipes now consume INGOTS for
 * their metal inputs (e.g. `iron_ingot` rather than raw `iron`), deepening the
 * chain to **ore → ingot → part → upgrade**. A recipe may still keep a raw
 * NON-metal input (`silica`, which has no ingot). Each `value` is recomputed off
 * the (ingot + raw) input value via `PART_VALUE_MARKUP`, so the
 * value-adds invariant (`partValue > partInputValue`) holds by construction.
 *
 * Keep it general: more parts drop in by extending `PARTS`. Recipes reference
 * ingot ids (`ingots.ts`) and/or real raw mineral ids (`RESOURCES`); quantities
 * + the markup are tuned here. The value > input invariant and the
 * each-recipe-uses-an-ingot invariant are locked by `blast-furnace.test.ts`.
 */
import { getResource } from "@/lib/universe";
import { isIngotId, ingotValue } from "./ingots";

export interface Part {
  id: string;
  name: string;
  /** Input recipe consumed to manufacture one: (ingotId | resourceId) -> qty. */
  recipe: Record<string, number>;
  /** Fixed sell value in credits (code-derived; > input cost). */
  value: number;
}

/**
 * How much manufacturing marks a part up over its (ingot + raw) inputs
 * ("comfortably above"). `value = round(partInputValue × this)`, so the
 * value-adds invariant (`partValue > partInputValue`) holds for every part.
 */
export const PART_VALUE_MARKUP = 1.3;

/** Σ qty × per-item value (ingot → `ingotValue`, raw → resource base value). */
function inputValue(recipe: Record<string, number>): number {
  let total = 0;
  for (const [itemId, qty] of Object.entries(recipe)) {
    const unit = isIngotId(itemId) ? ingotValue(itemId) : getResource(itemId).baseValue;
    total += unit * qty;
  }
  return total;
}

/** Build a part whose `value` is its input value marked up by `PART_VALUE_MARKUP`. */
function part(id: string, name: string, recipe: Record<string, number>): Part {
  return { id, name, recipe, value: Math.round(inputValue(recipe) * PART_VALUE_MARKUP) };
}

/**
 * The starting ship-parts catalog, rewired onto ingots. Every recipe consumes at
 * least one ingot (the metal inputs); circuit_board / sensor_array also keep raw
 * silica (no silica ingot). Each `value` is derived (input value × markup), so
 * manufacturing always adds value (the floor invariant is unit-tested):
 *   hull_plating  4·iron_ingot + 1·titanium_ingot   in 180 → 234
 *   circuit_board 3·copper_ingot + 4·silica         in 124 → 161
 *   alloy_beam    2·titanium_ingot + 3·iron_ingot   in 285 → 371
 *   sensor_array  2·copper_ingot + 2·cobalt_ingot + 2·silica  in 188 → 244
 */
export const PARTS: readonly Part[] = [
  part("hull_plating", "Hull Plating", { iron_ingot: 4, titanium_ingot: 1 }),
  part("circuit_board", "Circuit Board", { copper_ingot: 3, silica: 4 }),
  part("alloy_beam", "Alloy Beam", { titanium_ingot: 2, iron_ingot: 3 }),
  part("sensor_array", "Sensor Array", { copper_ingot: 2, cobalt_ingot: 2, silica: 2 }),
] as const;

/** Valid part ids. */
export const PART_IDS: readonly string[] = PARTS.map((p) => p.id);

const BY_ID: ReadonlyMap<string, Part> = new Map(PARTS.map((p) => [p.id, p]));

/** Whether `id` is a known ship-part id. */
export function isPartId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a part by id. Throws on unknown ids (mirrors `getResource` /
 * `getUpgrade`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getPart(id: string): Part {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown part id: ${id}`);
  return p;
}

/** The raw-mineral recipe (resourceId -> qty) for a part. Throws on unknown id. */
export function partRecipeOf(id: string): Record<string, number> {
  return getPart(id).recipe;
}

/** A part's fixed sell value. Throws on unknown id. */
export function partValue(id: string): number {
  return getPart(id).value;
}

/**
 * Summed value of a part's recipe inputs (Σ qty × per-item value): an ingot
 * input is valued at `ingotValue`, a raw mineral at its resource base value. The
 * floor under the part's `value`: manufacturing must add value, so every part's
 * `value` is strictly greater than this (asserted in tests). Throws on an unknown
 * part id or a recipe referencing an unknown ingot/mineral. Supersedes the old
 * raw-only `partRawInputValue` (recipes consume ingots now).
 */
export function partInputValue(id: string): number {
  return inputValue(partRecipeOf(id));
}
