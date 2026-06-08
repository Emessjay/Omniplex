import { describe, it, expect } from "vitest";
import { biofuelYield, REGULAR_FUEL_PRICE_PER_UNIT } from "@/lib/game/rules";

describe("biofuel — lossy bio→fuel conversion", () => {
  it("produces a non-negative integer amount of fuel", () => {
    expect(Number.isInteger(biofuelYield(60, 3))).toBe(true);
    expect(biofuelYield(60, 3)).toBeGreaterThanOrEqual(0);
    expect(biofuelYield(0, 5)).toBe(0);
    expect(biofuelYield(60, 0)).toBe(0);
  });

  it("LOSS INVARIANT: fuel credit-value < material credit-value consumed", () => {
    for (const [val, qty] of [[60, 3], [20, 10], [500, 1], [12, 25]] as const) {
      const fuel = biofuelYield(val, qty);
      const fuelValue = fuel * REGULAR_FUEL_PRICE_PER_UNIT;
      const materialValue = val * qty;
      expect(fuelValue).toBeLessThan(materialValue); // always a value loss
    }
  });

  it("more/ more-valuable material yields at least as much fuel (monotonic)", () => {
    expect(biofuelYield(60, 10)).toBeGreaterThanOrEqual(biofuelYield(60, 3));
    expect(biofuelYield(120, 5)).toBeGreaterThanOrEqual(biofuelYield(60, 5));
  });
});
