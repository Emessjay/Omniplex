import { describe, it, expect } from "vitest";
import {
  systemKey, planetKey, regionKey, parseLocationKey,
  systemAt, planetAt, warpDistance, galaxyAt,
} from "@/lib/universe";

const SEED = "omniplex-prod-1";
// helpers to build coords in a given manifold
const sys = (manifold: number, o: any = {}) => ({ manifold, galaxy: 0, arm: 0, cluster: 30, system: 5, ...o });

describe("keys carry the manifold as the leading segment", () => {
  it("systemKey/planetKey/regionKey prefix manifold; parseLocationKey round-trips", () => {
    const s = sys(-1);
    expect(systemKey(s)).toBe("-1:0:0:30:5");
    expect(planetKey({ ...s, planet: 2 })).toBe("-1:0:0:30:5:2");
    expect(regionKey({ ...s, planet: 2, region: 7 })).toBe("-1:0:0:30:5:2:7");

    expect(parseLocationKey("-1:0:0:30:5")).toMatchObject({ manifold: -1, galaxy: 0, arm: 0, cluster: 30, system: 5 });
    expect(parseLocationKey("0:0:0:30:5:2")).toMatchObject({ manifold: 0, planet: 2 });
    expect(parseLocationKey("0:0:0:30:5:2:7")).toMatchObject({ manifold: 0, region: 7 });
  });

  it("manifold 0 vs -1 produce DISTINCT keys for the same galaxy-coords (data partition)", () => {
    expect(systemKey(sys(0))).not.toBe(systemKey(sys(-1)));
  });
});

describe("generation is manifold-INVARIANT (pure partition)", () => {
  it("systemAt yields identical worlds across manifolds (same galaxy/cluster/system)", () => {
    const a = systemAt(SEED, sys(0));
    const b = systemAt(SEED, sys(-1));
    expect(a.planetCount).toBe(b.planetCount);
    expect(a.starClass).toBe(b.starClass);
    // planet attributes identical (generation ignores manifold); compare the parts
    // that don't carry the coord's manifold field.
    expect(a.planets.map((p) => p.name)).toEqual(b.planets.map((p) => p.name));
    expect(a.planets.map((p) => p.biomePalette.join(","))).toEqual(b.planets.map((p) => p.biomePalette.join(",")));
  });

  it("returned coords carry the INPUT manifold (so keys land in the right partition)", () => {
    const b = systemAt(SEED, sys(-1));
    for (const p of b.planets) expect(p.coord.manifold).toBe(-1);
    const pl = planetAt(SEED, { ...sys(-1), planet: 0 });
    expect(pl.coord.manifold).toBe(-1);
  });
});

describe("warpDistance is Infinity across manifolds", () => {
  const armCount = galaxyAt(SEED, 0).armCount;
  it("different manifold ⇒ Infinity; same manifold ⇒ finite + matches the prime", () => {
    const a0 = sys(0), b0 = sys(0, { system: 6 });
    const a1 = sys(-1), b1 = sys(-1, { system: 6 });
    expect(warpDistance(SEED, a0, a1, armCount)).toBe(Infinity);          // cross-manifold
    const d0 = warpDistance(SEED, a0, b0, armCount);
    const d1 = warpDistance(SEED, a1, b1, armCount);
    expect(Number.isFinite(d0)).toBe(true);
    expect(d1).toBeCloseTo(d0, 6);                                        // invariant within a manifold
    expect(warpDistance(SEED, a0, a0, armCount)).toBe(0);                 // 0 to self
  });
});
