import { describe, it, expect } from "vitest";
import {
  SHIPS, SHIP_IDS, STARTER_SHIP_ID, isShipId, getShip,
  shipCargoCap, shipTradeIn, TRADE_IN_FRACTION,
} from "@/lib/game/ships";

describe("ship catalog", () => {
  it("has ~4 ships, ids unique, helpers behave", () => {
    expect(SHIPS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SHIP_IDS).size).toBe(SHIP_IDS.length);
    expect(isShipId(STARTER_SHIP_ID)).toBe(true);
    expect(isShipId("not_a_ship")).toBe(false);
    expect(() => getShip("not_a_ship")).toThrow();
    expect(shipCargoCap(STARTER_SHIP_ID)).toBe(getShip(STARTER_SHIP_ID).cargoCap);
  });

  it("the starter ship matches the players-table spawn default (cargo 50, free)", () => {
    const starter = getShip(STARTER_SHIP_ID);
    expect(starter.cargoCap).toBe(50);
    expect(starter.price).toBe(0);
  });

  it("is strictly ascending in BOTH cargo and price (no dominated ship)", () => {
    const sorted = [...SHIPS].sort((a, b) => a.price - b.price);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.price).toBeGreaterThan(sorted[i - 1]!.price);
      expect(sorted[i]!.cargoCap).toBeGreaterThan(sorted[i - 1]!.cargoCap);
    }
    // the starter is the cheapest/smallest
    expect(sorted[0]!.id).toBe(STARTER_SHIP_ID);
  });

  it("trade-in is floor(price × fraction), strictly below price (resale is a loss / sink)", () => {
    expect(TRADE_IN_FRACTION).toBeGreaterThan(0);
    expect(TRADE_IN_FRACTION).toBeLessThan(1);
    for (const s of SHIPS) {
      expect(shipTradeIn(s.id)).toBe(Math.floor(s.price * TRADE_IN_FRACTION));
      expect(shipTradeIn(s.id)).toBeLessThanOrEqual(s.price);
    }
  });
});
