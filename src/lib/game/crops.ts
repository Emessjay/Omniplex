/**
 * Crop catalog — the source of truth for FARMED plants, the way `RESOURCES`
 * is for minerals, `MATERIALS` is for looted/harvested goods, and `PARTS` is
 * for manufactured ship gear.
 *
 * A crop is sown into a crop-farm plot (`plant <crop>`), grows over real time
 * (`growMs`), and is gathered for a crop MATERIAL (`harvest <crop>`). Like
 * flora/fauna in `wildlife.ts`, every crop declares the `biomes` it grows in,
 * so a region only ever supports biome-appropriate crops (`cropsForBiome`
 * enforces this) — WHERE you base your farm matters. The harvest output is a
 * `category: "crop"` material in `materials.ts` (sellable like any material;
 * it feeds livestock in the next phase, animal-husbandry).
 *
 * Keep the two catalogs in lock-step: every `yield.materialId` MUST be a real
 * `category: "crop"` material (guarded in `crop-farming.test.ts`). Add more
 * crops by extending `CROPS`; `growMs`, yields, and values are tuned here.
 */
import type { Biome } from "@/lib/universe";

/** A farmable crop: sown into a plot, grown over `growMs`, harvested for a material. */
export interface Crop {
  id: string;
  name: string;
  /** Biomes this crop grows in (non-empty; each a valid surface `Biome`). */
  biomes: readonly Biome[];
  /** Real-time milliseconds from planting to ripeness (see `cropMature`). */
  growMs: number;
  /** What one ripe plot awards on `harvest`: a crop material + quantity (> 0). */
  yield: { materialId: string; qty: number };
}

const MINUTE = 60_000;

/**
 * The crop catalog — biome-affined and DIVERSE. Five surface biomes each
 * support TWO crops (gas giants have no surface, so no crops). `growMs` spans
 * roughly 20 minutes to ~1.5 hours so different crops feel like different
 * commitments. Each `yield.materialId` is the matching `category: "crop"`
 * material in `materials.ts` (crop id == material id — you plant and harvest the
 * same named good).
 */
export const CROPS: readonly Crop[] = [
  // Jungle — lush, fast-growing fruit and a slower root tuber.
  { id: "verdant_fruit", name: "Verdant Fruit", biomes: ["jungle"], growMs: 30 * MINUTE, yield: { materialId: "verdant_fruit", qty: 3 } },
  { id: "jungle_tuber", name: "Jungle Tuber", biomes: ["jungle"], growMs: 45 * MINUTE, yield: { materialId: "jungle_tuber", qty: 4 } },
  // Ocean — aquatic crops grown on the shallows.
  { id: "kelp", name: "Kelp", biomes: ["ocean"], growMs: 20 * MINUTE, yield: { materialId: "kelp", qty: 5 } },
  { id: "seabean", name: "Seabean", biomes: ["ocean"], growMs: 40 * MINUTE, yield: { materialId: "seabean", qty: 3 } },
  // Desert — hardy grain and a water-storing melon, both slow.
  { id: "cacti_grain", name: "Cacti Grain", biomes: ["desert"], growMs: 60 * MINUTE, yield: { materialId: "cacti_grain", qty: 3 } },
  { id: "sunmelon", name: "Sunmelon", biomes: ["desert"], growMs: 50 * MINUTE, yield: { materialId: "sunmelon", qty: 2 } },
  // Tundra — cold-tolerant berry and a very slow lichen.
  { id: "frost_berry", name: "Frost Berry", biomes: ["tundra"], growMs: 35 * MINUTE, yield: { materialId: "frost_berry", qty: 3 } },
  { id: "ice_lichen", name: "Ice Lichen", biomes: ["tundra"], growMs: 90 * MINUTE, yield: { materialId: "ice_lichen", qty: 2 } },
  // Volcanic — heat-loving exotics worth the danger of farming there.
  { id: "ember_gourd", name: "Ember Gourd", biomes: ["volcanic"], growMs: 55 * MINUTE, yield: { materialId: "ember_gourd", qty: 2 } },
  { id: "ash_root", name: "Ash Root", biomes: ["volcanic"], growMs: 70 * MINUTE, yield: { materialId: "ash_root", qty: 3 } },
] as const;

/** Valid crop ids. */
export const CROP_IDS: readonly string[] = CROPS.map((c) => c.id);

const BY_ID: ReadonlyMap<string, Crop> = new Map(CROPS.map((c) => [c.id, c]));

/** Whether `id` is a known crop id. */
export function isCropId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a crop by id. Throws on unknown ids (mirrors `getResource` /
 * `getMaterial` / `getPart`) so a typo surfaces loudly rather than producing
 * `undefined`.
 */
export function getCrop(id: string): Crop {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown crop id: ${id}`);
  return c;
}

/**
 * Every crop that grows in `biome`. The candidate set for `plant` in a region
 * of that biome — so a region can never sow a crop specific to another biome.
 */
export function cropsForBiome(biome: Biome): Crop[] {
  return CROPS.filter((c) => c.biomes.includes(biome));
}
