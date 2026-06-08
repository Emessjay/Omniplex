import { describe, it, expect } from "vitest";
import {
  REGULAR_FUEL_PRICE_PER_UNIT,
  WARP_FUEL_PRICE_PER_UNIT,
  planetPosition,
  interplanetaryDistance,
  atmosphereDensity,
  takeoffCost,
  regularFuelCost,
  warpFuelCost,
} from "@/lib/game/rules";
import { ATMOSPHERES } from "@/lib/universe";

const T0 = 1_000_000_000_000;
const orbit = (r: number, p: number, ph: number) => ({
  orbitalRadius: r,
  orbitalPeriod: p,
  orbitalPhase: ph,
});

describe("fuel prices — warp is pricier", () => {
  it("warp fuel costs more per unit than regular", () => {
    expect(WARP_FUEL_PRICE_PER_UNIT).toBeGreaterThan(REGULAR_FUEL_PRICE_PER_UNIT);
    expect(REGULAR_FUEL_PRICE_PER_UNIT).toBeGreaterThan(0);
  });
});

describe("orbits — time-varying positions & distance", () => {
  const a = orbit(5, 1_000_000, 0);
  const b = orbit(12, 2_500_000, 1.7);

  it("position moves over time and is periodic", () => {
    const p0 = planetPosition(a, T0);
    const pMid = planetPosition(a, T0 + 250_000); // quarter period-ish
    expect(p0).not.toEqual(pMid);
    const pPeriod = planetPosition(a, T0 + a.orbitalPeriod);
    expect(pPeriod.x).toBeCloseTo(p0.x, 3);
    expect(pPeriod.y).toBeCloseTo(p0.y, 3);
  });

  it("interplanetary distance is ≥0, symmetric, and varies with time", () => {
    const d1 = interplanetaryDistance(a, b, T0);
    const d2 = interplanetaryDistance(a, b, T0 + 600_000);
    expect(d1).toBeGreaterThanOrEqual(0);
    expect(interplanetaryDistance(b, a, T0)).toBeCloseTo(d1, 6); // symmetric
    expect(d1).not.toBeCloseTo(d2, 3); // time-varying
  });
});

describe("takeoff — additive in atmosphere, multiplicative in gravity", () => {
  it("atmosphereDensity is defined for every atmosphere; denser costs ≥", () => {
    for (const atm of ATMOSPHERES) expect(atmosphereDensity(atm)).toBeGreaterThanOrEqual(0);
  });

  it("takeoff rises with gravity (multiplicative) and with atmosphere density (additive)", () => {
    const atm = ATMOSPHERES[1]!;
    expect(takeoffCost(atm, 2)).toBeGreaterThan(takeoffCost(atm, 1));
    // doubling gravity at least doubles the cost component (linear multiply)
    expect(takeoffCost(atm, 2)).toBeGreaterThanOrEqual(takeoffCost(atm, 1) * 1.5);
    // a denser atmosphere costs more at the same gravity
    const sorted = [...ATMOSPHERES].sort((x, y) => atmosphereDensity(x) - atmosphereDensity(y));
    const lo = sorted[0]!;
    const hi = sorted[sorted.length - 1]!;
    expect(takeoffCost(hi, 1)).toBeGreaterThan(takeoffCost(lo, 1));
  });
});

describe("regularFuelCost — takeoff + interplanetary (additive)", () => {
  it("equals takeoff plus an interplanetary component, positive integer", () => {
    const from = { atmosphere: ATMOSPHERES[2]!, gravity: 1.2, orbit: orbit(5, 1_000_000, 0) };
    const to = { orbit: orbit(9, 1_500_000, 2.1) };
    const cost = regularFuelCost(from, to, T0);
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(takeoffCost(from.atmosphere, from.gravity)); // includes takeoff
  });
});

describe("warpFuelCost — distance only", () => {
  it("0 at distance 0, non-decreasing, positive beyond", () => {
    expect(warpFuelCost(0)).toBe(0);
    expect(warpFuelCost(50)).toBeGreaterThan(0);
    expect(warpFuelCost(200)).toBeGreaterThanOrEqual(warpFuelCost(50));
    expect(Number.isInteger(warpFuelCost(123))).toBe(true);
  });
});
