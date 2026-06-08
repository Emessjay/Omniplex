import { describe, it, expect } from "vitest";
import { planetAt, regionAt, BIOMES, biomeTempOffset, biomeHazardOffset } from "@/lib/universe";
import { FREEZING_C, BOILING_C } from "@/lib/game/rules";
import type { PlanetCoord } from "@/lib/universe";

const SEED = "omniplex-biome-consistency-test";

function samplePlanets(seed: string) {
  const out = [];
  for (let cluster = 0; cluster < 6; cluster++) {
    for (let system = 0; system < 40; system++) {
      out.push(planetAt(seed, { galaxy: 0, arm: 0, cluster, system, planet: 0 }));
    }
  }
  return out;
}

// Which side of the 0/100 lines a temperature sits on.
const band = (t: number) => (t < FREEZING_C ? "freezing" : t > BOILING_C ? "boiling" : "moderate");

describe("gas is exclusive (rule 1)", () => {
  it("any palette with gas is exactly [gas]; non-gas palettes never include gas", () => {
    for (const p of samplePlanets(SEED)) {
      if (p.biomePalette.includes("gas")) {
        expect(p.biomePalette).toEqual(["gas"]);
      } else {
        expect(p.biomePalette).not.toContain("gas");
      }
    }
  });
});

describe("temperature ← star brightness + closeness (rule 2)", () => {
  // Sample correlations across the population (radius/star are in the planet).
  it("hotter outcomes correlate with smaller orbitalRadius", () => {
    const ps = samplePlanets(SEED).filter((p) => !p.biomePalette.includes("gas"));
    const close = ps.filter((p) => p.orbitalRadius < 3);
    const far = ps.filter((p) => p.orbitalRadius > 20);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    expect(close.length).toBeGreaterThan(5);
    expect(far.length).toBeGreaterThan(5);
    expect(mean(close.map((p) => p.temperature))).toBeGreaterThan(mean(far.map((p) => p.temperature)));
  });
});

describe("cold biomes scale inversely with temperature (rule 3)", () => {
  it("hot planets carry fewer tundra regions than cold planets", () => {
    const ps = samplePlanets(SEED).filter((p) => !p.biomePalette.includes("gas"));
    const hot = ps.filter((p) => p.temperature > 60);
    const cold = ps.filter((p) => p.temperature < 0);
    const tundraFrac = (group: typeof ps) => {
      let tundra = 0, total = 0;
      for (const p of group) for (let i = 0; i < 8; i++) {
        total++; if (regionAt(SEED, p.coord, i % p.regionCount).biome === "tundra") tundra++;
      }
      return total ? tundra / total : 0;
    };
    expect(hot.length).toBeGreaterThan(3);
    expect(cold.length).toBeGreaterThan(3);
    expect(tundraFrac(cold)).toBeGreaterThan(tundraFrac(hot));
  });
});

describe("extreme ⇒ small palette, moderate ⇒ larger (rule 4)", () => {
  it("moderate planets have a higher mean palette size than extreme ones", () => {
    const ps = samplePlanets(SEED).filter((p) => !p.biomePalette.includes("gas"));
    const moderate = ps.filter((p) => band(p.temperature) === "moderate" && p.temperature > 20 && p.temperature < 60);
    const extreme = ps.filter((p) => p.temperature > 150 || p.temperature < -60);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    expect(moderate.length).toBeGreaterThan(3);
    expect(extreme.length).toBeGreaterThan(3);
    expect(mean(moderate.map((p) => p.biomePalette.length))).toBeGreaterThan(
      mean(extreme.map((p) => p.biomePalette.length)),
    );
  });
});

describe("no oceans on boiling/freezing worlds (rule 5)", () => {
  it("ocean only appears on moderate planets", () => {
    for (const p of samplePlanets(SEED)) {
      if (p.biomePalette.includes("ocean")) {
        expect(band(p.temperature)).toBe("moderate");
      }
    }
  });
});

describe("per-region temp/hazard never cross 0/100; biome variation (rule 6)", () => {
  it("each region stays on the planet's side of 0 and 100, hazard in [0,1]", () => {
    for (const p of samplePlanets(SEED)) {
      const planetBand = band(p.temperature);
      for (let i = 0; i < 6; i++) {
        const r = regionAt(SEED, p.coord, i % p.regionCount);
        expect(band(r.temperature)).toBe(planetBand); // never crosses a line
        expect(r.hazard).toBeGreaterThanOrEqual(0);
        expect(r.hazard).toBeLessThanOrEqual(1);
      }
    }
  });

  it("biome offsets order extreme biomes above calm ones (exported helpers)", () => {
    expect(biomeTempOffset("volcanic")).toBeGreaterThan(biomeTempOffset("barren"));
    expect(biomeHazardOffset("volcanic")).toBeGreaterThan(biomeHazardOffset("barren"));
    expect(biomeTempOffset("tundra")).toBeLessThan(biomeTempOffset("barren"));
    for (const b of ["volcanic", "irradiated", "toxic"] as const) {
      expect(biomeHazardOffset(b)).toBeGreaterThanOrEqual(0);
    }
    for (const b of BIOMES) {
      expect(Number.isFinite(biomeTempOffset(b))).toBe(true);
      expect(Number.isFinite(biomeHazardOffset(b))).toBe(true);
    }
  });
});
