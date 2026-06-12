import { describe, it, expect } from "vitest";
import {
  MODULES, MODULE_IDS, isModuleId, getModule, moduleValue, moduleInputValue,
  canEquip, loadoutAfterEquip, loadoutAfterUnequip, trimLoadout,
} from "@/lib/game/modules"; // (canEquip/loadout ops may live in rules.ts — import accordingly)
import { SHIPS, shipSlots } from "@/lib/game/ships";
import { isPartId } from "@/lib/game/parts";

const SLOTS = new Set(["weapon", "shield", "evasion", "ecm", "targeting"]);

describe("module catalog", () => {
  it("is a shallow archetypal set: ~5 slots, several modules, all well-formed", () => {
    expect(MODULE_IDS.length).toBeGreaterThanOrEqual(7);
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length);  // unique ids
    const slotsUsed = new Set(MODULES.map((m) => m.slot));
    expect(slotsUsed.size).toBeGreaterThanOrEqual(5);          // every slot type represented
    for (const m of MODULES) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.name.length).toBeGreaterThan(0);
      expect(SLOTS.has(m.slot)).toBe(true);
      expect(m.stats).toBeTruthy();
    }
  });

  it("recipes reference only real PARTS ids, with positive quantities", () => {
    for (const m of MODULES) {
      const entries = Object.entries(m.recipe);
      expect(entries.length).toBeGreaterThan(0);
      for (const [pid, qty] of entries) {
        expect(isPartId(pid)).toBe(true);
        expect(qty).toBeGreaterThan(0);
      }
    }
  });

  it("manufacturing adds value: value > input value for every module", () => {
    for (const m of MODULES) {
      expect(moduleInputValue(m.id)).toBeGreaterThan(0);
      expect(moduleValue(m.id)).toBeGreaterThan(moduleInputValue(m.id));
    }
  });

  it("helpers behave", () => {
    expect(isModuleId(MODULE_IDS[0]!)).toBe(true);
    expect(isModuleId("not_a_module")).toBe(false);
    expect(() => getModule("not_a_module")).toThrow();
    expect(getModule(MODULE_IDS[0]!).id).toBe(MODULE_IDS[0]);
  });
});

describe("ship slots", () => {
  it("every ship has a slot count, strictly ascending with the catalog order", () => {
    const counts = SHIPS.map((s) => shipSlots(s.id));
    for (const c of counts) expect(c).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);   // ascending shuttle→hauler
    }
    expect(shipSlots(SHIPS[0]!.id)).toBe(2);   // shuttle (the starter)
  });
});

describe("fitting rules — pure", () => {
  const M = MODULE_IDS[0]!;
  const N = MODULE_IDS[1]!;

  it("canEquip needs a free slot AND an unfitted owned copy", () => {
    expect(canEquip([], 1, M, 2)).toBe(true);              // room + own one, none fitted
    expect(canEquip([], 0, M, 2)).toBe(false);             // own none
    expect(canEquip([M, N], 1, M, 2)).toBe(false);         // slots full
    expect(canEquip([M], 1, M, 3)).toBe(false);            // own 1, already fitted 1
    expect(canEquip([M], 2, M, 3)).toBe(true);             // own 2, fitted 1 → can fit another
  });

  it("loadout add/remove are pure list ops; unequip drops the first occurrence", () => {
    expect(loadoutAfterEquip([M], N)).toEqual([M, N]);
    expect(loadoutAfterUnequip([M, N, M], M)).toEqual([N, M]);  // first M removed
    expect(loadoutAfterUnequip([N], M)).toEqual([N]);           // absent → no-op
  });

  it("trimLoadout clamps to the new ship's slot count (extras unfitted, still owned)", () => {
    expect(trimLoadout([M, N, M], 2)).toEqual([M, N]);
    expect(trimLoadout([M, N], 5)).toEqual([M, N]);            // room to spare → unchanged
    expect(trimLoadout([M, N], 0)).toEqual([]);
  });
});
