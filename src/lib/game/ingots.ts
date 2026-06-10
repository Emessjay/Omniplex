/**
 * Ingot catalog — the source of truth for SMELTED metals, the way `RESOURCES`
 * is for raw minerals and `PARTS` is for the advanced goods built from ingots.
 *
 * An ingot is the first SMELTING tier (the industrial step opened by the blast
 * furnace): a `recipe` of raw METAL ore consumed from a base's silo storage to
 * smelt one, plus a `value` that is always comfortably ABOVE the raw ore input
 * cost (smelting adds value). Ingots live in `base_storage` (its `item_id` is
 * free-text — no new column / migration), are produced by `produce <ingot>` at
 * a `blast_furnace`, and are SILO-ONLY intermediates this phase: they feed the
 * production lines (ship-part recipes now consume ingots), so they are NOT
 * carried in cargo, NOT traded, NOT in `deposit`/`withdraw`.
 *
 * This is the bottom of the deepened production chain
 *   ore → ingot → part → upgrade
 * — each tier's `value` is strictly greater than the summed value of its inputs,
 * an invariant locked by `blast-furnace.test.ts` (here: `ingotValue >
 * ingotRawInputValue`).
 *
 * Keep it general: more ingots drop in by extending `INGOTS`. Recipes reference
 * real METAL ids from `RESOURCES` (iron/copper/cobalt/titanium/iridium — NOT
 * silica/xenon/voidstone, which aren't smelted into ingots); quantities + the
 * `SMELT_VALUE_MARKUP` are tuned here.
 */
import { getResource } from "@/lib/universe";

export interface Ingot {
  id: string;
  name: string;
  /** Raw-metal recipe consumed at a blast furnace to smelt one: resourceId -> qty. */
  recipe: Record<string, number>;
  /** Fixed value in credits (code-derived; > raw ore input cost). */
  value: number;
}

/**
 * How much smelting marks an ingot up over the raw ore that went into it
 * ("a bit above" its inputs). `value = round(ingotRawInputValue × this)`, so the
 * smelting-adds-value invariant (`ingotValue > ingotRawInputValue`) holds by
 * construction for every ingot. Tunable.
 */
export const SMELT_VALUE_MARKUP = 1.5;

/** Σ qty × resource base value for a raw-metal recipe (the ingot's input floor). */
function rawInputValue(recipe: Record<string, number>): number {
  let total = 0;
  for (const [resourceId, qty] of Object.entries(recipe)) {
    total += getResource(resourceId).baseValue * qty;
  }
  return total;
}

/** Build an ingot whose `value` is its raw input value marked up by the smelt markup. */
function ingot(id: string, name: string, recipe: Record<string, number>): Ingot {
  return { id, name, recipe, value: Math.round(rawInputValue(recipe) * SMELT_VALUE_MARKUP) };
}

/**
 * One ingot per smeltable METAL (iron/copper/cobalt/titanium/iridium). Each
 * smelts from two units of its raw ore; the derived `value` is the ore's base
 * value × `SMELT_VALUE_MARKUP`, e.g. iron_ingot {iron:2}=10→15,
 * titanium_ingot {titanium:2}=80→120.
 */
export const INGOTS: readonly Ingot[] = [
  ingot("iron_ingot", "Iron Ingot", { iron: 2 }),
  ingot("copper_ingot", "Copper Ingot", { copper: 2 }),
  ingot("cobalt_ingot", "Cobalt Ingot", { cobalt: 2 }),
  ingot("titanium_ingot", "Titanium Ingot", { titanium: 2 }),
  ingot("iridium_ingot", "Iridium Ingot", { iridium: 2 }),
] as const;

/** Valid ingot ids. */
export const INGOT_IDS: readonly string[] = INGOTS.map((i) => i.id);

const BY_ID: ReadonlyMap<string, Ingot> = new Map(INGOTS.map((i) => [i.id, i]));

/** Whether `id` is a known ingot id. */
export function isIngotId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up an ingot by id. Throws on unknown ids (mirrors `getResource` /
 * `getPart`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getIngot(id: string): Ingot {
  const i = BY_ID.get(id);
  if (!i) throw new Error(`unknown ingot id: ${id}`);
  return i;
}

/** The raw-metal recipe (resourceId -> qty) for an ingot. Throws on unknown id. */
export function ingotRecipeOf(id: string): Record<string, number> {
  return getIngot(id).recipe;
}

/** An ingot's fixed value. Throws on unknown id. */
export function ingotValue(id: string): number {
  return getIngot(id).value;
}

/**
 * Summed base value of an ingot's raw ore inputs (Σ qty × resource base value).
 * The floor under its `value`: smelting must add value, so every ingot's `value`
 * is strictly greater than this (asserted in tests). Throws on an unknown id or
 * a recipe referencing an unknown resource.
 */
export function ingotRawInputValue(id: string): number {
  return rawInputValue(ingotRecipeOf(id));
}
