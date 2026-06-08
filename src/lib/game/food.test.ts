/**
 * P6 food subsystem — pure-logic guards.
 *
 * Covers the catalog contract (food are `category:"food"` materials with a
 * positive `heal` and a material-only recipe), the pure `healValue` cap (never
 * overheal past MAX_HEALTH), and the eat/cook arithmetic at the pure level
 * (eating raises HP without overshoot; cooking consumes ingredients). The DB
 * handlers in `commands.ts` stay thin over these.
 */
import { describe, it, expect } from "vitest";
import {
  MATERIALS,
  FOOD,
  FOOD_IDS,
  FOOD_RECIPES,
  foodRecipeOf,
  healOf,
  isFoodId,
  isMaterialId,
  getMaterial,
  materialValue,
  SCAVENGEABLE,
} from "@/lib/game/materials";
import { healValue, canCraft, MAX_HEALTH } from "@/lib/game/rules";

describe("food catalog", () => {
  it("there are several craftable foods, each category:food with heal > 0", () => {
    expect(FOOD.length).toBeGreaterThanOrEqual(3);
    for (const f of FOOD) {
      expect(f.category).toBe("food");
      expect(f.heal ?? 0).toBeGreaterThan(0);
      expect(f.value).toBeGreaterThan(0);
      expect(isFoodId(f.id)).toBe(true);
      expect(healOf(f.id)).toBe(f.heal);
    }
  });

  it("FOOD_IDS lines up with the food materials in the catalog", () => {
    const catalogFood = MATERIALS.filter((m) => m.category === "food").map((m) => m.id);
    expect([...FOOD_IDS].sort()).toEqual([...catalogFood].sort());
  });

  it("every food has a recipe of real, positive material ingredients", () => {
    for (const id of FOOD_IDS) {
      const recipe = foodRecipeOf(id);
      const entries = Object.entries(recipe);
      expect(entries.length).toBeGreaterThan(0);
      for (const [matId, qty] of entries) {
        expect(isMaterialId(matId), `${id} ingredient ${matId}`).toBe(true);
        // You don't cook food out of other food.
        expect(isFoodId(matId), `${id} ingredient ${matId} is raw`).toBe(false);
        expect(qty).toBeGreaterThan(0);
      }
    }
  });

  it("non-food materials are inedible (healOf 0, isFoodId false)", () => {
    for (const m of MATERIALS) {
      if (m.category === "food") continue;
      expect(isFoodId(m.id)).toBe(false);
      expect(healOf(m.id)).toBe(0);
    }
  });

  it("food is sellable (has a fixed value) but never scavenged or dropped", () => {
    for (const id of FOOD_IDS) {
      expect(materialValue(id)).toBeGreaterThan(0);
    }
    // Cooked food is crafted, never found while scavenging.
    expect(SCAVENGEABLE.some((m) => m.category === "food")).toBe(false);
  });

  it("foodRecipeOf throws on an unknown food id", () => {
    expect(() => foodRecipeOf("not_a_food")).toThrow();
  });
});

describe("healValue (no overheal)", () => {
  it("adds the heal amount when below max", () => {
    expect(healValue(40, 20, 100)).toBe(60);
    expect(healValue(1, 35, 100)).toBe(36);
  });

  it("caps at maxHp and never overheals", () => {
    expect(healValue(90, 55, 100)).toBe(100);
    expect(healValue(100, 20, 100)).toBe(100);
    expect(healValue(99, 1, 100)).toBe(100);
  });

  it("defaults maxHp to MAX_HEALTH", () => {
    expect(healValue(MAX_HEALTH - 10, 999)).toBe(MAX_HEALTH);
  });

  it("a non-positive heal can't reduce health", () => {
    expect(healValue(50, 0, 100)).toBe(50);
    expect(healValue(50, -10, 100)).toBe(50);
  });

  it("eating a real food brings a wounded player up by exactly its heal (capped)", () => {
    for (const f of FOOD) {
      const wounded = 10;
      const expected = Math.min(MAX_HEALTH, wounded + (f.heal ?? 0));
      expect(healValue(wounded, healOf(f.id), MAX_HEALTH)).toBe(expected);
      // At full HP, eating never exceeds the cap.
      expect(healValue(MAX_HEALTH, healOf(f.id), MAX_HEALTH)).toBe(MAX_HEALTH);
    }
  });
});

describe("cooking arithmetic (canCraft over material stores)", () => {
  it("accepts when ingredients are fully covered and rejects when short", () => {
    const recipe = FOOD_RECIPES["field_stew"]!;
    const enough: Record<string, number> = {};
    for (const [mid, qty] of Object.entries(recipe)) enough[mid] = qty;
    expect(canCraft(enough, recipe)).toBe(true);

    // One short of a single ingredient → can't cook.
    const firstId = Object.keys(recipe)[0]!;
    const short = { ...enough, [firstId]: (enough[firstId] ?? 0) - 1 };
    expect(canCraft(short, recipe)).toBe(false);

    // Missing ingredient entirely reads as 0 held.
    expect(canCraft({}, recipe)).toBe(false);
  });

  it("consuming a recipe and yielding food preserves the no-negative invariant", () => {
    // Model the pure side of `handleCookFood`: subtract each ingredient, add one
    // food. With exactly-enough on hand, every store lands at 0 or the yield.
    const foodId = "spore_broth";
    const recipe = foodRecipeOf(foodId);
    const have: Record<string, number> = {};
    for (const [mid, qty] of Object.entries(recipe)) have[mid] = qty;
    have[foodId] = 0;

    expect(canCraft(have, recipe)).toBe(true);
    for (const [mid, qty] of Object.entries(recipe)) have[mid]! -= qty;
    have[foodId]! += 1;

    for (const [mid, count] of Object.entries(have)) {
      expect(count, `${mid} not negative`).toBeGreaterThanOrEqual(0);
    }
    expect(have[foodId]).toBe(1);
  });
});

describe("getMaterial integrity for food", () => {
  it("getMaterial resolves each food and exposes its heal", () => {
    for (const id of FOOD_IDS) {
      const m = getMaterial(id);
      expect(m.heal).toBeGreaterThan(0);
    }
  });
});
