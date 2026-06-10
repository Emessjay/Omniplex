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
  // `warpDistance` is seed-first now (star-coordinates) — the intra-cluster
  // system term is the Euclidean distance between star positions.
  const base: SystemCoord = { galaxy: 0, arm: 0, cluster: 0, system: 0 };

  it("is zero to self and symmetric", () => {
    expect(warpDistance(SEED, base, base, ARM_COUNT)).toBe(0);
    const x: SystemCoord = { galaxy: 0, arm: 3, cluster: 2, system: 5 };
    expect(warpDistance(SEED, base, x, ARM_COUNT)).toBeCloseTo(
      warpDistance(SEED, x, base, ARM_COUNT),
      9,
    );
    expect(warpDistance(SEED, base, x, ARM_COUNT)).toBeGreaterThan(0);
  });

  it("wraps arms symmetrically (12 arms: +5 == +7)", () => {
    // Same `system` index across arms ⇒ the system term is 0 in each (different
    // arm = different cloud, so the index-difference fallback is 0), isolating
    // the arm-ring term.
    const plus5: SystemCoord = { ...base, arm: 5 };
    const plus7: SystemCoord = { ...base, arm: 7 };
    expect(warpDistance(SEED, base, plus5, ARM_COUNT)).toBe(
      warpDistance(SEED, base, plus7, ARM_COUNT),
    );
    // arm 11 is distance 1 from arm 0 (wrap), not 11.
    const arm11: SystemCoord = { ...base, arm: 11 };
    const arm1: SystemCoord = { ...base, arm: 1 };
    expect(warpDistance(SEED, base, arm11, ARM_COUNT)).toBe(
      warpDistance(SEED, base, arm1, ARM_COUNT),
    );
  });

  it("weights arm ≫ cluster (tier span ordering holds; system term is geometric)", () => {
    // The tier-WEIGHT constants keep their strict ordering.
    expect(ARM_SPAN).toBeGreaterThan(CLUSTER_SPAN);
    expect(CLUSTER_SPAN).toBeGreaterThan(SYSTEM_SPAN);
    // An arm hop (span 100) strictly dominates a one-cluster hop (span 10), both
    // with `system` held equal so no geometric term enters.
    const armHop: SystemCoord = { ...base, arm: 1 };
    const clusterHop: SystemCoord = { ...base, cluster: 1 };
    expect(warpDistance(SEED, base, armHop, ARM_COUNT)).toBeGreaterThan(
      warpDistance(SEED, base, clusterHop, ARM_COUNT),
    );
    // The arm hop also dominates ANY intra-cluster (system) hop — the arm tier
    // outweighs the fine-grained Euclidean geometry within a cluster.
    const systemHop: SystemCoord = { ...base, system: 1 };
    const intra = warpDistance(SEED, base, systemHop, ARM_COUNT);
    expect(intra).toBeGreaterThan(0); // distinct stars in a cluster are apart
    expect(warpDistance(SEED, base, armHop, ARM_COUNT)).toBeGreaterThan(intra);
  });

  it("is Infinity across different galaxies (not a warp)", () => {
    const other: SystemCoord = { galaxy: 1, arm: 0, cluster: 0, system: 0 };
    expect(warpDistance(SEED, base, other, ARM_COUNT)).toBe(Infinity);
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
