import { describe, it, expect } from "vitest";
import {
  galaxyAt,
  systemKey,
  planetKey,
  regionKey,
  parseLocationKey,
  warpDistance,
  planetAt,
  clusterCenter,
  clusterRadius,
  CLUSTER_RING_SPAN,
  MAX_CLUSTERS_PER_ARM,
  STAR_CLUSTER_MAX_RADIUS,
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
      expect(arm).toBeGreaterThanOrEqual(8);
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

describe("warpDistance — polar planar metric, arm-wrapping", () => {
  // Migrated to the polar disk model (galactic-structure): `arm` is an angle and
  // `cluster` a radius; inter-cluster distance is the real planar distance
  // between cluster centers (law of cosines). The span-based weighted sum is gone.
  const ARM_COUNT = 12;
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

  it("wraps arms symmetrically (12 arms: +5 == +7, arm 11 == arm 1)", () => {
    // cos(θ) is symmetric about a full turn, so equal angular gaps in either
    // direction give equal chords — arm wrapping falls out of the geometry.
    const plus5: SystemCoord = { ...base, arm: 5 };
    const plus7: SystemCoord = { ...base, arm: 7 };
    expect(warpDistance(SEED, base, plus5, ARM_COUNT)).toBeCloseTo(
      warpDistance(SEED, base, plus7, ARM_COUNT),
      9,
    );
    // arm 11 is one step from arm 0 (wrap), the same as arm 1.
    const arm11: SystemCoord = { ...base, arm: 11 };
    const arm1: SystemCoord = { ...base, arm: 1 };
    expect(warpDistance(SEED, base, arm11, ARM_COUNT)).toBeCloseTo(
      warpDistance(SEED, base, arm1, ARM_COUNT),
      9,
    );
  });

  it("inter-cluster distance is the planar gap between cluster centers (law of cosines)", () => {
    const a: SystemCoord = { galaxy: 0, arm: 2, cluster: 3, system: 7 };
    const b: SystemCoord = { galaxy: 0, arm: 5, cluster: 6, system: 11 };
    const ca = clusterCenter(a.arm, a.cluster, ARM_COUNT);
    const cb = clusterCenter(b.arm, b.cluster, ARM_COUNT);
    expect(warpDistance(SEED, a, b, ARM_COUNT)).toBeCloseTo(
      Math.hypot(ca.x - cb.x, ca.y - cb.y),
      6,
    );
  });

  it("polar tiers: a radial cluster hop = CLUSTER_RING_SPAN; intra-cluster < a ring; arms converge at the core", () => {
    // A one-cluster RADIAL hop (same arm) is exactly one ring span apart.
    const clusterHop: SystemCoord = { ...base, cluster: 1 };
    expect(warpDistance(SEED, base, clusterHop, ARM_COUNT)).toBeCloseTo(
      CLUSTER_RING_SPAN,
      6,
    );
    // Rings don't overlap radially.
    expect(CLUSTER_RING_SPAN).toBeGreaterThan(2 * STAR_CLUSTER_MAX_RADIUS);
    // An intra-cluster (system) hop is strictly cheaper than a radial ring.
    const systemHop: SystemCoord = { ...base, system: 1 };
    const intra = warpDistance(SEED, base, systemHop, ARM_COUNT);
    expect(intra).toBeGreaterThan(0); // distinct stars in a cluster are apart
    expect(intra).toBeLessThan(CLUSTER_RING_SPAN);
    expect(warpDistance(SEED, base, clusterHop, ARM_COUNT)).toBeGreaterThan(intra);
    // Arms CONVERGE coreward: a fixed Δarm costs less near the core than the rim.
    const innerArm = warpDistance(
      SEED, { ...base, cluster: 1 }, { ...base, arm: 1, cluster: 1 }, ARM_COUNT,
    );
    const outerArm = warpDistance(
      SEED,
      { ...base, cluster: MAX_CLUSTERS_PER_ARM - 1 },
      { ...base, arm: 1, cluster: MAX_CLUSTERS_PER_ARM - 1 },
      ARM_COUNT,
    );
    expect(outerArm).toBeGreaterThan(innerArm);
    // Sanity: the inner arm chord ≈ 2·r·sin(Δθ/2) and grows with radius r.
    const dTheta = (2 * Math.PI) / ARM_COUNT;
    expect(innerArm).toBeCloseTo(2 * clusterRadius(1) * Math.sin(dTheta / 2), 6);
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
