import { describe, it, expect } from "vitest";
import {
  STRUCTURE_KINDS,
  isStructureKind,
  buildingCost,
  creditsOf,
  mineralsOf,
  canAffordBase,
} from "@/lib/game/bases";

describe("structure-kind catalog", () => {
  it("recognizes the in-base structures and nothing else", () => {
    expect(isStructureKind("silo")).toBe(true);
    expect(isStructureKind("excavator")).toBe(true);
    expect(isStructureKind("production_line")).toBe(true); // P8b
    expect(isStructureKind("thermal_plant")).toBe(true); // P13
    expect(isStructureKind("solar_array")).toBe(true); // P13
    expect(isStructureKind("blast_furnace")).toBe(true); // blast-furnace phase
    expect(isStructureKind("crop_farm")).toBe(true); // crop-farming phase
    expect(isStructureKind("livestock_pen")).toBe(true); // animal-husbandry phase
    expect(isStructureKind("base")).toBe(false); // the base itself is not an in-base structure
    expect(isStructureKind("nonsense")).toBe(false);
    expect([...STRUCTURE_KINDS]).toEqual([
      "silo",
      "excavator",
      "production_line",
      "thermal_plant",
      "solar_array",
      "blast_furnace",
      "crop_farm",
      "livestock_pen",
    ]);
  });
});

describe("building cost maps", () => {
  it("every structure kind has a positive cost with at least credits", () => {
    for (const kind of STRUCTURE_KINDS) {
      const cost = buildingCost(kind);
      expect(creditsOf(cost)).toBeGreaterThan(0);
      // total cost lines (incl. minerals) all positive
      for (const v of Object.values(cost)) expect(v).toBeGreaterThan(0);
    }
  });

  it("creditsOf/mineralsOf split a cost map cleanly", () => {
    const cost = buildingCost("excavator");
    expect(creditsOf(cost)).toBe(cost.credits);
    expect(mineralsOf(cost)).not.toHaveProperty("credits");
    // minerals + credits reconstruct the original map
    expect({ ...mineralsOf(cost), credits: creditsOf(cost) }).toEqual(cost);
  });

  it("canAffordBase gates a building cost the same way it gates a base", () => {
    const cost = buildingCost("silo"); // { credits: 300, iron: 5 }
    expect(canAffordBase({ credits: 300, iron: 5 }, cost)).toBe(true);
    expect(canAffordBase({ credits: 1000, iron: 99 }, cost)).toBe(true);
    expect(canAffordBase({ credits: 299, iron: 5 }, cost)).toBe(false); // short credits
    expect(canAffordBase({ credits: 300, iron: 4 }, cost)).toBe(false); // short mineral
    expect(canAffordBase({ credits: 300 }, cost)).toBe(false); // missing mineral reads as 0
  });
});
