import { describe, it, expect } from "vitest";
import {
  warpFuelCost,
  effectiveAbundance,
  miningYield,
  sellValue,
  priceAfterSale,
} from "@/lib/game/rules";
import { parseCommand } from "@/lib/game/parse";

// P2 split the single `fuelCost` into `warpFuelCost` (distance-only, for `warp`)
// and `regularFuelCost` (takeoff + interplanetary, for `land`). This suite
// tracks the warp side — same distance-only contract the original `fuelCost`
// had; the orbital/regular-fuel contract lives in `fuel-orbital.test.ts`.
describe("warpFuelCost (AC#3, AC#4)", () => {
  it("is zero at distance 0 and a positive integer beyond", () => {
    expect(warpFuelCost(0)).toBe(0);
    expect(warpFuelCost(5)).toBeGreaterThan(0);
    expect(Number.isInteger(warpFuelCost(5))).toBe(true);
    expect(Number.isInteger(warpFuelCost(13))).toBe(true);
  });

  it("is non-decreasing in distance", () => {
    expect(warpFuelCost(10)).toBeGreaterThanOrEqual(warpFuelCost(5));
    expect(warpFuelCost(50)).toBeGreaterThanOrEqual(warpFuelCost(10));
  });
});

describe("effectiveAbundance (AC#2, AC#6)", () => {
  it("equals base when nothing has been depleted", () => {
    expect(effectiveAbundance(0.8, 0)).toBeCloseTo(0.8, 10);
  });

  it("never exceeds base and never goes negative", () => {
    for (const depleted of [0, 0.1, 0.5, 1, 5, 1000]) {
      const v = effectiveAbundance(0.8, depleted);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0.8);
    }
  });

  it("is non-increasing in depletion and floors at 0 when fully mined out", () => {
    expect(effectiveAbundance(0.8, 0.5)).toBeLessThanOrEqual(
      effectiveAbundance(0.8, 0.1),
    );
    expect(effectiveAbundance(0.8, 100000)).toBe(0);
  });
});

describe("miningYield (AC#6)", () => {
  it("yields nothing without abundance or cargo space", () => {
    expect(miningYield({ abundance: 0, cargoSpace: 10 })).toBe(0);
    expect(miningYield({ abundance: 0.5, cargoSpace: 0 })).toBe(0);
  });

  it("yields a positive integer bounded by cargo space", () => {
    const y = miningYield({ abundance: 0.9, cargoSpace: 10 });
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThanOrEqual(10);
    expect(Number.isInteger(y)).toBe(true);
    expect(miningYield({ abundance: 1, cargoSpace: 3 })).toBeLessThanOrEqual(3);
  });

  it("does not decrease as abundance rises (same cargo space)", () => {
    expect(miningYield({ abundance: 0.9, cargoSpace: 100 })).toBeGreaterThanOrEqual(
      miningYield({ abundance: 0.2, cargoSpace: 100 }),
    );
  });
});

describe("sellValue (AC#8)", () => {
  it("is price times quantity, non-negative", () => {
    expect(sellValue(10, 5)).toBe(50);
    expect(sellValue(0, 5)).toBe(0);
    expect(sellValue(100, 0)).toBe(0);
    expect(sellValue(160, 3)).toBe(480);
  });
});

describe("priceAfterSale — shared-economy drift (AC#8)", () => {
  it("is unchanged when nothing is sold", () => {
    expect(priceAfterSale(100, 0)).toBe(100);
  });

  it("is monotonically non-increasing in quantity sold", () => {
    expect(priceAfterSale(100, 100)).toBeLessThanOrEqual(priceAfterSale(100, 10));
    expect(priceAfterSale(100, 10)).toBeLessThanOrEqual(priceAfterSale(100, 1));
  });

  it("barely moves on a small trade but clearly drops under heavy volume", () => {
    // ~10 units shaves well under ~2% off a 1000-credit price...
    expect(priceAfterSale(1000, 10)).toBeGreaterThanOrEqual(980);
    // ...while hundreds of units cut it substantially.
    expect(priceAfterSale(1000, 500)).toBeLessThan(priceAfterSale(1000, 10));
    expect(priceAfterSale(1000, 500)).toBeLessThan(800);
  });

  it("never drops below the floor of 1 and never goes negative", () => {
    expect(priceAfterSale(1, 1_000_000)).toBeGreaterThanOrEqual(1);
    expect(priceAfterSale(100, 1_000_000)).toBeGreaterThanOrEqual(1);
    expect(priceAfterSale(5, 999)).toBeGreaterThanOrEqual(1);
  });
});

describe("parseCommand (AC#11)", () => {
  it("splits a verb and its args, lowercasing the verb", () => {
    expect(parseCommand("scan")).toEqual({ verb: "scan", args: [] });
    expect(parseCommand("SCAN").verb).toBe("scan");
    expect(parseCommand("mine iron")).toEqual({ verb: "mine", args: ["iron"] });
  });

  it("trims and collapses whitespace", () => {
    expect(parseCommand("  warp 2 5 ")).toEqual({
      verb: "warp",
      args: ["2", "5"],
    });
    expect(parseCommand("warp   2    5")).toEqual({
      verb: "warp",
      args: ["2", "5"],
    });
  });

  it("handles the empty input and multi-word args", () => {
    expect(parseCommand("")).toEqual({ verb: "", args: [] });
    expect(parseCommand("   ")).toEqual({ verb: "", args: [] });
    expect(parseCommand("sell all")).toEqual({ verb: "sell", args: ["all"] });
  });
});
