import { describe, it, expect } from "vitest";
import {
  MAX_HEALTH,
  DEATH_GOLD_PENALTY,
  damageChance,
  damageAmount,
  rollHazardDamage,
  creditsAfterDeath,
} from "@/lib/game/rules";

describe("constants", () => {
  it("max health 100, death penalty 10%", () => {
    expect(MAX_HEALTH).toBe(100);
    expect(DEATH_GOLD_PENALTY).toBeCloseTo(0.1, 6);
  });
});

describe("damageChance — rises with hazard", () => {
  it("is in [0,1] and monotonically non-decreasing in hazard", () => {
    for (const h of [0, 0.25, 0.5, 0.75, 1]) {
      const c = damageChance(h);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(damageChance(0.8)).toBeGreaterThan(damageChance(0.2));
    expect(damageChance(1)).toBeGreaterThanOrEqual(damageChance(0.5));
  });
});

describe("damageAmount — rises with hazard and roll", () => {
  it("is a positive integer for hazard > 0 and scales with hazard", () => {
    const lo = damageAmount(0.2, 0.5);
    const hi = damageAmount(0.9, 0.5);
    expect(Number.isInteger(hi)).toBe(true);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo);
  });

  it("does not decrease as the roll increases (same hazard)", () => {
    expect(damageAmount(0.7, 0.9)).toBeGreaterThanOrEqual(damageAmount(0.7, 0.1));
  });
});

describe("rollHazardDamage — chance threshold then amount", () => {
  it("deals no damage when the chance roll is at/above the hazard's chance", () => {
    // chanceRoll = 1 is >= any damageChance in [0,1] -> no damage.
    expect(rollHazardDamage(0.9, 1, 0.5)).toBe(0);
  });

  it("deals damage when the chance roll is below the hazard's chance", () => {
    // chanceRoll = 0 is below any positive damageChance -> damage on a hazardous world.
    expect(rollHazardDamage(0.9, 0, 0.5)).toBeGreaterThan(0);
  });

  it("a calm world (hazard 0) is safe", () => {
    expect(rollHazardDamage(0, 0, 0.5)).toBe(0);
  });
});

describe("creditsAfterDeath — lose 10%, floored", () => {
  it("returns floor(credits * 0.9), never negative", () => {
    expect(creditsAfterDeath(1000)).toBe(900);
    expect(creditsAfterDeath(95)).toBe(85); // floor(85.5)
    expect(creditsAfterDeath(0)).toBe(0);
    expect(creditsAfterDeath(9)).toBe(8); // floor(8.1)
  });
});
