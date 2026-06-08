import { describe, it, expect } from "vitest";
import {
  regeneratedDepletion,
  priceTowardBase,
  buyUnitCost,
  priceAfterPurchase,
  REGEN_PER_MS,
  PRICE_REVERT_PER_MS,
  BUY_MARKUP,
  PRICE_FLOOR,
} from "@/lib/game/rules";

const HOUR = 3_600_000;

describe("tuning constants exist and are sane", () => {
  it("regen + revert are small positive rates; markup is 1.5", () => {
    expect(REGEN_PER_MS).toBeGreaterThan(0);
    expect(REGEN_PER_MS).toBeLessThan(1); // "very slow": << 1 abundance/ms
    expect(PRICE_REVERT_PER_MS).toBeGreaterThan(0);
    expect(BUY_MARKUP).toBeCloseTo(1.5, 5);
  });
});

describe("regeneratedDepletion (ore regen)", () => {
  it("is unchanged at elapsed 0", () => {
    expect(regeneratedDepletion(0.6, 0, 1e-7)).toBeCloseTo(0.6, 10);
  });

  it("never goes negative — full recovery clamps to 0", () => {
    expect(regeneratedDepletion(0.6, 1e12, 1e-7)).toBe(0);
  });

  it("never exceeds the original depletion", () => {
    for (const t of [0, HOUR, 5 * HOUR, 24 * HOUR]) {
      const v = regeneratedDepletion(0.5, t, 1e-7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0.5);
    }
  });

  it("is monotonically non-increasing in elapsed time", () => {
    const a = regeneratedDepletion(0.8, 1 * HOUR, 1e-7);
    const b = regeneratedDepletion(0.8, 6 * HOUR, 1e-7);
    expect(b).toBeLessThanOrEqual(a);
  });
});

describe("priceTowardBase (mean-reversion)", () => {
  it("is unchanged at elapsed 0", () => {
    expect(priceTowardBase(40, 100, 0, 0.01)).toBe(40);
  });

  it("rises toward base but never overshoots above it", () => {
    expect(priceTowardBase(40, 100, 10 * HOUR, 1e-3)).toBeLessThanOrEqual(100);
    expect(priceTowardBase(40, 100, 10 * HOUR, 1e-3)).toBeGreaterThan(40);
    // Enormous elapsed lands exactly on base, not past it.
    expect(priceTowardBase(40, 100, 1e15, 1e-3)).toBe(100);
  });

  it("falls toward base but never undershoots below it", () => {
    expect(priceTowardBase(500, 100, 10 * HOUR, 1e-3)).toBeGreaterThanOrEqual(100);
    expect(priceTowardBase(500, 100, 1e15, 1e-3)).toBe(100);
  });

  it("stays at base when already there", () => {
    expect(priceTowardBase(100, 100, 9 * HOUR, 1e-3)).toBe(100);
  });

  it("never drops below the price floor", () => {
    expect(priceTowardBase(2, 1, 1e15, 1e-3)).toBeGreaterThanOrEqual(PRICE_FLOOR);
  });
});

describe("buyUnitCost — 1.5x markup", () => {
  it("is ceil(price * 1.5) and always >= price", () => {
    expect(buyUnitCost(100)).toBe(150);
    expect(buyUnitCost(5)).toBe(8); // ceil(7.5)
    expect(buyUnitCost(1)).toBeGreaterThanOrEqual(1);
    expect(buyUnitCost(160)).toBe(240);
  });
});

describe("priceAfterPurchase — buying drives price up", () => {
  it("is unchanged when nothing is bought", () => {
    expect(priceAfterPurchase(100, 0)).toBe(100);
  });

  it("is monotonically non-decreasing in quantity bought", () => {
    expect(priceAfterPurchase(100, 50)).toBeGreaterThanOrEqual(priceAfterPurchase(100, 5));
    expect(priceAfterPurchase(100, 5)).toBeGreaterThanOrEqual(priceAfterPurchase(100, 1));
  });

  it("barely moves on a small trade but clearly rises under heavy volume", () => {
    // ~10 units lifts a 1000-credit price by under ~2%...
    expect(priceAfterPurchase(1000, 10)).toBeLessThanOrEqual(1020);
    // ...while hundreds of units push it well up.
    expect(priceAfterPurchase(1000, 500)).toBeGreaterThan(priceAfterPurchase(1000, 10));
    expect(priceAfterPurchase(1000, 500)).toBeGreaterThan(1500);
  });

  it("rounds a single unit of a cheap good to no change", () => {
    expect(priceAfterPurchase(10, 1)).toBe(10);
  });
});
