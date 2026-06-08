/**
 * Resource catalog — the gen-side source of truth for harvestable materials.
 *
 * This MUST stay in lock-step with the DB seed in
 * `supabase/migrations/...resources` (id, name, rarity, baseValue). The
 * procedural generator decides *where* resources appear; the DB seed makes
 * them sellable. If the two ever drift, that is a bug (AC#6).
 *
 * Rarity tiers: 1 (common) … 5 (legendary). High-hazard "savage" planets
 * carry the rarest resources — the coupling lives in `gen.ts`.
 */

export interface Resource {
  /** Stable slug, e.g. "iron". Matches `resources.id` in the DB. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Rarity tier 1..5; 5 is legendary. */
  readonly rarity: number;
  /** Baseline credits-per-unit value (matches `resources.base_value`). */
  readonly baseValue: number;
}

/**
 * The seven seeded resources, in ascending rarity. Mirrors the SQL seed:
 *   ('iron',1,5) ('silica',1,4) ('copper',2,12) ('titanium',3,40)
 *   ('iridium',4,120) ('xenon',4,160) ('voidstone',5,500)
 */
export const RESOURCES: readonly Resource[] = [
  { id: "iron", name: "Iron Ore", rarity: 1, baseValue: 5 },
  { id: "silica", name: "Silica", rarity: 1, baseValue: 4 },
  { id: "copper", name: "Copper", rarity: 2, baseValue: 12 },
  { id: "titanium", name: "Titanium", rarity: 3, baseValue: 40 },
  { id: "iridium", name: "Iridium", rarity: 4, baseValue: 120 },
  { id: "xenon", name: "Xenon Crystal", rarity: 4, baseValue: 160 },
  { id: "voidstone", name: "Voidstone", rarity: 5, baseValue: 500 },
] as const;

/** Valid resource ids as a string union, derived from the catalog. */
export type ResourceId = (typeof RESOURCES)[number]["id"];

const BY_ID: ReadonlyMap<string, Resource> = new Map(
  RESOURCES.map((r) => [r.id, r]),
);

/**
 * Look up a resource by id. Throws on unknown ids so a typo surfaces loudly
 * rather than silently producing `undefined.rarity`.
 */
export function getResource(id: string): Resource {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`unknown resource id: ${id}`);
  return r;
}
