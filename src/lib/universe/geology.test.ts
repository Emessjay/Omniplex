import { describe, it, expect } from "vitest";
import {
  systemAt, planetAt, regionAt, regionGrid, regionIndex,
  RESOURCES, getResource,
} from "@/lib/universe";
import type { PlanetCoord } from "@/lib/universe";

const SEED = "omniplex-prod-1";
function rockyPlanets(n = 30): PlanetCoord[] {
  const out: PlanetCoord[] = [];
  for (let c = 40; c < 64 && out.length < n; c++)
    for (let s = 0; s < 80 && out.length < n; s++)
      for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster: c, system: s }).planets)
        if (!p.isGas && p.regionCount >= 300) out.push(p.coord);
  return out;
}
const METALS = new Set(["iron", "copper", "titanium"]);

describe("planet geology profile — appended, cascade-coupled", () => {
  const pcs = rockyPlanets();
  it("has volcanism/impactDensity/erosion in [0,1], deterministic", () => {
    for (const pc of pcs.slice(0, 8)) {
      const p = planetAt(SEED, pc);
      for (const v of [p.volcanism, p.impactDensity, p.erosion]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(planetAt(SEED, pc)).toStrictEqual(planetAt(SEED, pc));
    }
  });

  it("volcanism rises with eccentricity, erosion with rotationSpeed (correlation)", () => {
    const ps = pcs.map((pc) => planetAt(SEED, pc));
    const corr = (xs: number[], ys: number[]) => {
      const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) { num += (xs[i]! - mx) * (ys[i]! - my); dx += (xs[i]! - mx) ** 2; dy += (ys[i]! - my) ** 2; }
      return num / Math.sqrt(dx * dy);
    };
    expect(corr(ps.map((p) => p.eccentricity), ps.map((p) => p.volcanism))).toBeGreaterThan(0.15);
    expect(corr(ps.map((p) => p.rotationSpeed), ps.map((p) => p.erosion))).toBeGreaterThan(0.15);
  });
});

describe("region formation", () => {
  const pc = rockyPlanets(1)[0]!;
  const planet = planetAt(SEED, pc);
  const { rows, cols } = regionGrid(planet);

  it("every region has a known formation, deterministic", () => {
    const KINDS = ["volcanic_vent", "impact_crater", "sedimentary_basin", "cave_system", "tectonic_ridge", "plains"];
    for (let i = 0; i < rows * cols; i += Math.max(1, Math.floor((rows * cols) / 100))) {
      const r = regionAt(SEED, pc, i);
      expect(KINDS).toContain(r.formation);
      expect(regionAt(SEED, pc, i)).toStrictEqual(regionAt(SEED, pc, i));
    }
  });

  it("formation distribution tracks the planet's geology profile", () => {
    // a high-volcanism planet should have more volcanic_vent regions than a low-volcanism one
    const planets = rockyPlanets(30).map((pc) => ({ pc, p: planetAt(SEED, pc) }));
    const hi = planets.sort((a, b) => b.p.volcanism - a.p.volcanism)[0]!;
    const lo = planets.sort((a, b) => a.p.volcanism - b.p.volcanism)[0]!;
    const ventFrac = (pc: PlanetCoord, planet: any) => {
      const { rows, cols } = regionGrid(planet); let v = 0, n = 0;
      for (let i = 0; i < rows * cols; i += Math.max(1, Math.floor((rows * cols) / 200))) {
        if (regionAt(SEED, pc, i).formation === "volcanic_vent") v++; n++;
      }
      return v / n;
    };
    expect(ventFrac(hi.pc, hi.p)).toBeGreaterThan(ventFrac(lo.pc, lo.p));
  });
});

describe("formation → resource signature (correlated, biome-pool + rarity preserved)", () => {
  const pc = rockyPlanets(1)[0]!;
  const planet = planetAt(SEED, pc);
  const { rows, cols } = regionGrid(planet);

  it("volcanic-vent regions are metal-richer than sedimentary/plains", () => {
    let ventMetal = 0, ventN = 0, sedMetal = 0, sedN = 0;
    for (let i = 0; i < rows * cols; i += Math.max(1, Math.floor((rows * cols) / 400))) {
      const r = regionAt(SEED, pc, i);
      const metalAbundance = r.deposits.filter((d) => METALS.has(d.resourceId))
        .reduce((a, d) => a + d.abundance, 0);
      if (r.formation === "volcanic_vent") { ventMetal += metalAbundance; ventN++; }
      if (r.formation === "sedimentary_basin" || r.formation === "plains") { sedMetal += metalAbundance; sedN++; }
    }
    if (ventN > 0 && sedN > 0) expect(ventMetal / ventN).toBeGreaterThan(sedMetal / sedN);
  });

  it("biome-specific minerals still only appear in their biome (invariant preserved)", () => {
    for (let i = 0; i < rows * cols; i += Math.max(1, Math.floor((rows * cols) / 300))) {
      const r = regionAt(SEED, pc, i);
      for (const d of r.deposits) {
        const res = getResource(d.resourceId);
        if (res.biomes && res.biomes.length > 0) expect(res.biomes).toContain(r.biome);
      }
    }
  });
});
