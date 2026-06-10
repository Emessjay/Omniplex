import { describe, it, expect } from "vitest";
import {
  clusterStars,
  systemPosition,
  systemFromPosition,
  systemAt,
  warpDistance,
  galaxyAt,
  STARS_PER_CLUSTER,
  STAR_CLUSTER_MAX_RADIUS,
} from "@/lib/universe";
import type { SystemCoord } from "@/lib/universe";

const SEED = "omniplex-prod-1";
const CL = { galaxy: 0, arm: 0, cluster: 0 };
const sys = (system: number): SystemCoord => ({ ...CL, system });
const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const twoDp = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;

describe("clusterStars — fixed cloud, 2-dp, distinct, deterministic", () => {
  const stars = clusterStars(SEED, CL);

  it("has exactly STARS_PER_CLUSTER (1024) positions", () => {
    expect(STARS_PER_CLUSTER).toBe(1024);
    expect(stars).toHaveLength(STARS_PER_CLUSTER);
  });

  it("every component is rounded to 2 decimals", () => {
    for (const p of stars) {
      expect(twoDp(p.x)).toBe(true);
      expect(twoDp(p.y)).toBe(true);
      expect(twoDp(p.z)).toBe(true);
    }
  });

  it("no two stars share a position (collision avoidance)", () => {
    expect(new Set(stars.map(key)).size).toBe(stars.length);
  });

  it("is a BOUNDED cloud — every star within STAR_CLUSTER_MAX_RADIUS of origin", () => {
    expect(STAR_CLUSTER_MAX_RADIUS).toBeGreaterThan(0);
    let maxR = 0;
    for (const p of stars) {
      const r = Math.hypot(p.x, p.y, p.z);
      expect(r).toBeLessThanOrEqual(STAR_CLUSTER_MAX_RADIUS + 1e-9);
      if (r > maxR) maxR = r;
    }
    // not a degenerate point-cloud: it actually fills a fair fraction of the sphere
    expect(maxR).toBeGreaterThan(STAR_CLUSTER_MAX_RADIUS / 2);
  });

  it("is deterministic across calls", () => {
    expect(clusterStars(SEED, CL)).toStrictEqual(stars);
  });

  it("differs between clusters", () => {
    expect(clusterStars(SEED, { galaxy: 0, arm: 0, cluster: 1 })).not.toStrictEqual(stars);
  });
});

describe("systemPosition / systemFromPosition round-trip", () => {
  it("systemAt(...).position equals systemPosition", () => {
    for (const i of [0, 1, 17, 511, 1023]) {
      expect(systemAt(SEED, sys(i)).position).toStrictEqual(systemPosition(SEED, sys(i)));
    }
  });

  it("systemFromPosition inverts systemPosition for every index", () => {
    const stars = clusterStars(SEED, CL);
    for (let i = 0; i < stars.length; i += 37) {
      expect(systemFromPosition(SEED, CL, systemPosition(SEED, sys(i)))).toBe(i);
    }
  });

  it("returns null for an unoccupied coordinate", () => {
    // a wildly out-of-cloud point is exceedingly unlikely to be occupied
    expect(systemFromPosition(SEED, CL, { x: 999.99, y: -999.99, z: 999.99 })).toBeNull();
  });
});

describe("warpDistance — Euclidean within a cluster", () => {
  const armCount = galaxyAt(SEED, 0).armCount;

  it("is 0 to self, symmetric, positive between distinct same-cluster stars", () => {
    const a = sys(3);
    const b = sys(800);
    expect(warpDistance(SEED, a, a, armCount)).toBe(0);
    const ab = warpDistance(SEED, a, b, armCount);
    expect(ab).toBeGreaterThan(0);
    expect(warpDistance(SEED, b, a, armCount)).toBeCloseTo(ab, 9);
  });

  it("tracks the Euclidean position distance (closer star ⇒ smaller distance)", () => {
    const here = sys(0);
    const pos = (i: number) => systemPosition(SEED, sys(i));
    const eucl = (i: number) => {
      const a = pos(0), b = pos(i);
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    };
    // find a near and a far star by raw Euclidean distance
    let near = 1, far = 1;
    for (let i = 1; i < STARS_PER_CLUSTER; i++) {
      if (eucl(i) < eucl(near)) near = i;
      if (eucl(i) > eucl(far)) far = i;
    }
    expect(warpDistance(SEED, here, sys(near), armCount)).toBeLessThan(
      warpDistance(SEED, here, sys(far), armCount),
    );
  });

  it("different galaxies are unreachable (Infinity)", () => {
    expect(
      warpDistance(SEED, { galaxy: 0, arm: 0, cluster: 0, system: 0 },
                         { galaxy: 1, arm: 0, cluster: 0, system: 0 }, armCount),
    ).toBe(Infinity);
  });
});
