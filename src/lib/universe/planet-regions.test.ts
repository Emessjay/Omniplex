import { describe, it, expect } from "vitest";
import {
  planetAt,
  regionAt,
  regionKey,
  parseLocationKey,
  getResource,
  BIOMES,
  REGION_COUNT_MIN,
  REGION_COUNT_MAX,
  PALETTE_MIN,
  PALETTE_MAX,
} from "@/lib/universe";
import type { PlanetCoord, RegionCoord } from "@/lib/universe";

const SEED = "omniplex-regions-test";

// Sample planet 0 across the FULL cluster range (core → rim). Cascade 0b floors
// planet hazard coreward via galactic radiation, so calm worlds now live at the
// RIM (high clusters) and savage worlds at the CORE (low clusters). Sampling both
// ends is what keeps both populations present (the old core-only `cluster < 4`
// sample would now be uniformly high-hazard — no calm planets).
const SAMPLE_CLUSTERS = [0, 1, 2, 3, 31, 47, 55, 60, 62, 63];
function samplePlanets(seed: string) {
  const out = [];
  for (const cluster of SAMPLE_CLUSTERS) {
    for (let system = 0; system < 25; system++) {
      // planet 0 of each sampled system is plenty.
      out.push(planetAt(seed, { galaxy: 0, arm: 0, cluster, system, planet: 0 }));
    }
  }
  return out;
}

const BIOME_SET = new Set(BIOMES);

describe("planet biome palette + region count (AC#1)", () => {
  const planets = samplePlanets(SEED);

  it("each planet has a distinct, valid biome palette of size PALETTE_MIN..MAX", () => {
    expect(PALETTE_MIN).toBeGreaterThanOrEqual(1);
    expect(PALETTE_MAX).toBeLessThanOrEqual(BIOMES.length);
    for (const p of planets) {
      expect(p.biomePalette.length).toBeGreaterThanOrEqual(PALETTE_MIN);
      expect(p.biomePalette.length).toBeLessThanOrEqual(PALETTE_MAX);
      expect(new Set(p.biomePalette).size).toBe(p.biomePalette.length); // distinct
      for (const b of p.biomePalette) expect(BIOME_SET.has(b)).toBe(true);
    }
  });

  it("regionCount is an integer within [100, 100000] for rocky worlds (0 for gas)", () => {
    expect(REGION_COUNT_MIN).toBe(100);
    expect(REGION_COUNT_MAX).toBe(100000);
    for (const p of planets) {
      expect(Number.isInteger(p.regionCount)).toBe(true);
      if (p.isGas) {
        // Gas giants have no surface (planet-taxonomy) — 0 regions.
        expect(p.regionCount).toBe(0);
      } else {
        expect(p.regionCount).toBeGreaterThanOrEqual(REGION_COUNT_MIN);
        expect(p.regionCount).toBeLessThanOrEqual(REGION_COUNT_MAX);
      }
    }
  });

  it("regionCount varies a lot across rocky planets (log-uniform spread)", () => {
    const counts = planets.filter((p) => !p.isGas).map((p) => p.regionCount);
    expect(Math.min(...counts)).toBeLessThan(2000); // some small planets
    expect(Math.max(...counts)).toBeGreaterThan(20000); // some huge ones
    expect(new Set(counts).size).toBeGreaterThan(20); // not all identical
  });
});

describe("determinism (AC#1, AC#2)", () => {
  it("planetAt is deterministic", () => {
    const c: PlanetCoord = { galaxy: 0, arm: 0, cluster: 2, system: 7, planet: 0 };
    expect(planetAt(SEED, c)).toStrictEqual(planetAt(SEED, c));
  });
  it("regionAt is deterministic", () => {
    // Use a rocky world — gas giants have no surface region (`regionAt` throws).
    const c = samplePlanets(SEED).find((p) => !p.isGas)!.coord;
    expect(regionAt(SEED, c, 17)).toStrictEqual(regionAt(SEED, c, 17));
  });
});

describe("regions draw biome from the planet palette + valid deposits (AC#2)", () => {
  it("every sampled region's biome is in its planet's palette", () => {
    const planets = samplePlanets(SEED).filter((p) => !p.isGas);
    for (const p of planets) {
      const palette = new Set(p.biomePalette);
      const idxs = [0, 1, 2, Math.floor(p.regionCount / 2), p.regionCount - 1];
      for (const i of idxs) {
        const r = regionAt(SEED, p.coord, i);
        expect(palette.has(r.biome)).toBe(true);
        for (const d of r.deposits) {
          expect(d.abundance).toBeGreaterThanOrEqual(0);
          expect(d.abundance).toBeLessThanOrEqual(1);
          // resourceId must be a real catalog id
          expect(() => getResource(d.resourceId)).not.toThrow();
        }
      }
    }
  });

  it("hazard→rarity coupling carries to region deposits", () => {
    // Deposits are on rocky surfaces only; gas giants have no regions.
    const planets = samplePlanets(SEED).filter((p) => !p.isGas);
    const savage = planets.filter((p) => p.hazard >= 0.7);
    const calm = planets.filter((p) => p.hazard <= 0.3);
    expect(savage.length).toBeGreaterThan(3);
    expect(calm.length).toBeGreaterThan(3);

    const meanTopRarity = (ps: typeof planets) => {
      const tops: number[] = [];
      for (const p of ps) {
        for (let i = 0; i < 12; i++) {
          const r = regionAt(SEED, p.coord, i % p.regionCount);
          const top = r.deposits.reduce(
            (m, d) => Math.max(m, getResource(d.resourceId).rarity),
            0,
          );
          tops.push(top);
        }
      }
      return tops.reduce((a, b) => a + b, 0) / Math.max(1, tops.length);
    };

    expect(meanTopRarity(savage)).toBeGreaterThan(meanTopRarity(calm) + 0.5);
  });
});

describe("region location keys (AC#3)", () => {
  it("regionKey round-trips as a 7-segment key", () => {
    const rc: RegionCoord = {
      manifold: 0,
      galaxy: 2,
      arm: 4,
      cluster: 5,
      system: 12,
      planet: 3,
      region: 9001,
    };
    expect(regionKey(rc)).toBe("0:2:4:5:12:3:9001");
    expect(parseLocationKey(regionKey(rc))).toStrictEqual(rc);
  });

  it("5- and 6-segment keys still parse (system / planet)", () => {
    expect(parseLocationKey("0:2:4:5:12")).toStrictEqual({
      manifold: 0,
      galaxy: 2,
      arm: 4,
      cluster: 5,
      system: 12,
    });
    expect(parseLocationKey("0:2:4:5:12:3")).toStrictEqual({
      manifold: 0,
      galaxy: 2,
      arm: 4,
      cluster: 5,
      system: 12,
      planet: 3,
    });
  });
});
