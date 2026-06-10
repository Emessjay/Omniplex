import { describe, it, expect } from "vitest";
import {
  baseCapacity, baseTierMultiplier, MAX_BASE_TIER, SILO_CAPACITY,
} from "@/lib/game/rules";
import { baseUpgradeCost, upgradeCredits, upgradeMinerals } from "@/lib/game/bases";
import { isPartId } from "@/lib/game/parts";
import { isIngotId } from "@/lib/game/ingots";

describe("tier multiplier + capacity", () => {
  it("multiplier is 1 at tier 1 and strictly increasing", () => {
    expect(baseTierMultiplier(1)).toBe(1);
    for (let t = 2; t <= MAX_BASE_TIER; t++) {
      expect(baseTierMultiplier(t)).toBeGreaterThan(baseTierMultiplier(t - 1));
    }
  });

  it("baseCapacity scales with both silo count and tier", () => {
    expect(baseCapacity(2, 1)).toBe(SILO_CAPACITY * 2);                 // tier-1 unchanged
    expect(baseCapacity(2, 3)).toBe(SILO_CAPACITY * 2 * baseTierMultiplier(3));
    expect(baseCapacity(3, 2)).toBeGreaterThan(baseCapacity(3, 1));     // higher tier = more
    expect(baseCapacity(0, 5)).toBe(0);                                 // no silos = no capacity
  });
});

describe("upgrade cost — scales up, real inputs, credits", () => {
  it("is defined for tiers 1..MAX-1 and increasing in tier", () => {
    let prevCredits = -1;
    for (let t = 1; t < MAX_BASE_TIER; t++) {
      const cost = baseUpgradeCost(t);
      const credits = upgradeCredits(t);
      expect(credits).toBeGreaterThan(0);
      expect(credits).toBeGreaterThan(prevCredits);                     // credits scale up
      prevCredits = credits;
      const mins = upgradeMinerals(t);
      const ids = Object.keys(mins);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(isPartId(id) || isIngotId(id)).toBe(true);               // siloed parts/ingots
        expect(mins[id]!).toBeGreaterThan(0);
      }
    }
  });
});
