import { describe, expect, it } from "vitest";
import { planetAt, randomStartingWorld, SPAWN_CLUSTER } from "@/lib/universe";

const SEED = "omniplex-prod-1";

/** Simple counter-based deterministic rand: cycles through evenly-spaced values. */
function makeCounter(step: number): () => number {
  let n = 0;
  return () => {
    const v = (n * step) % 1;
    n++;
    return v;
  };
}

/** LCG-based deterministic rand (a = 1664525, c = 1013904223, m = 2^32). */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("randomStartingWorld", () => {
  it("returns a coord in galaxy 0 / arm 0 / the rim spawn ring / region 0", () => {
    const coord = randomStartingWorld(SEED, makeCounter(0.1));
    expect(coord.galaxy).toBe(0);
    expect(coord.arm).toBe(0);
    // Cascade 0b: new players spawn on the SAFE rim (SPAWN_CLUSTER), not the
    // lethally-irradiated core (cluster 0, which now demands a radiation shield).
    expect(coord.cluster).toBe(SPAWN_CLUSTER);
    // region is not part of PlanetCoord — it is always 0 when the player spawns
  });

  it("returns a rocky, temperate planet", () => {
    const coord = randomStartingWorld(SEED, makeCounter(0.1));
    const planet = planetAt(SEED, coord);
    expect(planet.isGas).toBe(false);
    expect(planet.temperature).toBeGreaterThan(0);
    expect(planet.temperature).toBeLessThan(100);
  });

  it("is deterministic given the same rand sequence", () => {
    const a = randomStartingWorld(SEED, makeCounter(0.37));
    const b = randomStartingWorld(SEED, makeCounter(0.37));
    expect(a).toEqual(b);
  });

  it("yields different worlds for different rand sequences", () => {
    const results = [0.07, 0.13, 0.29, 0.41, 0.53, 0.67].map((step) =>
      randomStartingWorld(SEED, makeCounter(step)),
    );
    // At least two distinct worlds among the draws
    const unique = new Set(results.map((c) => `${c.system}:${c.planet}`));
    expect(unique.size).toBeGreaterThan(1);
  });

  it("works with an LCG rand", () => {
    const coord = randomStartingWorld(SEED, makeLcg(42));
    const planet = planetAt(SEED, coord);
    expect(planet.isGas).toBe(false);
    expect(planet.temperature).toBeGreaterThan(0);
    expect(planet.temperature).toBeLessThan(100);
    expect(coord.galaxy).toBe(0);
    expect(coord.arm).toBe(0);
    expect(coord.cluster).toBe(SPAWN_CLUSTER);
  });
});
