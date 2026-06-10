import { describe, it, expect } from "vitest";
import {
  PARTS,
  PART_IDS,
  isPartId,
  getPart,
  partRecipeOf,
  partValue,
  partInputValue,
} from "@/lib/game/parts";
import { isIngotId } from "@/lib/game/ingots";
import { canProduce } from "@/lib/game/rules";
import {
  STRUCTURE_KINDS,
  isStructureKind,
  buildingCost,
  creditsOf,
  canAffordBase,
} from "@/lib/game/bases";
import { getResource, RESOURCES } from "@/lib/universe";

const RESOURCE_IDS = new Set(RESOURCES.map((r) => r.id));

describe("ship-parts catalog integrity (AC#3)", () => {
  it("has at least a handful of parts with unique ids", () => {
    expect(PARTS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(PART_IDS).size).toBe(PART_IDS.length);
    expect([...PART_IDS]).toEqual(PARTS.map((p) => p.id));
  });

  it("every recipe references only real ids (ingot or mineral), with positive quantities", () => {
    // The blast-furnace rewire: part recipes now consume INGOTS for their metal
    // inputs (and may keep a raw non-metal like silica), so a recipe key is a real
    // ingot id OR a real mineral id.
    for (const part of PARTS) {
      const entries = Object.entries(part.recipe);
      expect(entries.length, `${part.id} has an empty recipe`).toBeGreaterThan(0);
      for (const [rid, qty] of entries) {
        const real = isIngotId(rid) || RESOURCE_IDS.has(rid);
        expect(real, `${part.id} references unknown input ${rid}`).toBe(true);
        // getResource must not throw for a raw (non-ingot) ingredient.
        if (!isIngotId(rid)) expect(() => getResource(rid)).not.toThrow();
        expect(qty).toBeGreaterThan(0);
        expect(Number.isInteger(qty)).toBe(true);
      }
    }
  });

  it("every part is worth strictly more than its inputs (manufacturing adds value)", () => {
    for (const part of PARTS) {
      const input = partInputValue(part.id);
      expect(input).toBeGreaterThan(0);
      expect(part.value, `${part.id} value must exceed input cost ${input}`).toBeGreaterThan(input);
    }
  });

  it("helpers resolve known ids and throw loudly on unknown ones", () => {
    expect(isPartId("hull_plating")).toBe(true);
    expect(isPartId("iron")).toBe(false); // a raw mineral is not a part
    expect(isPartId("nonsense")).toBe(false);
    const p = PARTS[0]!;
    expect(getPart(p.id)).toBe(p);
    expect(partRecipeOf(p.id)).toEqual(p.recipe);
    expect(partValue(p.id)).toBe(p.value);
    expect(() => getPart("nonsense")).toThrow();
    expect(() => partRecipeOf("nonsense")).toThrow();
    expect(() => partValue("nonsense")).toThrow();
  });
});

describe("canProduce (siloed inputs vs recipe) (AC#2)", () => {
  const recipe = { iron: 8, titanium: 2 };

  it("is true exactly when every input is siloed in sufficient quantity", () => {
    expect(canProduce({ iron: 8, titanium: 2 }, recipe)).toBe(true);
    expect(canProduce({ iron: 100, titanium: 100 }, recipe)).toBe(true);
    expect(canProduce({ iron: 7, titanium: 2 }, recipe)).toBe(false); // short iron
    expect(canProduce({ iron: 8, titanium: 1 }, recipe)).toBe(false); // short titanium
  });

  it("treats a missing input as zero stored", () => {
    expect(canProduce({ iron: 8 }, recipe)).toBe(false); // titanium absent
    expect(canProduce({}, recipe)).toBe(false);
    expect(canProduce({}, {})).toBe(true); // empty recipe needs nothing
  });

  it("scales the requirement by the requested quantity", () => {
    expect(canProduce({ iron: 16, titanium: 4 }, recipe, 2)).toBe(true);
    expect(canProduce({ iron: 16, titanium: 3 }, recipe, 2)).toBe(false); // need 4 titanium
    expect(canProduce({ iron: 8, titanium: 2 }, recipe, 2)).toBe(false); // only enough for 1
  });

  it("is vacuously true for a non-positive quantity (handler rejects it separately)", () => {
    expect(canProduce({}, recipe, 0)).toBe(true);
    expect(canProduce({}, recipe, -3)).toBe(true);
  });
});

describe("production_line as an in-base structure (AC#1)", () => {
  it("is a recognized structure kind", () => {
    expect(isStructureKind("production_line")).toBe(true);
    expect(STRUCTURE_KINDS).toContain("production_line");
  });

  it("has a positive build cost that canAffordBase gates uniformly", () => {
    const cost = buildingCost("production_line");
    expect(creditsOf(cost)).toBeGreaterThan(0);
    for (const v of Object.values(cost)) expect(v).toBeGreaterThan(0);
    // a wealthy player covers it; a broke one does not.
    const rich: Record<string, number> = {};
    for (const k of Object.keys(cost)) rich[k] = 100;
    rich.credits = 100_000;
    expect(canAffordBase(rich, cost)).toBe(true);
    expect(canAffordBase({ credits: 0 }, cost)).toBe(false);
  });
});
