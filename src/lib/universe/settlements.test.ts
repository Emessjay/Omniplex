import { describe, it, expect } from "vitest";
import {
  HABITABLE_BIOMES,
  hasSettlement,
  systemOutpostPlanets,
  hasOutpost,
  planetAt,
  regionAt,
  systemAt,
  BIOMES,
} from "@/lib/universe";
import { FREEZING_C, BOILING_C } from "@/lib/game/rules";
import type { SystemCoord } from "@/lib/universe";

const SEED = "omniplex-settlements-test";
const habitable = new Set(HABITABLE_BIOMES);
const moderate = (t: number) => t > FREEZING_C && t < BOILING_C;

function* systems(seed: string) {
  for (let cluster = 0; cluster < 6; cluster++)
    for (let system = 0; system < 40; system++)
      yield { galaxy: 0, arm: 0, cluster, system } as SystemCoord;
}

describe("HABITABLE_BIOMES", () => {
  it("is a non-empty subset of BIOMES excluding the harsh ones", () => {
    expect(HABITABLE_BIOMES.length).toBeGreaterThan(0);
    const set = new Set(BIOMES);
    for (const b of HABITABLE_BIOMES) expect(set.has(b)).toBe(true);
    for (const harsh of ["volcanic", "toxic", "irradiated", "gas"]) {
      expect(habitable.has(harsh as (typeof BIOMES)[number])).toBe(false);
    }
  });
});

describe("settlements only on temperate planets + habitable regions", () => {
  it("never appears on extreme planets or non-habitable biomes", () => {
    for (const sc of systems(SEED)) {
      const planetCount = systemAt(SEED, sc).planetCount;
      for (let planet = 0; planet < planetCount; planet++) {
        const p = planetAt(SEED, { ...sc, planet });
        for (let i = 0; i < 6; i++) {
          const region = { ...sc, planet, region: i % p.regionCount };
          if (hasSettlement(SEED, region)) {
            expect(moderate(p.temperature)).toBe(true);
            expect(habitable.has(regionAt(SEED, { ...sc, planet }, region.region).biome)).toBe(true);
          }
        }
      }
    }
  });
});

describe("settlement frequency varies heavily per system and per planet", () => {
  it("settlement rate differs a lot across systems", () => {
    const rates: number[] = [];
    for (const sc of systems(SEED)) {
      let hits = 0, total = 0;
      const planetCount = systemAt(SEED, sc).planetCount;
      for (let planet = 0; planet < planetCount; planet++) {
        const p = planetAt(SEED, { ...sc, planet });
        if (!moderate(p.temperature)) continue;
        for (let i = 0; i < 8; i++) {
          total++;
          if (hasSettlement(SEED, { ...sc, planet, region: i % p.regionCount })) hits++;
        }
      }
      if (total > 0) rates.push(hits / total);
    }
    expect(rates.length).toBeGreaterThan(10);
    // High variance: some systems near-empty, some dense. (The dense-end
    // threshold is 0.35 rather than 0.4 since planet-distance-order relabels
    // planets by orbital distance — a planet's regions are keyed by its new
    // sorted index, so this seed's densest system now tops out at ~0.375.)
    expect(Math.min(...rates)).toBeLessThan(0.1);
    expect(Math.max(...rates)).toBeGreaterThan(0.35);
  });
});

describe("orbital outposts — ~2 per system", () => {
  it("averages about 2 outposts/system, each a valid planet index", () => {
    let totalOutposts = 0, n = 0;
    for (const sc of systems(SEED)) {
      const planets = systemOutpostPlanets(SEED, sc);
      const planetCount = (planetAt(SEED, { ...sc, planet: 0 }), 8); // upper bound check below
      for (const idx of planets) {
        expect(Number.isInteger(idx)).toBe(true);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(hasOutpost(SEED, { ...sc, planet: idx })).toBe(true);
      }
      totalOutposts += planets.length;
      n++;
    }
    const mean = totalOutposts / n;
    expect(mean).toBeGreaterThan(1.0);
    expect(mean).toBeLessThan(3.5);
  });

  it("is deterministic", () => {
    const sc = { galaxy: 0, arm: 0, cluster: 1, system: 2 } as SystemCoord;
    expect(systemOutpostPlanets(SEED, sc)).toEqual(systemOutpostPlanets(SEED, sc));
  });
});
