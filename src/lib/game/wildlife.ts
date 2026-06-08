/**
 * Flora & fauna catalogs — the living things you meet while exploring on foot.
 *
 * Like `RESOURCES` / `MATERIALS` / `UPGRADES`, this is a code catalog (no DB).
 * Each species declares the `biomes` it lives in, so the explore handler only
 * ever surfaces biome-appropriate life (the `pickForBiome` selector enforces
 * this). Flora can be `harvest`ed for a material; fauna can be `attack`ed and
 * drop a material when killed (hostile ones force combat first).
 *
 * Materials referenced here (`harvest.materialId`, `drop.materialId`) MUST exist
 * in `materials.ts`. Keep the two catalogs in lock-step.
 */
import type { Biome } from "@/lib/universe";

/** A harvestable plant: collecting it yields `harvest.qty` of a material. */
export interface Flora {
  id: string;
  name: string;
  /** Biomes this plant grows in (non-empty; each a valid `Biome`). */
  biomes: Biome[];
  /** What `harvest` awards. */
  harvest: { materialId: string; qty: number };
}

/**
 * A creature. `hostile` fauna engage you in combat on sight (an `encounter` is
 * set; you must `attack` or `flee`); non-hostile fauna can still be `attack`ed.
 * Killing any fauna awards its `drop`.
 */
export interface Fauna {
  id: string;
  name: string;
  /** Biomes this creature lives in (non-empty; each a valid `Biome`). */
  biomes: Biome[];
  /** Starting hit points in combat. */
  maxHp: number;
  /** Damage it deals per simultaneous combat round. */
  attack: number;
  /** True = attacks on sight (forces an encounter). */
  hostile: boolean;
  /** What killing it awards. */
  drop: { materialId: string; qty: number };
}

/**
 * The flora catalog. Every one of the ten biomes has at least one plant, so
 * exploring always has something to find. Harvest yields point at flora/mineral
 * materials in `materials.ts`.
 */
export const FLORA: readonly Flora[] = [
  { id: "glow_moss", name: "Glow Moss", biomes: ["jungle", "tundra"], harvest: { materialId: "luminous_spores", qty: 2 } },
  { id: "ironbark", name: "Ironbark Tree", biomes: ["jungle", "desert"], harvest: { materialId: "ironbark_resin", qty: 1 } },
  { id: "frost_lichen", name: "Frost Lichen", biomes: ["tundra", "barren"], harvest: { materialId: "luminous_spores", qty: 1 } },
  { id: "ember_vine", name: "Ember Vine", biomes: ["volcanic", "desert"], harvest: { materialId: "ironbark_resin", qty: 2 } },
  { id: "crystal_bloom", name: "Crystal Bloom", biomes: ["crystalline", "irradiated"], harvest: { materialId: "luminous_spores", qty: 3 } },
  { id: "kelp_frond", name: "Kelp Frond", biomes: ["ocean"], harvest: { materialId: "ironbark_resin", qty: 2 } },
  { id: "spore_pod", name: "Spore Pod", biomes: ["toxic", "irradiated"], harvest: { materialId: "luminous_spores", qty: 2 } },
  { id: "float_bladder", name: "Float Bladder", biomes: ["gas", "ocean"], harvest: { materialId: "ironbark_resin", qty: 1 } },
] as const;

/**
 * The fauna catalog. Every biome has at least one creature. A mix of hostile
 * predators (combat on sight) and placid grazers (attackable, but no forced
 * fight). Drops point at animal materials in `materials.ts`.
 */
export const FAUNA: readonly Fauna[] = [
  { id: "dust_crawler", name: "Dust Crawler", biomes: ["barren", "desert"], maxHp: 20, attack: 6, hostile: false, drop: { materialId: "scaled_hide", qty: 1 } },
  { id: "rock_grazer", name: "Rock Grazer", biomes: ["barren", "tundra"], maxHp: 30, attack: 0, hostile: false, drop: { materialId: "scaled_hide", qty: 1 } },
  { id: "sand_stalker", name: "Sand Stalker", biomes: ["desert", "barren"], maxHp: 35, attack: 10, hostile: true, drop: { materialId: "venom_gland", qty: 1 } },
  { id: "reef_serpent", name: "Reef Serpent", biomes: ["ocean"], maxHp: 40, attack: 12, hostile: true, drop: { materialId: "scaled_hide", qty: 2 } },
  { id: "canopy_flitter", name: "Canopy Flitter", biomes: ["jungle", "ocean"], maxHp: 15, attack: 0, hostile: false, drop: { materialId: "scaled_hide", qty: 1 } },
  { id: "jungle_prowler", name: "Jungle Prowler", biomes: ["jungle"], maxHp: 45, attack: 14, hostile: true, drop: { materialId: "venom_gland", qty: 1 } },
  { id: "ice_lurker", name: "Ice Lurker", biomes: ["tundra"], maxHp: 35, attack: 11, hostile: true, drop: { materialId: "scaled_hide", qty: 2 } },
  { id: "magma_beast", name: "Magma Beast", biomes: ["volcanic", "irradiated"], maxHp: 60, attack: 18, hostile: true, drop: { materialId: "venom_gland", qty: 2 } },
  { id: "toxic_slug", name: "Toxic Slug", biomes: ["toxic"], maxHp: 25, attack: 8, hostile: true, drop: { materialId: "venom_gland", qty: 1 } },
  { id: "crystal_skitter", name: "Crystal Skitter", biomes: ["crystalline"], maxHp: 20, attack: 5, hostile: false, drop: { materialId: "scaled_hide", qty: 1 } },
  { id: "gas_drifter", name: "Gas Drifter", biomes: ["gas"], maxHp: 30, attack: 9, hostile: true, drop: { materialId: "scaled_hide", qty: 1 } },
  { id: "rad_hound", name: "Rad Hound", biomes: ["irradiated", "toxic"], maxHp: 40, attack: 13, hostile: true, drop: { materialId: "venom_gland", qty: 1 } },
] as const;

const FAUNA_BY_ID: ReadonlyMap<string, Fauna> = new Map(FAUNA.map((f) => [f.id, f]));
const FLORA_BY_ID: ReadonlyMap<string, Flora> = new Map(FLORA.map((f) => [f.id, f]));

/** Look up a fauna by id (undefined if unknown — caller decides how to handle). */
export function getFauna(id: string): Fauna | undefined {
  return FAUNA_BY_ID.get(id);
}

/** Look up a flora by id (undefined if unknown). */
export function getFlora(id: string): Flora | undefined {
  return FLORA_BY_ID.get(id);
}

/** Every flora that grows in `biome`. */
export function floraForBiome(biome: Biome): Flora[] {
  return FLORA.filter((f) => f.biomes.includes(biome));
}

/** Every fauna that lives in `biome`. */
export function faunaForBiome(biome: Biome): Fauna[] {
  return FAUNA.filter((f) => f.biomes.includes(biome));
}

/**
 * Deterministically pick one entry of `list` that is valid for `biome` from a
 * roll in `[0, 1)`. Filters to species whose `biomes` include `biome`, then
 * indexes into that subset — so the result is ALWAYS biome-appropriate (AC#2).
 * Returns `null` when no entry supports the biome (the handler reports an empty
 * find). Pure: the caller supplies a real `Math.random()`.
 */
export function pickForBiome<T extends { biomes: Biome[] }>(
  list: readonly T[],
  biome: Biome,
  roll: number,
): T | null {
  const candidates = list.filter((e) => e.biomes.includes(biome));
  if (candidates.length === 0) return null;
  const r = roll < 0 ? 0 : roll >= 1 ? 0.999999 : roll;
  const idx = Math.min(candidates.length - 1, Math.floor(r * candidates.length));
  return candidates[idx]!;
}
