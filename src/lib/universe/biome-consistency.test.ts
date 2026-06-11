import { describe, it, expect } from "vitest";
import {
  planetAt,
  regionAt,
  regionGrid,
  regionIndex,
  BIOMES,
  biomeTempOffset,
  biomeHazardOffset,
  TEMP_MIN,
  TEMP_MAX,
} from "@/lib/universe";
import { FREEZING_C, BOILING_C } from "@/lib/game/rules";

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

describe("temperature ← physical radius, not orbital distance (rule 2, planet-taxonomy)", () => {
  // The old star-brightness/orbital-closeness physics was DROPPED: temperature is
  // now derived from the planet's physical RADIUS via the paper's per-size zone
  // mix, INDEPENDENT of orbital distance. So we no longer assert a temp/orbital
  // correlation; instead we lock the new model's invariants.
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  it("temperature is bounded to [TEMP_MIN, TEMP_MAX]", () => {
    for (const p of samplePlanets(SEED)) {
      expect(p.temperature).toBeGreaterThanOrEqual(TEMP_MIN);
      expect(p.temperature).toBeLessThanOrEqual(TEMP_MAX);
    }
  });

  it("is NOT a function of orbital distance (close ≈ far on average)", () => {
    const ps = samplePlanets(SEED);
    const close = ps.filter((p) => p.orbitalRadius < 3);
    const far = ps.filter((p) => p.orbitalRadius > 20);
    expect(close.length).toBeGreaterThan(5);
    expect(far.length).toBeGreaterThan(5);
    // No insolation gradient anymore — the two groups' means are within a band,
    // not systematically ordered as the old `1/radius` model required.
    expect(Math.abs(mean(close.map((p) => p.temperature)) - mean(far.map((p) => p.temperature)))).toBeLessThan(60);
  });

  it("larger (gas) planets skew colder than smaller (rocky) ones (paper trend)", () => {
    const ps = samplePlanets(SEED);
    const gas = ps.filter((p) => p.isGas);
    const rocky = ps.filter((p) => !p.isGas);
    const coldFrac = (xs: typeof ps) => xs.filter((p) => p.temperature < FREEZING_C).length / Math.max(1, xs.length);
    expect(gas.length).toBeGreaterThan(5);
    expect(rocky.length).toBeGreaterThan(5);
    expect(coldFrac(gas)).toBeGreaterThan(coldFrac(rocky));
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

describe("climatic latitude bands replace the per-region band-clamp (rule 6, surface-grid)", () => {
  // The old invariant — every region pinned to its planet's 0/100 SIDE — is GONE:
  // a region's temperature is now a CLIMATIC function of its lat×lon grid cell, so
  // latitude variation legitimately pushes polar cells below freezing / equatorial
  // cells above boiling even on a temperate world. What still holds: a warm-equator
  // / cold-pole GRADIENT, hazard in [0,1], and a PLANET-LEVEL landing category
  // (the planet mean) that region variation can never flip.
  it("equator is warmer than the poles; region hazard stays in [0,1]", () => {
    let checked = 0;
    // Cap the planet count (each `regionAt` regenerates the system, so this is the
    // expensive sweep) — the latitude amplitude dominates the row mean by a wide
    // margin, so a strided column sample over the first planets is plenty.
    for (const p of samplePlanets(SEED).filter((x) => !x.isGas).slice(0, 60)) {
      const { rows, cols } = regionGrid(p);
      const step = Math.max(1, Math.floor(cols / 24));
      const meanRow = (lat: number) => {
        let s = 0, n = 0;
        for (let lon = 0; lon < cols; lon += step) {
          s += regionAt(SEED, p.coord, regionIndex(lat, lon, cols)).temperature;
          n++;
        }
        return s / n;
      };
      // Middle row (equator) is warmer than row 0 (a pole).
      expect(meanRow(Math.floor(rows / 2))).toBeGreaterThan(meanRow(0));
      checked++;
      // Hazard stays bounded across a spread of cells (pole / equator / far pole).
      for (const idx of [0, Math.floor((rows * cols) / 2), rows * cols - 1]) {
        const r = regionAt(SEED, p.coord, idx);
        expect(r.hazard).toBeGreaterThanOrEqual(0);
        expect(r.hazard).toBeLessThanOrEqual(1);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("latitude variation MAY cross the planet's freezing/boiling lines (clamp superseded)", () => {
    // At least one rocky planet must show a region on a DIFFERENT 0/100 side than
    // its planet mean — direct proof the old band-clamp is gone. (The landing gate
    // still reads the PLANET mean, so this creates no softlock.)
    let crossed = false;
    for (const p of samplePlanets(SEED).filter((x) => !x.isGas)) {
      const planetBand = band(p.temperature);
      const { rows, cols } = regionGrid(p);
      for (const lat of [0, Math.floor(rows / 2), rows - 1]) {
        const r = regionAt(SEED, p.coord, regionIndex(lat, 0, cols));
        if (band(r.temperature) !== planetBand) crossed = true;
      }
    }
    expect(crossed).toBe(true);
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
