import { describe, it, expect } from "vitest";
import {
  notorietyDecayed, notorietyTier, lawResponseFor,
  NOTORIETY_TIERS, MAX_NOTORIETY_TIER, NOTORIETY_DECAY_PER_MS,
} from "@/lib/game/rules";

describe("notorietyDecayed — cools toward 0", () => {
  it("decreases toward 0 without overshoot, floored at 0", () => {
    const start = 500;
    const half = notorietyDecayed(start, (start / NOTORIETY_DECAY_PER_MS) / 2);
    expect(half).toBeLessThan(start);
    expect(half).toBeGreaterThanOrEqual(0);
    // enough elapsed to fully cool → exactly 0, never negative
    expect(notorietyDecayed(start, start / NOTORIETY_DECAY_PER_MS * 2)).toBe(0);
  });
  it("is monotonically non-increasing in elapsed, and an integer", () => {
    let prev = notorietyDecayed(1000, 0);
    expect(prev).toBe(1000);                         // no time → unchanged
    for (const e of [1e6, 5e6, 2e7, 1e8, 1e9]) {
      const v = notorietyDecayed(1000, e);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
  it("non-positive elapsed leaves it unchanged", () => {
    expect(notorietyDecayed(300, 0)).toBe(300);
    expect(notorietyDecayed(300, -5000)).toBe(300);
  });
});

describe("notorietyTier — monotonic ladder", () => {
  it("Clean at 0, ascending, clamps at the top", () => {
    expect(NOTORIETY_TIERS.length).toBeGreaterThanOrEqual(3);
    expect(notorietyTier(0)).toBe(0);                // clean at zero
    // minNotoriety ascends with tier
    for (let i = 1; i < NOTORIETY_TIERS.length; i++) {
      expect(NOTORIETY_TIERS[i]!.minNotoriety).toBeGreaterThan(NOTORIETY_TIERS[i - 1]!.minNotoriety);
    }
    // clamps at the max tier for very high heat
    expect(notorietyTier(10_000_000)).toBe(MAX_NOTORIETY_TIER);
  });
  it("is monotonic non-decreasing in notoriety", () => {
    let prev = -1;
    for (const n of [0, 50, 200, 800, 3000, 50000]) {
      const t = notorietyTier(n);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
  it("each tier has a title and non-empty law-response copy", () => {
    for (const tier of NOTORIETY_TIERS) {
      expect(tier.title.length).toBeGreaterThan(0);
      expect(lawResponseFor(tier.tier).length).toBeGreaterThan(0);
    }
  });
});
