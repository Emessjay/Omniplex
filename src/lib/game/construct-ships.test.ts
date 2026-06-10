import { describe, it, expect } from "vitest";
import {
  SHIPS, getShip, STARTER_SHIP_ID,
  shipRecipeOf, isBuildableShip, shipRecipeValue,
} from "@/lib/game/ships";
import { isPartId, partValue } from "@/lib/game/parts";
import { isIngotId, ingotValue } from "@/lib/game/ingots";

describe("ship recipes", () => {
  it("the starter ship is NOT buildable (no recipe); others are", () => {
    expect(isBuildableShip(STARTER_SHIP_ID)).toBe(false);
    expect(shipRecipeOf(STARTER_SHIP_ID)).toBeNull();
    const buildable = SHIPS.filter((s) => s.id !== STARTER_SHIP_ID);
    expect(buildable.length).toBeGreaterThanOrEqual(2);
    for (const s of buildable) expect(isBuildableShip(s.id)).toBe(true);
  });

  it("every buildable recipe uses only real part/ingot ids, positive qty", () => {
    for (const s of SHIPS) {
      const r = shipRecipeOf(s.id);
      if (r === null) continue;
      const keys = Object.keys(r);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) {
        expect(isPartId(k) || isIngotId(k)).toBe(true);
        expect(r[k]!).toBeGreaterThan(0);
      }
    }
  });

  it("shipRecipeValue is the summed input value, and 0 < it < buy price", () => {
    for (const s of SHIPS) {
      const r = shipRecipeOf(s.id);
      if (r === null) continue;
      const expected = Object.entries(r).reduce(
        (sum, [k, q]) => sum + (isIngotId(k) ? ingotValue(k) : partValue(k)) * q, 0);
      expect(shipRecipeValue(s.id)).toBe(expected);
      expect(shipRecipeValue(s.id)).toBeGreaterThan(0);
      expect(shipRecipeValue(s.id)).toBeLessThan(getShip(s.id).price); // build cheaper than buy
    }
  });

  it("bigger ships cost more to build (recipe value ascends with cargo)", () => {
    const buildable = SHIPS.filter((s) => shipRecipeOf(s.id) !== null)
      .sort((a, b) => a.cargoCap - b.cargoCap);
    for (let i = 1; i < buildable.length; i++) {
      expect(shipRecipeValue(buildable[i]!.id)).toBeGreaterThan(shipRecipeValue(buildable[i - 1]!.id));
    }
  });
});
