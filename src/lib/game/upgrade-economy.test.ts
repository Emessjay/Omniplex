import { describe, it, expect } from "vitest";
import {
  UPGRADES,
  recipeOf,
  recipeCost,
  upgradeValue,
} from "@/lib/game/upgrades";
import { isPartId, getPart } from "@/lib/game/parts";
import { canBuyFromSupply } from "@/lib/game/upgrades"; // or wherever the supply gate lives

describe("upgrade recipes are now ship parts", () => {
  it("every upgrade recipe references only valid part ids, positive qty", () => {
    for (const u of UPGRADES) {
      const recipe = recipeOf(u.id);
      const keys = Object.keys(recipe);
      expect(keys.length).toBeGreaterThan(0);
      for (const [partId, qty] of Object.entries(recipe)) {
        expect(isPartId(partId)).toBe(true);
        expect(qty).toBeGreaterThan(0);
      }
    }
  });

  it("recipeCost sums part values; upgradeValue marks it up (value > cost)", () => {
    for (const u of UPGRADES) {
      const recipe = recipeOf(u.id);
      const partSum = Object.entries(recipe).reduce(
        (sum, [pid, qty]) => sum + getPart(pid).value * qty,
        0,
      );
      expect(recipeCost(u.id)).toBe(partSum);
      expect(upgradeValue(u.id)).toBeGreaterThan(recipeCost(u.id));
    }
  });
});

describe("upgrade market supply gate", () => {
  it("can buy only when supply remains", () => {
    expect(canBuyFromSupply(1)).toBe(true);
    expect(canBuyFromSupply(5)).toBe(true);
    expect(canBuyFromSupply(0)).toBe(false);
  });
});
