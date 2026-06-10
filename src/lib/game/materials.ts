/**
 * Materials catalog — the source of truth for harvested / looted / dropped
 * goods, the way `RESOURCES` is for minerals and `UPGRADES` is for ship gear.
 *
 * Materials are the spoils of the on-foot survival loop (P5): you `scavenge`
 * them while exploring, `harvest` them from flora, or take them as a `drop` when
 * you kill fauna. They are SELLABLE (`sell <material>` while embarked) for a
 * fixed, code-derived `value` — like upgrades, materials are NOT in the
 * `markets` table and never drift. Ownership lives in `player_materials` (see
 * the wildlife migration + `world.ts`), mirroring `player_upgrades`.
 *
 * Keep it general: more materials drop in by extending `MATERIALS`. Categories
 * are fixed (`flora`/`animal`/`relic`/`mineral`); relics are the rare, high-value
 * tier you mostly want to be scavenging for.
 */

/**
 * A material's category — where it tends to come from. `food` (P6) is the odd
 * one out: food is never found/dropped, it is COOKED from other materials via
 * `craft` (see `FOOD_RECIPES`) and eaten to restore health. It reuses the same
 * `player_materials` storage as everything else.
 */
export type MaterialCategory = "flora" | "animal" | "relic" | "mineral" | "food" | "consumable" | "crop";

export interface Material {
  id: string;
  name: string;
  category: MaterialCategory;
  /** Fixed sell value in credits (code-derived; no market drift). */
  value: number;
  /**
   * Hit points restored when this item is `eat`en. Present (and > 0) only on
   * `food` materials; undefined elsewhere (inedible). See `healOf`.
   */
  heal?: number;
}

/**
 * The material catalog. A spread across the four categories with relics clearly
 * the high-value tier (a single relic is worth a long mining run). Flora come
 * from `harvest`, animal parts from kills, minerals/relics mostly from
 * `scavenge`. Values are tuned here.
 */
export const MATERIALS: readonly Material[] = [
  // Flora — harvested from plants.
  { id: "luminous_spores", name: "Luminous Spores", category: "flora", value: 32 },
  { id: "ironbark_resin", name: "Ironbark Resin", category: "flora", value: 48 },
  // Animal — dropped by slain fauna.
  { id: "scaled_hide", name: "Scaled Hide", category: "animal", value: 55 },
  { id: "venom_gland", name: "Venom Gland", category: "animal", value: 90 },
  // Mineral — unusual minerals turned up while scavenging.
  { id: "geode_cluster", name: "Geode Cluster", category: "mineral", value: 70 },
  { id: "meteoric_dust", name: "Meteoric Dust", category: "mineral", value: 120 },
  // Relic — rare precursor salvage; the jackpot of a scavenge.
  { id: "precursor_relic", name: "Precursor Relic", category: "relic", value: 600 },
  { id: "void_idol", name: "Void Idol", category: "relic", value: 950 },
  // Food — COOKED from the spoils above via `craft` (see `FOOD_RECIPES`), then
  // `eat`en to restore health. Sellable too (a `value`), but the point is `heal`.
  { id: "spore_broth", name: "Spore Broth", category: "food", value: 60, heal: 20 },
  { id: "seared_haunch", name: "Seared Haunch", category: "food", value: 70, heal: 35 },
  { id: "field_stew", name: "Field Stew", category: "food", value: 85, heal: 55 },
  // Consumable — CRAFTED, not found/dropped. Hyperwarp Condensate (P3) is spent
  // by `hyperwarp <galaxy>` to change galaxies; its recipe is a significant
  // amount of voidstone (see `galaxy-jump.ts`). Sellable (a `value` above its raw
  // voidstone cost), but the point is the jump. Stored in `player_materials`.
  { id: "hyperwarp_condensate", name: "Hyperwarp Condensate", category: "consumable", value: 6000 },
  // Crop — FARMED at a base's crop farm (`plant` → grow → `harvest`), never
  // found/dropped. Each maps 1:1 to a crop in `crops.ts` (same id). Sellable
  // like any material for a modest `value`; in the next phase (animal-husbandry)
  // these become livestock feed. Deliberately have NO `heal` — edibility is
  // reserved for `food` (the food suite asserts non-food materials are inedible).
  { id: "verdant_fruit", name: "Verdant Fruit", category: "crop", value: 24 },
  { id: "jungle_tuber", name: "Jungle Tuber", category: "crop", value: 20 },
  { id: "kelp", name: "Kelp", category: "crop", value: 16 },
  { id: "seabean", name: "Seabean", category: "crop", value: 26 },
  { id: "cacti_grain", name: "Cacti Grain", category: "crop", value: 30 },
  { id: "sunmelon", name: "Sunmelon", category: "crop", value: 34 },
  { id: "frost_berry", name: "Frost Berry", category: "crop", value: 28 },
  { id: "ice_lichen", name: "Ice Lichen", category: "crop", value: 38 },
  { id: "ember_gourd", name: "Ember Gourd", category: "crop", value: 40 },
  { id: "ash_root", name: "Ash Root", category: "crop", value: 32 },
] as const;

const BY_ID: ReadonlyMap<string, Material> = new Map(MATERIALS.map((m) => [m.id, m]));

/** Whether `id` is a known material id. */
export function isMaterialId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a material by id. Throws on unknown ids (mirrors `getResource` /
 * `getUpgrade`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getMaterial(id: string): Material {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`unknown material id: ${id}`);
  return m;
}

/** A material's fixed sell value. Throws on unknown id. */
export function materialValue(id: string): number {
  return getMaterial(id).value;
}

// ---------------------------------------------------------------------------
// Food (P6) — cooked from materials, eaten to restore health.
//
// Food are just `category: "food"` materials (reusing `player_materials` for
// storage and `sell` for trade); what sets them apart is a `heal` amount and a
// crafting `recipe` of OTHER material ingredients. The catalog above is the
// source of truth for the items + their heal/value; `FOOD_RECIPES` below maps
// each food id to the materials `craft` consumes to cook one.
// ---------------------------------------------------------------------------

/** Every food item (a `category: "food"` material). */
export const FOOD: readonly Material[] = MATERIALS.filter((m) => m.category === "food");

/** Valid food ids. */
export const FOOD_IDS: readonly string[] = FOOD.map((m) => m.id);

/** Whether `id` is a known food id (an edible, craftable material). */
export function isFoodId(id: string): boolean {
  return BY_ID.get(id)?.category === "food";
}

/**
 * Hit points a food restores when eaten. Throws on an unknown id; returns 0 for
 * a real-but-inedible material (no `heal`), so the `eat` handler can reject it.
 */
export function healOf(id: string): number {
  return getMaterial(id).heal ?? 0;
}

/**
 * Cooking recipes: food id -> { ingredientMaterialId: qty }. A flora meal, an
 * animal-product meal, and a mixed one. Every ingredient id MUST be a real
 * material (guarded in tests). Mirrors `recipeOf` in `upgrades.ts`; `craft`
 * consumes these from `player_materials` and yields one of the food.
 */
export const FOOD_RECIPES: Readonly<Record<string, Record<string, number>>> = {
  spore_broth: { luminous_spores: 3 },
  seared_haunch: { scaled_hide: 2 },
  field_stew: { luminous_spores: 2, scaled_hide: 1 },
};

/** The cooking recipe (materialId -> qty) for a food. Throws on unknown food id. */
export function foodRecipeOf(id: string): Record<string, number> {
  const recipe = FOOD_RECIPES[id];
  if (!recipe) throw new Error(`unknown food id: ${id}`);
  return recipe;
}

/**
 * Materials that turn up when SCAVENGING: flora, unusual minerals, and rare
 * relics. Excludes animal parts (those only come from kills), food (which is
 * cooked, never found), consumables like Hyperwarp Condensate (crafted, never
 * found) AND crops (FARMED at a base, never found in the wild).
 */
export const SCAVENGEABLE: readonly Material[] = MATERIALS.filter(
  (m) =>
    m.category !== "animal" &&
    m.category !== "food" &&
    m.category !== "consumable" &&
    m.category !== "crop",
);

/** Probability a scavenge turns up a (high-value) relic rather than a common find. */
const RELIC_CHANCE = 0.12;

/**
 * Pick a scavenged material from a roll in `[0, 1)`. Relics are RARE — only the
 * bottom `RELIC_CHANCE` of the roll range yields one — and the rest of the range
 * spreads evenly over the common finds (flora + minerals). Pure & deterministic:
 * the handler supplies a real `Math.random()`. Falls back gracefully if a
 * category is empty.
 */
export function pickScavenge(roll: number): Material {
  const r = roll < 0 ? 0 : roll >= 1 ? 0.999999 : roll;
  const relics = SCAVENGEABLE.filter((m) => m.category === "relic");
  const commons = SCAVENGEABLE.filter((m) => m.category !== "relic");
  if (r < RELIC_CHANCE && relics.length > 0) {
    const idx = Math.min(relics.length - 1, Math.floor((r / RELIC_CHANCE) * relics.length));
    return relics[idx]!;
  }
  const pool = commons.length > 0 ? commons : SCAVENGEABLE;
  const span = relics.length > 0 ? 1 - RELIC_CHANCE : 1;
  const offset = relics.length > 0 ? RELIC_CHANCE : 0;
  const t = (r - offset) / span;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(t * pool.length)));
  return pool[idx]!;
}
