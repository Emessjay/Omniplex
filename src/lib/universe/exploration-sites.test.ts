import { describe, it, expect } from "vitest";
import {
  siteAt, siteLoot, regionAt, systemAt, planetAt,
} from "@/lib/universe";
import type { RegionCoord } from "@/lib/universe";
import { isMaterialId, getMaterial } from "@/lib/game/materials";

const SEED = "omniplex-prod-1";

// Walk surface regions across a swath of cluster-0 rocky planets.
function sampleRegions(limit = 4000): RegionCoord[] {
  const out: RegionCoord[] = [];
  for (let system = 0; system < 60 && out.length < limit; system++) {
    const sys = systemAt(SEED, { galaxy: 0, arm: 0, cluster: 0, system });
    for (const pl of sys.planets) {
      if (pl.isGas) continue;
      const rc = Math.min(pl.regionCount, 30);
      for (let r = 0; r < rc && out.length < limit; r++) {
        out.push({ ...pl.coord, region: r });
      }
    }
  }
  return out;
}

describe("siteAt — rare, deterministic, valid", () => {
  const regions = sampleRegions();

  it("sites are RARE (a small fraction of regions) but present", () => {
    const withSite = regions.filter((rc) => siteAt(SEED, rc) !== null);
    const frac = withSite.length / regions.length;
    expect(withSite.length).toBeGreaterThan(0);      // they exist
    expect(frac).toBeGreaterThan(0.005);
    expect(frac).toBeLessThan(0.20);                 // a find, not a given
  });

  it("is deterministic and well-typed", () => {
    const rc = regions.find((r) => siteAt(SEED, r) !== null)!;
    expect(siteAt(SEED, rc)).toStrictEqual(siteAt(SEED, rc));
    const s = siteAt(SEED, rc)!;
    expect(["derelict", "ruin", "anomaly"]).toContain(s.type);
    expect(s.lootTier).toBeGreaterThan(0);
  });

  it("does NOT perturb region generation (separate RNG stream)", () => {
    const rc = regions[0]!;
    const before = JSON.stringify(regionAt(SEED, { galaxy: rc.galaxy, arm: rc.arm, cluster: rc.cluster, system: rc.system, planet: rc.planet }, rc.region));
    siteAt(SEED, rc); // reading a site must not change region gen
    const after = JSON.stringify(regionAt(SEED, { galaxy: rc.galaxy, arm: rc.arm, cluster: rc.cluster, system: rc.system, planet: rc.planet }, rc.region));
    expect(after).toBe(before);
  });
});

describe("siteLoot — deterministic, real items, credit cache", () => {
  it("yields real materials + credits, deterministic, tier-monotone-ish", () => {
    const regions = sampleRegions();
    const rc = regions.find((r) => siteAt(SEED, r) !== null)!;
    const site = siteAt(SEED, rc)!;
    const loot = siteLoot(SEED, rc, site);
    expect(siteLoot(SEED, rc, site)).toStrictEqual(loot);   // deterministic
    expect(loot.credits).toBeGreaterThan(0);
    expect(loot.materials.length).toBeGreaterThan(0);
    for (const m of loot.materials) {
      expect(isMaterialId(m.id)).toBe(true);
      expect(() => getMaterial(m.id)).not.toThrow();
      expect(m.qty).toBeGreaterThan(0);
    }
  });
});
