import { describe, it, expect } from "vitest";
import { planetAt, systemAt, startingWorld, TEMP_MIN, TEMP_MAX } from "@/lib/universe";
import type { PlanetCoord } from "@/lib/universe";

const SEED = "omniplex-prod-1";

function sample(seed: string) {
  const ps = [];
  for (let cluster = 0; cluster < 16; cluster++)
    for (let system = 0; system < 50; system++)
      for (const pl of systemAt(seed, { galaxy: 0, arm: 0, cluster, system }).planets) ps.push(pl);
  return ps;
}
const zone = (t: number) => (t < 0 ? "cold" : t <= 100 ? "warm" : "hot");
const pct = (n: number, d: number) => (100 * n) / d;

describe("size distribution + rocky/gas split (paper)", () => {
  const ps = sample(SEED);
  it("radius spans 0.5–14.3 R⊕; rocky(<1.75) ≈49%, gas(≥1.75) ≈51%", () => {
    for (const p of ps) {
      expect(p.radius).toBeGreaterThanOrEqual(0.5);
      expect(p.radius).toBeLessThanOrEqual(14.3);
      expect(p.isGas).toBe(p.radius >= 1.75);
    }
    const rocky = pct(ps.filter((p) => !p.isGas).length, ps.length);
    expect(rocky).toBeGreaterThan(42);
    expect(rocky).toBeLessThan(56); // ≈49%
  });
});

describe("temperature zones resemble the paper", () => {
  const ps = sample(SEED);
  it("overall ≈ cold 77 / warm 8 / hot 15 (loose tolerances)", () => {
    const n = ps.length;
    const cold = pct(ps.filter((p) => zone(p.temperature) === "cold").length, n);
    const warm = pct(ps.filter((p) => zone(p.temperature) === "warm").length, n);
    const hot = pct(ps.filter((p) => zone(p.temperature) === "hot").length, n);
    expect(cold).toBeGreaterThan(68);
    expect(cold).toBeLessThan(85);
    expect(warm).toBeGreaterThan(4);
    expect(warm).toBeLessThan(14);
    expect(hot).toBeGreaterThan(9);
    expect(hot).toBeLessThan(22);
  });

  it("gas giants are far more cold-skewed than rocky planets", () => {
    const coldFrac = (g: boolean) => {
      const grp = ps.filter((p) => p.isGas === g);
      return pct(grp.filter((p) => p.temperature < 0).length, grp.length);
    };
    expect(coldFrac(true)).toBeGreaterThan(coldFrac(false)); // gas colder on average
    expect(coldFrac(true)).toBeGreaterThan(82); // gas ~85-92% cold
  });

  it("temperature is bounded and deterministic", () => {
    for (const p of ps) {
      expect(p.temperature).toBeGreaterThanOrEqual(TEMP_MIN);
      expect(p.temperature).toBeLessThanOrEqual(TEMP_MAX);
    }
    const c: PlanetCoord = { galaxy: 0, arm: 0, cluster: 2, system: 7, planet: 0 };
    expect(planetAt(SEED, c)).toStrictEqual(planetAt(SEED, c));
  });
});

describe("gas planets have no surface", () => {
  it("gas planets carry the gas biome and zero deposits / no regions", () => {
    for (const p of sample(SEED).filter((x) => x.isGas)) {
      expect(p.biomePalette).toEqual(["gas"]);
      // no surface: a gas giant carries zero regions to land on / mine.
      expect(p.regionCount).toBe(0);
    }
  });

  it("rocky planets have a non-gas palette and a positive region count", () => {
    for (const p of sample(SEED).filter((x) => !x.isGas)) {
      expect(p.biomePalette).not.toContain("gas");
      expect(p.regionCount).toBeGreaterThan(0);
    }
  });
});

describe("safe starting world", () => {
  it("is a rocky, moderate-temperature planet, deterministic", () => {
    const w = startingWorld(SEED);
    expect(w).toStrictEqual(startingWorld(SEED));
    const p = planetAt(SEED, w);
    expect(p.isGas).toBe(false);
    expect(p.temperature).toBeGreaterThan(0);
    expect(p.temperature).toBeLessThan(100);
  });
});
