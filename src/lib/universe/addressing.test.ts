import { describe, it, expect } from "vitest";
import {
  galaxyAt,
  systemKey,
  planetKey,
  regionKey,
  parseLocationKey,
  warpDistance,
  planetAt,
  ARM_SPAN,
  CLUSTER_SPAN,
  SYSTEM_SPAN,
} from "@/lib/universe";
import type { SystemCoord, PlanetCoord, RegionCoord } from "@/lib/universe";

const SEED = "omniplex-addressing-test";

describe("galaxyAt", () => {
  it("is deterministic and has a positive arm count that varies", () => {
    expect(galaxyAt(SEED, 3)).toStrictEqual(galaxyAt(SEED, 3));
    const counts = [];
    for (let g = 0; g < 30; g++) {
      const arm = galaxyAt(SEED, g).armCount;
      expect(Number.isInteger(arm)).toBe(true);
      expect(arm).toBeGreaterThanOrEqual(2);
      counts.push(arm);
    }
    expect(new Set(counts).size).toBeGreaterThan(1); // different galaxies differ
  });
});

describe("keys round-trip at 4 / 5 / 6 segments", () => {
  const sc: SystemCoord = { galaxy: 2, arm: 5, cluster: 9, system: 14 };
  const pc: PlanetCoord = { ...sc, planet: 3 };
  const rc: RegionCoord = { ...pc, region: 8123 };

  it("formats with galaxy:arm:cluster:system… ordering", () => {
    expect(systemKey(sc)).toBe("2:5:9:14");
    expect(planetKey(pc)).toBe("2:5:9:14:3");
    expect(regionKey(rc)).toBe("2:5:9:14:3:8123");
  });

  it("parses back to the right coord shape", () => {
    expect(parseLocationKey(systemKey(sc))).toStrictEqual(sc);
    expect(parseLocationKey(planetKey(pc))).toStrictEqual(pc);
    expect(parseLocationKey(regionKey(rc))).toStrictEqual(rc);
  });
});

describe("warpDistance — arm-wrapping, tier-weighted", () => {
  const ARM_COUNT = 12;
  const base: SystemCoord = { galaxy: 0, arm: 0, cluster: 0, system: 0 };

  it("is zero to self and symmetric", () => {
    expect(warpDistance(base, base, ARM_COUNT)).toBe(0);
    const x: SystemCoord = { galaxy: 0, arm: 3, cluster: 2, system: 5 };
    expect(warpDistance(base, x, ARM_COUNT)).toBe(warpDistance(x, base, ARM_COUNT));
    expect(warpDistance(base, x, ARM_COUNT)).toBeGreaterThan(0);
  });

  it("wraps arms symmetrically (12 arms: +5 == +7)", () => {
    const plus5: SystemCoord = { ...base, arm: 5 };
    const plus7: SystemCoord = { ...base, arm: 7 };
    expect(warpDistance(base, plus5, ARM_COUNT)).toBe(
      warpDistance(base, plus7, ARM_COUNT),
    );
    // arm 11 is distance 1 from arm 0 (wrap), not 11.
    const arm11: SystemCoord = { ...base, arm: 11 };
    const arm1: SystemCoord = { ...base, arm: 1 };
    expect(warpDistance(base, arm11, ARM_COUNT)).toBe(
      warpDistance(base, arm1, ARM_COUNT),
    );
  });

  it("weights arm ≫ cluster ≫ system", () => {
    expect(ARM_SPAN).toBeGreaterThan(CLUSTER_SPAN);
    expect(CLUSTER_SPAN).toBeGreaterThan(SYSTEM_SPAN);
    const armHop: SystemCoord = { ...base, arm: 1 };
    const clusterHop: SystemCoord = { ...base, cluster: 1 };
    const systemHop: SystemCoord = { ...base, system: 1 };
    expect(warpDistance(base, armHop, ARM_COUNT)).toBeGreaterThan(
      warpDistance(base, clusterHop, ARM_COUNT),
    );
    expect(warpDistance(base, clusterHop, ARM_COUNT)).toBeGreaterThan(
      warpDistance(base, systemHop, ARM_COUNT),
    );
  });

  it("is Infinity across different galaxies (not a warp)", () => {
    const other: SystemCoord = { galaxy: 1, arm: 0, cluster: 0, system: 0 };
    expect(warpDistance(base, other, ARM_COUNT)).toBe(Infinity);
  });
});

describe("planet generation keys off the full six-tier coord", () => {
  it("planetAt is deterministic and varies across galaxy/arm", () => {
    const c: PlanetCoord = { galaxy: 0, arm: 0, cluster: 1, system: 2, planet: 0 };
    expect(planetAt(SEED, c)).toStrictEqual(planetAt(SEED, c));
    const sameButGalaxy: PlanetCoord = { ...c, galaxy: 1 };
    expect(JSON.stringify(planetAt(SEED, c))).not.toBe(
      JSON.stringify(planetAt(SEED, sameButGalaxy)),
    );
  });
});
