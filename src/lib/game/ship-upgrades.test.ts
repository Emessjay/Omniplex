import { describe, it, expect } from "vitest";
import {
  canCraft,
  landingRequirement,
  canLand,
  CRAFT_VALUE_MARKUP,
  FREEZING_C,
  BOILING_C,
} from "@/lib/game/rules";
import {
  UPGRADES,
  UPGRADE_IDS,
  isUpgradeId,
  getUpgrade,
  recipeOf,
  recipeCost,
  upgradeValue,
} from "@/lib/game/upgrades";

describe("upgrade catalog", () => {
  it("has the two upgrades with the user-specified components", () => {
    expect(UPGRADE_IDS).toEqual(
      expect.arrayContaining(["ablative_shields", "antifreeze_tanks"]),
    );
    expect(Object.keys(recipeOf("ablative_shields")).sort()).toEqual([
      "silica",
      "titanium",
    ]);
    expect(Object.keys(recipeOf("antifreeze_tanks")).sort()).toEqual([
      "iron",
      "titanium",
    ]);
  });

  it("recipe quantities are positive integers", () => {
    for (const u of UPGRADES) {
      for (const qty of Object.values(u.recipe)) {
        expect(Number.isInteger(qty)).toBe(true);
        expect(qty).toBeGreaterThan(0);
      }
    }
  });

  it("isUpgradeId / getUpgrade behave", () => {
    expect(isUpgradeId("ablative_shields")).toBe(true);
    expect(isUpgradeId("iron")).toBe(false);
    expect(getUpgrade("antifreeze_tanks").name.length).toBeGreaterThan(0);
  });

  it("sells for a bit above raw component cost (not less, not double)", () => {
    expect(CRAFT_VALUE_MARKUP).toBeGreaterThan(1);
    expect(CRAFT_VALUE_MARKUP).toBeLessThan(2);
    for (const id of ["ablative_shields", "antifreeze_tanks"]) {
      expect(upgradeValue(id)).toBeGreaterThan(recipeCost(id));
      expect(upgradeValue(id)).toBeLessThan(recipeCost(id) * 2);
    }
  });
});

describe("canCraft", () => {
  const recipe = { titanium: 2, silica: 4 };

  it("true when every component is covered", () => {
    expect(canCraft({ titanium: 2, silica: 4 }, recipe)).toBe(true);
    expect(canCraft({ titanium: 9, silica: 9, iron: 1 }, recipe)).toBe(true);
  });

  it("false when any component is short or missing", () => {
    expect(canCraft({ titanium: 1, silica: 4 }, recipe)).toBe(false);
    expect(canCraft({ titanium: 2 }, recipe)).toBe(false);
    expect(canCraft({}, recipe)).toBe(false);
  });
});

describe("landingRequirement", () => {
  it("freezing needs antifreeze, boiling needs ablative, mild needs nothing", () => {
    expect(landingRequirement(FREEZING_C - 1)).toBe("antifreeze_tanks");
    expect(landingRequirement(BOILING_C + 1)).toBe("ablative_shields");
    expect(landingRequirement(20)).toBeNull();
  });

  it("boundary temps are survivable bare", () => {
    expect(landingRequirement(FREEZING_C)).toBeNull();
    expect(landingRequirement(BOILING_C)).toBeNull();
  });
});

describe("canLand", () => {
  it("blocks a hostile world without the required upgrade", () => {
    const cold = canLand(-50, []);
    expect(cold.ok).toBe(false);
    if (!cold.ok) expect(cold.required).toBe("antifreeze_tanks");

    const hot = canLand(300, ["antifreeze_tanks"]); // wrong gear
    expect(hot.ok).toBe(false);
    if (!hot.ok) expect(hot.required).toBe("ablative_shields");
  });

  it("allows it when the player owns the required upgrade", () => {
    expect(canLand(-50, ["antifreeze_tanks"]).ok).toBe(true);
    expect(canLand(300, ["ablative_shields", "antifreeze_tanks"]).ok).toBe(true);
  });

  it("allows mild worlds with no upgrades at all", () => {
    expect(canLand(20, []).ok).toBe(true);
  });
});
