import { describe, it, expect } from "vitest";
import { orbitalSiteAt, orbitalSiteLoot, planetAt, systemAt } from "@/lib/universe";
import type { PlanetCoord } from "@/lib/universe";
import { isMaterialId } from "@/lib/game/materials";
import { discoveryBountyFor, DISCOVERY_BOUNTY } from "@/lib/game/rules";
import { MAX_CARTO_TIER } from "@/lib/game/cartography";

const SEED = "omniplex-prod-1";

function samplePlanets(): PlanetCoord[] {
  const out: PlanetCoord[] = [];
  for (let system = 0; system < 120; system++)
    for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster: 0, system }).planets) out.push(p.coord);
  return out;
}

describe("orbitalSiteAt — rare, deterministic, gas-inclusive, non-perturbing", () => {
  const planets = samplePlanets();

  it("is rare (~4-8%) but present, and appears on gas giants too", () => {
    const withSite = planets.filter((c) => orbitalSiteAt(SEED, c) !== null);
    const frac = withSite.length / planets.length;
    expect(withSite.length).toBeGreaterThan(0);
    expect(frac).toBeGreaterThan(0.01);
    expect(frac).toBeLessThan(0.20);
    // at least one orbital site sits at a gas giant (orbit, not surface)
    const gasWithSite = planets.filter((c) => planetAt(SEED, c).isGas && orbitalSiteAt(SEED, c) !== null);
    expect(gasWithSite.length).toBeGreaterThan(0);
  });

  it("is deterministic and does NOT perturb planet generation", () => {
    const c = planets.find((p) => orbitalSiteAt(SEED, p) !== null)!;
    expect(orbitalSiteAt(SEED, c)).toStrictEqual(orbitalSiteAt(SEED, c));
    const before = JSON.stringify(planetAt(SEED, c));
    orbitalSiteAt(SEED, c);
    expect(JSON.stringify(planetAt(SEED, c))).toBe(before);
  });

  it("loot is deterministic, real materials, with a credit cache", () => {
    const c = planets.find((p) => orbitalSiteAt(SEED, p) !== null)!;
    const site = orbitalSiteAt(SEED, c)!;
    const loot = orbitalSiteLoot(SEED, c, site);
    expect(orbitalSiteLoot(SEED, c, site)).toStrictEqual(loot);
    expect(loot.credits).toBeGreaterThan(0);
    expect(loot.materials.length).toBeGreaterThan(0);
    for (const m of loot.materials) {
      expect(isMaterialId(m.id)).toBe(true);
      expect(m.qty).toBeGreaterThan(0);
    }
  });
});

describe("rank-scaled discovery bounty", () => {
  it("equals the base bounty at tier 0 and strictly increases with rank", () => {
    expect(discoveryBountyFor(0)).toBe(DISCOVERY_BOUNTY);
    let prev = -1;
    for (let t = 0; t <= MAX_CARTO_TIER; t++) {
      const b = discoveryBountyFor(t);
      expect(b).toBeGreaterThanOrEqual(DISCOVERY_BOUNTY);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
    expect(discoveryBountyFor(MAX_CARTO_TIER)).toBeGreaterThan(discoveryBountyFor(0));
  });
});
