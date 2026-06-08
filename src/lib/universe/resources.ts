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
 *
 * A mineral is either GENERAL (no `biomes`, can appear in any region as the
 * original seven always have) or BIOME-SPECIFIC (`biomes` non-empty: it only
 * appears in regions whose biome is in the list). `depositsFor` (gen.ts) builds
 * each region's candidate pool from `mineralsForBiome`, so biome-specifics stay
 * confined to their biomes while general minerals appear everywhere.
 */

// Type-only import (erased at runtime) — avoids a runtime circular dependency
// with `types.ts`, which imports `ResourceId` from here.
import type { Biome } from "./types";

export interface Resource {
  /** Stable slug, e.g. "iron". Matches `resources.id` in the DB. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Rarity tier 1..5; 5 is legendary. */
  readonly rarity: number;
  /** Baseline credits-per-unit value (matches `resources.base_value`). */
  readonly baseValue: number;
  /**
   * Biome restriction. Omitted/empty → a GENERAL mineral (appears anywhere).
   * Non-empty → BIOME-SPECIFIC: the mineral only appears in regions whose biome
   * is one of these. See `mineralsForBiome`.
   */
  readonly biomes?: readonly Biome[];
}

/**
 * The mineral catalog. The original seven GENERAL minerals (in ascending
 * rarity) plus several BIOME-SPECIFIC ones spread across a few biomes. Mirrors
 * the SQL seed in the `bases-minerals` migration — the two MUST stay in
 * lock-step (id, name, rarity, baseValue). General ones:
 *   ('iron',1,5) ('silica',1,4) ('copper',2,12) ('cobalt',2,18)
 *   ('titanium',3,40) ('iridium',4,120) ('xenon',4,160) ('voidstone',5,500)
 * Biome-specific ones carry a `biomes` restriction (see below).
 */
export const RESOURCES: readonly Resource[] = [
  // General minerals — appear in any region's deposit pool.
  { id: "iron", name: "Iron Ore", rarity: 1, baseValue: 5 },
  { id: "silica", name: "Silica", rarity: 1, baseValue: 4 },
  { id: "copper", name: "Copper", rarity: 2, baseValue: 12 },
  { id: "cobalt", name: "Cobalt", rarity: 2, baseValue: 18 },
  { id: "titanium", name: "Titanium", rarity: 3, baseValue: 40 },
  { id: "iridium", name: "Iridium", rarity: 4, baseValue: 120 },
  { id: "xenon", name: "Xenon Crystal", rarity: 4, baseValue: 160 },
  { id: "voidstone", name: "Voidstone", rarity: 5, baseValue: 500 },

  // Biome-specific minerals — only surface in their listed biomes' regions.
  { id: "pyrite", name: "Pyrite", rarity: 2, baseValue: 28, biomes: ["volcanic"] },
  { id: "verdite", name: "Verdite", rarity: 2, baseValue: 36, biomes: ["jungle"] },
  { id: "aquamarine", name: "Aquamarine", rarity: 3, baseValue: 85, biomes: ["ocean"] },
  { id: "radium_salt", name: "Radium Salt", rarity: 4, baseValue: 130, biomes: ["irradiated", "toxic"] },
  { id: "prismatic_gem", name: "Prismatic Gem", rarity: 4, baseValue: 150, biomes: ["crystalline"] },
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

/** Whether a resource is biome-specific (restricted to one or more biomes). */
export function isBiomeSpecific(r: Resource): boolean {
  return !!r.biomes && r.biomes.length > 0;
}

/**
 * The minerals that can appear in a region of the given `biome`: every GENERAL
 * mineral (no biome restriction) plus the BIOME-SPECIFIC minerals whose `biomes`
 * include this biome. A mineral specific to a *different* biome is never
 * returned. This is the candidate pool `depositsFor` (gen.ts) draws from, so
 * biome-specifics stay confined to their biomes.
 */
export function mineralsForBiome(biome: Biome): Resource[] {
  return RESOURCES.filter((r) => !isBiomeSpecific(r) || r.biomes!.includes(biome));
}
