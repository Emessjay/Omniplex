/**
 * Farm-animal catalog — the source of truth for RANCHABLE livestock, the way
 * `CROPS` is for farmed plants and `RESOURCES` is for minerals.
 *
 * A farm animal is acquired (`ranch <animal>`) for credits into a base's
 * livestock pen, fed (`feed <animal>`) with a CROP material grown in Phase 2 to
 * breed the herd over real time, and slaughtered (`slaughter <animal> [n]`) for
 * a product material (meat / hide / fibre). Like crops (`crops.ts`), every
 * animal declares the `biomes` it can be ranched in,
 * so a region only ever supports biome-appropriate livestock
 * (`farmAnimalsForBiome` enforces this) — WHERE you base your ranch matters.
 *
 * This CLOSES the crops→feed loop: every `feed.cropId` MUST be a real `CROPS`
 * id (guarded in `animal-husbandry.test.ts`), and is chosen so a biome's crops
 * feed that biome's animals. Each `product.materialId` is a real
 * `category: "animal"` material in `materials.ts` (sellable like any material).
 *
 * Keep the catalogs in lock-step: add more livestock by extending `FARM_ANIMALS`
 * (feed crops, breed times, products, and acquisition costs are tuned here).
 */
import type { Biome } from "@/lib/universe";

/** A ranchable farm animal: acquired, fed crops to breed, slaughtered for a product. */
export interface FarmAnimal {
  id: string;
  name: string;
  /** Biomes this animal can be ranched in (non-empty; each a valid surface `Biome`). */
  biomes: readonly Biome[];
  /** What one head eats per feeding: a CROP material id + per-head quantity (> 0). */
  feed: { cropId: string; qtyPerHead: number };
  /** Real-time milliseconds between breed cycles (see `livestockCanBreed`). */
  breedMs: number;
  /** What one slaughtered head yields: an `animal` material + quantity (> 0). */
  product: { materialId: string; qty: number };
  /** Credits to acquire a starter head via `ranch` (> 0). */
  acquireCost: number;
}

const MINUTE = 60_000;

/**
 * The livestock catalog — biome-affined and DIVERSE: eight animals across five
 * surface biomes (jungle/ocean/desert/tundra/volcanic, ≥1 per biome). Each feeds
 * on a crop grown in its own biome (closing the crops→feed loop) and yields a
 * distinct `category: "animal"` product. `breedMs` spans ~30 min to ~70 min and
 * `acquireCost` rises with the value of the product, so different animals feel
 * like different commitments.
 */
export const FARM_ANIMALS: readonly FarmAnimal[] = [
  // Jungle — lush biome; a quick-breeding fowl and a slower browsing grazer.
  { id: "jungle_fowl", name: "Jungle Fowl", biomes: ["jungle"], feed: { cropId: "verdant_fruit", qtyPerHead: 1 }, breedMs: 30 * MINUTE, product: { materialId: "poultry_meat", qty: 2 }, acquireCost: 200 },
  { id: "canopy_grazer", name: "Canopy Grazer", biomes: ["jungle"], feed: { cropId: "jungle_tuber", qtyPerHead: 2 }, breedMs: 45 * MINUTE, product: { materialId: "tender_loin", qty: 1 }, acquireCost: 360 },
  // Ocean — shallows-farmed shellfish and a fattier marine grazer.
  { id: "reef_shellfish", name: "Reef Shellfish", biomes: ["ocean"], feed: { cropId: "kelp", qtyPerHead: 1 }, breedMs: 40 * MINUTE, product: { materialId: "shellfish_meat", qty: 2 }, acquireCost: 220 },
  { id: "brine_seal", name: "Brine Seal", biomes: ["ocean"], feed: { cropId: "seabean", qtyPerHead: 2 }, breedMs: 50 * MINUTE, product: { materialId: "marine_blubber", qty: 1 }, acquireCost: 320 },
  // Desert — hardy stock that thrives on the dry crops.
  { id: "sand_grazer", name: "Sand Grazer", biomes: ["desert"], feed: { cropId: "cacti_grain", qtyPerHead: 1 }, breedMs: 60 * MINUTE, product: { materialId: "coarse_sinew", qty: 2 }, acquireCost: 260 },
  { id: "dune_strider", name: "Dune Strider", biomes: ["desert"], feed: { cropId: "sunmelon", qtyPerHead: 2 }, breedMs: 55 * MINUTE, product: { materialId: "thick_hide", qty: 1 }, acquireCost: 340 },
  // Tundra — a cold-tolerant woolly grazer prized for its fleece.
  { id: "woolly_grazer", name: "Woolly Grazer", biomes: ["tundra"], feed: { cropId: "frost_berry", qtyPerHead: 2 }, breedMs: 35 * MINUTE, product: { materialId: "woolly_fleece", qty: 2 }, acquireCost: 300 },
  // Volcanic — a heat-loving lizard worth the danger of ranching there.
  { id: "magma_lizard", name: "Magma Lizard", biomes: ["volcanic"], feed: { cropId: "ember_gourd", qtyPerHead: 2 }, breedMs: 70 * MINUTE, product: { materialId: "ember_tallow", qty: 1 }, acquireCost: 480 },
] as const;

/** Valid farm-animal ids. */
export const FARM_ANIMAL_IDS: readonly string[] = FARM_ANIMALS.map((a) => a.id);

const BY_ID: ReadonlyMap<string, FarmAnimal> = new Map(FARM_ANIMALS.map((a) => [a.id, a]));

/** Whether `id` is a known farm-animal id. */
export function isFarmAnimalId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a farm animal by id. Throws on unknown ids (mirrors `getCrop` /
 * `getMaterial`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getFarmAnimal(id: string): FarmAnimal {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`unknown farm-animal id: ${id}`);
  return a;
}

/**
 * Every farm animal that can be ranched in `biome`. The candidate set for
 * `ranch` in a region of that biome — so a region can never raise an animal
 * specific to another biome.
 */
export function farmAnimalsForBiome(biome: Biome): FarmAnimal[] {
  return FARM_ANIMALS.filter((a) => a.biomes.includes(biome));
}
