import { describe, it, expect } from "vitest";
import { systemAt, planetAt, startingWorld } from "@/lib/universe";
import type { SystemCoord } from "@/lib/universe";

const SEED = "omniplex-prod-1";

function systems(): SystemCoord[] {
  const out: SystemCoord[] = [];
  for (let cluster = 0; cluster < 8; cluster++)
    for (let system = 0; system < 40; system++)
      out.push({ galaxy: 0, arm: 0, cluster, system });
  return out;
}

describe("planets ordered by orbital distance (closest first)", () => {
  it("orbitalRadius is non-decreasing in index, and index === position", () => {
    let multiPlanet = 0;
    for (const s of systems()) {
      const { planets } = systemAt(SEED, s);
      for (let i = 0; i < planets.length; i++) {
        expect(planets[i]!.coord.planet).toBe(i);
        if (i > 0) {
          expect(planets[i]!.orbitalRadius).toBeGreaterThanOrEqual(planets[i - 1]!.orbitalRadius);
        }
      }
      if (planets.length > 1) multiPlanet++;
    }
    expect(multiPlanet).toBeGreaterThan(50); // we actually exercised multi-planet systems
  });

  it("is deterministic across repeated generation", () => {
    const s = { galaxy: 0, arm: 0, cluster: 3, system: 11 };
    expect(systemAt(SEED, s)).toStrictEqual(systemAt(SEED, s));
  });
});

describe("planetAt agrees with systemAt after the sort", () => {
  it("planetAt(c) deep-equals systemAt(system).planets[c.planet] for every in-range index", () => {
    for (const s of systems().slice(0, 60)) {
      const { planets } = systemAt(SEED, s);
      for (let p = 0; p < planets.length; p++) {
        expect(planetAt(SEED, { ...s, planet: p })).toStrictEqual(planets[p]);
      }
    }
  });
});

describe("starting world follows the sorted ordering", () => {
  it("startingWorld resolves to the planet sitting at its sorted index, rocky + moderate", () => {
    const w = startingWorld(SEED);
    expect(w).toStrictEqual(startingWorld(SEED)); // deterministic
    const sys = systemAt(SEED, { galaxy: w.galaxy, arm: w.arm, cluster: w.cluster, system: w.system });
    const p = planetAt(SEED, w);
    expect(p).toStrictEqual(sys.planets[w.planet]); // index is the sorted index
    expect(p.isGas).toBe(false);
    expect(p.temperature).toBeGreaterThan(0);
    expect(p.temperature).toBeLessThan(100);
  });
});
