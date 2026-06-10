import { describe, it, expect } from "vitest";
import {
  INGOTS, INGOT_IDS, isIngotId, getIngot, ingotValue, ingotRecipeOf,
  ingotRawInputValue, SMELT_VALUE_MARKUP,
} from "@/lib/game/ingots";
import { PARTS, partValue, partInputValue } from "@/lib/game/parts";
import { UPGRADES, recipeCost, upgradeValue } from "@/lib/game/upgrades";
import { STRUCTURE_KINDS, isStructureKind, buildingCost } from "@/lib/game/bases";
import { basePower, BLAST_FURNACE_POWER_DEMAND } from "@/lib/game/rules";
import { RESOURCES, getResource } from "@/lib/universe";
import { ATMOSPHERES } from "@/lib/universe";

const METAL_IDS = ["iron", "copper", "cobalt", "titanium", "iridium"];

describe("ingot catalog — smelting adds value", () => {
  it("has one ingot per metal, recipes reference only real metals", () => {
    expect(INGOT_IDS.length).toBe(METAL_IDS.length);
    for (const ing of INGOTS) {
      for (const r of Object.keys(ing.recipe)) {
        expect(METAL_IDS).toContain(r);     // metals only
        expect(() => getResource(r)).not.toThrow();
        expect(ing.recipe[r]!).toBeGreaterThan(0);
      }
    }
  });

  it("ingotValue is strictly above the raw metal input value", () => {
    expect(SMELT_VALUE_MARKUP).toBeGreaterThan(1);
    for (const ing of INGOTS) {
      const raw = Object.entries(ing.recipe)
        .reduce((s, [r, q]) => s + getResource(r).baseValue * q, 0);
      expect(ingotRawInputValue(ing.id)).toBe(raw);
      expect(ingotValue(ing.id)).toBeGreaterThan(raw);
    }
  });

  it("helpers behave", () => {
    expect(isIngotId(INGOT_IDS[0]!)).toBe(true);
    expect(isIngotId("iron")).toBe(false);            // raw ore is not an ingot
    expect(() => getIngot("not_an_ingot")).toThrow();
    expect(ingotRecipeOf(INGOT_IDS[0]!)).toEqual(getIngot(INGOT_IDS[0]!).recipe);
  });
});

describe("parts rewired onto ingots", () => {
  it("every part recipe references at least one ingot and only real ids", () => {
    for (const p of PARTS) {
      const keys = Object.keys(p.recipe);
      expect(keys.some(isIngotId)).toBe(true);        // the rewire happened
      for (const k of keys) {
        const real = isIngotId(k) || RESOURCES.some((r) => r.id === k);
        expect(real).toBe(true);                       // ingot id or real resource
        expect(p.recipe[k]!).toBeGreaterThan(0);
      }
    }
  });

  it("partValue stays strictly above its (ingot + raw) input value", () => {
    for (const p of PARTS) {
      const input = Object.entries(p.recipe).reduce(
        (s, [k, q]) => s + (isIngotId(k) ? ingotValue(k) : getResource(k).baseValue) * q, 0);
      expect(partInputValue(p.id)).toBe(input);
      expect(partValue(p.id)).toBeGreaterThan(input);
    }
  });
});

describe("upgrade value chain holds after rebalance", () => {
  it("upgradeValue exceeds the summed part cost of its recipe", () => {
    for (const u of UPGRADES) {
      expect(upgradeValue(u.id)).toBeGreaterThan(recipeCost(u.id));
    }
  });
});

describe("blast furnace building + power", () => {
  it("is a structure kind with a positive-credit build cost", () => {
    expect(STRUCTURE_KINDS).toContain("blast_furnace");
    expect(isStructureKind("blast_furnace")).toBe(true);
    const cost = buildingCost("blast_furnace");
    expect(cost.credits).toBeGreaterThan(0);
  });

  it("blast furnaces draw power as consumers in basePower", () => {
    expect(BLAST_FURNACE_POWER_DEMAND).toBeGreaterThan(0);
    const ATM = ATMOSPHERES[1]!;
    const without = basePower({
      thermalPlants: 1, solarArrays: 0, excavators: 0, productionLines: 0,
      blastFurnaces: 0, temperature: 50, atmosphere: ATM,
    });
    const withFurnaces = basePower({
      thermalPlants: 1, solarArrays: 0, excavators: 0, productionLines: 0,
      blastFurnaces: 3, temperature: 50, atmosphere: ATM,
    });
    expect(withFurnaces.demand).toBe(without.demand + 3 * BLAST_FURNACE_POWER_DEMAND);
  });
});
