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

/** A material's category — where it tends to come from. */
export type MaterialCategory = "flora" | "animal" | "relic" | "mineral";

export interface Material {
  id: string;
  name: string;
  category: MaterialCategory;
  /** Fixed sell value in credits (code-derived; no market drift). */
  value: number;
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

/**
 * Materials that turn up when SCAVENGING (everything except animal parts, which
 * only come from kills): flora, unusual minerals, and rare relics.
 */
export const SCAVENGEABLE: readonly Material[] = MATERIALS.filter(
  (m) => m.category !== "animal",
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
