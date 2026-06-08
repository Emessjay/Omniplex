import { describe, expect, it } from "vitest";
import {
  PRICE_FLOOR,
  priceAfterPurchase,
  priceAfterSale,
} from "./rules";

/**
 * Stickiness contract for the volume-based market model (PRICE_IMPACT).
 * Prices must be HARD to move: a small trade barely budges them, only large
 * cumulative volume swings them, and cheap goods don't move per unit. The
 * mean-reversion (`priceTowardBase`) is unchanged and covered elsewhere.
 */
describe("price stickiness — volume-based, gentle market impact", () => {
  it("barely moves a 1000-credit price on a ~10-unit trade (< ~2%)", () => {
    expect(priceAfterSale(1000, 10)).toBeGreaterThanOrEqual(980);
    expect(priceAfterPurchase(1000, 10)).toBeLessThanOrEqual(1020);
  });

  it("needs hundreds of units for a substantial swing", () => {
    expect(priceAfterSale(1000, 500)).toBeLessThan(priceAfterSale(1000, 10));
    expect(priceAfterSale(1000, 500)).toBeLessThan(800);
    expect(priceAfterPurchase(1000, 500)).toBeGreaterThan(priceAfterPurchase(1000, 10));
  });

  it("rounds a single unit of a cheap good to no change", () => {
    expect(priceAfterSale(10, 1)).toBe(10);
    expect(priceAfterPurchase(10, 1)).toBe(10);
  });

  it("respects the floor even under absurd sell volume", () => {
    expect(priceAfterSale(2, 1_000_000)).toBeGreaterThanOrEqual(PRICE_FLOOR);
    expect(priceAfterSale(1000, 1_000_000)).toBeGreaterThanOrEqual(PRICE_FLOOR);
  });

  it("leaves the price unchanged when qty <= 0", () => {
    expect(priceAfterSale(1000, 0)).toBe(1000);
    expect(priceAfterSale(1000, -5)).toBe(1000);
    expect(priceAfterPurchase(1000, 0)).toBe(1000);
    expect(priceAfterPurchase(1000, -5)).toBe(1000);
  });

  it("sale lowers and purchase raises a meaningfully-sized trade", () => {
    expect(priceAfterSale(1000, 200)).toBeLessThan(1000);
    expect(priceAfterPurchase(1000, 200)).toBeGreaterThan(1000);
  });
});
