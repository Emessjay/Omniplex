import { describe, it, expect } from "vitest";
import {
  RESOURCES,
  getResource,
  mineralsForBiome,
  planetAt,
  regionAt,
  BIOMES,
} from "@/lib/universe";
import type { PlanetCoord } from "@/lib/universe";

const SEED = "omniplex-biome-minerals-test";

describe("mineral catalog with biome-specific entries", () => {
  it("has both general and biome-specific minerals, all with valid fields", () => {
    const biomeSet = new Set(BIOMES);
    let general = 0;
    let specific = 0;
    for (const r of RESOURCES) {
      expect(r.rarity).toBeGreaterThanOrEqual(1);
      expect(r.rarity).toBeLessThanOrEqual(5);
      expect(r.baseValue).toBeGreaterThanOrEqual(0);
      const biomes = (r as { biomes?: string[] }).biomes;
      if (biomes && biomes.length) {
        specific++;
        for (const b of biomes) expect(biomeSet.has(b as any)).toBe(true);
      } else {
        general++;
      }
    }
    expect(general).toBeGreaterThan(0);
    expect(specific).toBeGreaterThan(0); // new biome-specific minerals exist
  });

  it("mineralsForBiome returns general + that biome's specifics, never another biome's", () => {
    for (const biome of BIOMES) {
      const pool = mineralsForBiome(biome);
      expect(pool.length).toBeGreaterThan(0);
      for (const r of pool) {
        const biomes = (r as { biomes?: string[] }).biomes;
        if (biomes && biomes.length) expect(biomes).toContain(biome);
      }
      // A mineral specific to a DIFFERENT biome must be excluded.
      const otherSpecific = RESOURCES.find((r) => {
        const b = (r as { biomes?: string[] }).biomes;
        return b && b.length && !b.includes(biome);
      });
      if (otherSpecific) expect(pool).not.toContainEqual(otherSpecific);
    }
  });
});

describe("biome-specific deposits are confined to their biomes", () => {
  it("no region yields a mineral that's specific to a different biome", () => {
    const isSpecificTo = (id: string) =>
      (getResource(id) as { biomes?: string[] }).biomes ?? null;
    for (let cluster = 0; cluster < 4; cluster++) {
      for (let system = 0; system < 15; system++) {
        const pc: PlanetCoord = { galaxy: 0, arm: 0, cluster, system, planet: 0 };
        const planet = planetAt(SEED, pc);
        // Gas giants (planet-taxonomy) have no surface regions/deposits — skip.
        if (planet.isGas) continue;
        const samples = [0, 1, 2, Math.floor(planet.regionCount / 2)];
        for (const i of samples) {
          const r = regionAt(SEED, pc, i);
          for (const d of r.deposits) {
            const biomes = isSpecificTo(d.resourceId);
            if (biomes) expect(biomes).toContain(r.biome);
          }
        }
      }
    }
  });
});
