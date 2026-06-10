import { describe, it, expect } from "vitest";
import {
  canHyperwarp, isValidInGalaxyTarget, isAdjacentGalaxy,
  CONDENSATE_RECIPE, HYPERWARP_CONDENSATE_ID,
} from "@/lib/game/galaxy-jump";
import { MAX_CLUSTERS_PER_ARM, STARS_PER_CLUSTER } from "@/lib/universe";

describe("condensate gate", () => {
  it("requires at least one condensate", () => {
    expect(canHyperwarp(0).ok).toBe(false);
    expect(canHyperwarp(1).ok).toBe(true);
    expect(canHyperwarp(5).ok).toBe(true);
    expect(CONDENSATE_RECIPE.voidstone).toBeGreaterThan(0);
    expect(HYPERWARP_CONDENSATE_ID.length).toBeGreaterThan(0);
  });
});

describe("in-galaxy destination validation", () => {
  const armCount = 12;
  it("accepts in-range cluster/system; arm is always valid (mod armCount)", () => {
    expect(isValidInGalaxyTarget(0, 0, 0, armCount)).toBe(true);
    expect(isValidInGalaxyTarget(3, MAX_CLUSTERS_PER_ARM - 1, STARS_PER_CLUSTER - 1, armCount)).toBe(true);
    expect(isValidInGalaxyTarget(999, 5, 5, armCount)).toBe(true); // arm wraps
  });
  it("rejects out-of-range cluster or system", () => {
    expect(isValidInGalaxyTarget(0, MAX_CLUSTERS_PER_ARM, 0, armCount)).toBe(false); // beyond rim
    expect(isValidInGalaxyTarget(0, -1, 0, armCount)).toBe(false);
    expect(isValidInGalaxyTarget(0, 0, STARS_PER_CLUSTER, armCount)).toBe(false);   // beyond cluster
    expect(isValidInGalaxyTarget(0, 0, -1, armCount)).toBe(false);
  });
});

describe("adjacent-galaxy rule", () => {
  it("only galaxies exactly one step away (and >= 0) are adjacent", () => {
    expect(isAdjacentGalaxy(0, 1)).toBe(true);
    expect(isAdjacentGalaxy(5, 4)).toBe(true);
    expect(isAdjacentGalaxy(5, 6)).toBe(true);
    expect(isAdjacentGalaxy(0, 0)).toBe(false);   // same galaxy
    expect(isAdjacentGalaxy(0, 2)).toBe(false);   // two away
    expect(isAdjacentGalaxy(1, -1)).toBe(false);  // negative target
  });
});
