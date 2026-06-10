import { describe, it, expect } from "vitest";
import {
  armAngle, clusterRadius, clusterCenter, galacticRadiation,
  warpDistance, galaxyAt,
  MAX_CLUSTERS_PER_ARM, CLUSTER_RING_SPAN, CLUSTER_R0, STAR_CLUSTER_MAX_RADIUS,
} from "@/lib/universe";

const SEED = "omniplex-prod-1";
const AC = galaxyAt(SEED, 0).armCount;
const sys = (arm: number, cluster: number, system = 0) =>
  ({ galaxy: 0, arm, cluster, system });

describe("polar geometry helpers", () => {
  it("armAngle = arm·2π/armCount; clusterRadius increasing with R0 offset", () => {
    expect(armAngle(0, AC)).toBeCloseTo(0, 9);
    expect(armAngle(AC, AC)).toBeCloseTo(2 * Math.PI, 9);   // full turn at armCount
    expect(clusterRadius(0)).toBeCloseTo(CLUSTER_R0 * CLUSTER_RING_SPAN, 6);
    for (let c = 1; c < 10; c++) expect(clusterRadius(c)).toBeGreaterThan(clusterRadius(c - 1));
    // rings don't overlap radially (the cluster-span-retune non-overlap rule, now radial)
    expect(CLUSTER_RING_SPAN).toBeGreaterThan(2 * STAR_CLUSTER_MAX_RADIUS);
  });

  it("clusterCenter = (r cosθ, r sinθ)", () => {
    const r = clusterRadius(3);
    const p = clusterCenter(0, 3, AC);
    expect(p.x).toBeCloseTo(r, 6);   // θ=0 → on the +x axis
    expect(p.y).toBeCloseTo(0, 6);
  });
});

describe("warpDistance — polar planar metric", () => {
  it("0 to self, symmetric, positive between distinct, Infinity across galaxies", () => {
    const a = sys(1, 2), b = sys(3, 5);
    expect(warpDistance(SEED, a, a, AC)).toBe(0);
    const ab = warpDistance(SEED, a, b, AC);
    expect(ab).toBeGreaterThan(0);
    expect(warpDistance(SEED, b, a, AC)).toBeCloseTo(ab, 6);
    expect(warpDistance(SEED, a, { ...b, galaxy: 1 }, AC)).toBe(Infinity);
  });

  it("different clusters = law-of-cosines distance between cluster centers", () => {
    const a = sys(1, 2), b = sys(4, 6);
    const ra = clusterRadius(2), rb = clusterRadius(6);
    const expected = Math.hypot(
      clusterCenter(1, 2, AC).x - clusterCenter(4, 6, AC).x,
      clusterCenter(1, 2, AC).y - clusterCenter(4, 6, AC).y,
    );
    expect(warpDistance(SEED, a, b, AC)).toBeCloseTo(expected, 6);
    // sanity: matches the law of cosines
    expect(expected).toBeCloseTo(
      Math.sqrt(ra * ra + rb * rb - 2 * ra * rb * Math.cos(armAngle(1, AC) - armAngle(4, AC))), 6);
  });

  it("arms CONVERGE at the core: a fixed arm gap is closer near the core than the rim", () => {
    // same Δarm, two radii: inner pair vs outer pair
    const inner = warpDistance(SEED, sys(0, 1), sys(1, 1), AC);
    const outer = warpDistance(SEED, sys(0, MAX_CLUSTERS_PER_ARM - 1), sys(1, MAX_CLUSTERS_PER_ARM - 1), AC);
    expect(outer).toBeGreaterThan(inner);
  });

  it("same cluster falls back to the intra-cluster star distance (positive, <= a ring step)", () => {
    const d = warpDistance(SEED, sys(2, 3, 0), sys(2, 3, 500), AC);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(CLUSTER_RING_SPAN);   // intra-cluster < one radial ring
  });
});

describe("finite disk + radiation", () => {
  it("MAX_CLUSTERS_PER_ARM is a positive bound", () => {
    expect(MAX_CLUSTERS_PER_ARM).toBeGreaterThan(0);
  });

  it("radiation peaks at the core, decays to ~0 at the rim, stays in range", () => {
    expect(galacticRadiation(0)).toBeGreaterThan(0);                       // core is hot
    let prev = Infinity;
    for (let c = 0; c < MAX_CLUSTERS_PER_ARM; c++) {
      const rad = galacticRadiation(c);
      expect(rad).toBeGreaterThanOrEqual(0);
      expect(rad).toBeLessThanOrEqual(prev);                               // non-increasing
      prev = rad;
    }
    expect(galacticRadiation(0)).toBeGreaterThan(galacticRadiation(MAX_CLUSTERS_PER_ARM - 1));
  });
});
