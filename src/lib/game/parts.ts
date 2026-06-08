/**
 * Ship-parts catalog — the source of truth for ADVANCED materials manufactured
 * at a base's production line, the way `RESOURCES` is for raw minerals and
 * `UPGRADES` is for ship gear.
 *
 * A part is an INTERMEDIATE good (P8b): a `recipe` of raw minerals consumed from
 * a base's silo storage to manufacture one, plus a sell `value` that is always
 * comfortably ABOVE the raw input cost (manufacturing adds value). Parts live in
 * `base_storage` (its `item_id` is free-text — no new column), are produced by
 * the `produce` command, and for now simply sit there as intermediates. P9 will
 * route ship-upgrade manufacture (Ablative Shields / Antifreeze Tanks) through
 * production lines — consuming these parts — and add the finite market-supply
 * mechanic; this phase is the parts + `produce` only (parts are NOT yet sold on
 * the market).
 *
 * Keep it general: more parts drop in by extending `PARTS`. Recipes reference
 * real mineral ids from `RESOURCES`; quantities + values are tuned here. The
 * value > raw-input invariant is locked by `production-lines.test.ts`.
 */
import { getResource } from "@/lib/universe";

export interface Part {
  id: string;
  name: string;
  /** Raw-mineral recipe consumed to manufacture one: resourceId -> qty. */
  recipe: Record<string, number>;
  /** Fixed sell value in credits (code-derived; > raw input cost). */
  value: number;
}

/**
 * The starting ship-parts catalog. Recipes draw on the common general minerals
 * so parts are broadly producible early; each `value` is set comfortably above
 * the summed base value of its raw inputs, so manufacturing is always worthwhile
 * (the floor invariant is unit-tested, not just eyeballed).
 *   hull_plating  raw 8·iron + 2·titanium = 120  → 180
 *   circuit_board raw 6·copper + 4·silica = 88    → 140
 *   alloy_beam    raw 4·titanium + 6·iron = 190   → 290
 *   sensor_array  raw 4·copper + 3·cobalt + 2·silica = 110 → 175
 */
export const PARTS: readonly Part[] = [
  { id: "hull_plating", name: "Hull Plating", recipe: { iron: 8, titanium: 2 }, value: 180 },
  { id: "circuit_board", name: "Circuit Board", recipe: { copper: 6, silica: 4 }, value: 140 },
  { id: "alloy_beam", name: "Alloy Beam", recipe: { titanium: 4, iron: 6 }, value: 290 },
  { id: "sensor_array", name: "Sensor Array", recipe: { copper: 4, cobalt: 3, silica: 2 }, value: 175 },
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
 * Summed base value of a part's raw mineral inputs (Σ qty × resource base
 * value). The floor under its `value`: manufacturing must add value, so every
 * part's `value` is strictly greater than this (asserted in tests). Throws on
 * an unknown id or a recipe referencing an unknown mineral.
 */
export function partRawInputValue(id: string): number {
  let total = 0;
  for (const [resourceId, qty] of Object.entries(partRecipeOf(id))) {
    total += getResource(resourceId).baseValue * qty;
  }
  return total;
}
