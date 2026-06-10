import { describe, it, expect } from "vitest";
import { nextStep } from "@/lib/game/advisor";
import { distressCost, DISTRESS_FEE } from "@/lib/game/rules";

// A neutral on-foot baseline (brand-new player); override per case to hit each
// MILESTONE rung. The reworked ladder keys off STABLE state (base ownership,
// ship, credits, base-minerals on hand), not transient cargo — see
// guide-advisor-fix.test.ts for the anti-flip-flop contract.
const BASE = {
  embarked: false, landed: true, onFoot: true, currentPlanetIsGas: false,
  atTradeLocation: false, inCombat: false,
  credits: 1000, hasAnyBase: false, hasBaseHere: false,
  hasOreInCargo: false, hasAnyGoods: false, hasBaseMinerals: false,
  shipIsStarter: true, fuel: 100, warpFuel: 100,
};
const snap = (o: object) => ({ ...BASE, ...o });
const cmd = (s: object) => nextStep(snap(s)).suggestedCommand ?? "";
const stage = (s: object) => nextStep(snap(s)).stage;

describe("nextStep — milestone soft-tutorial ladder", () => {
  it("combat overrides everything", () => {
    expect(cmd({ inCombat: true })).toMatch(/attack|flee/);
  });

  it("orbiting a gas giant → go orbit a rocky world", () => {
    expect(cmd({ embarked: true, landed: false, currentPlanetIsGas: true })).toMatch(/orbit/);
  });

  it("orbiting a rocky world → land", () => {
    expect(cmd({ embarked: true, landed: false, currentPlanetIsGas: false })).toMatch(/land/);
  });

  it("landed aboard → disembark", () => {
    expect(cmd({ embarked: true, landed: true })).toMatch(/disembark/);
  });

  it("no base + missing base minerals → mine toward a base (never sell)", () => {
    expect(cmd({ hasAnyBase: false, hasBaseMinerals: false })).toMatch(/mine|scan/);
    expect(cmd({ hasAnyBase: false, hasBaseMinerals: false })).not.toMatch(/^sell\b/);
  });

  it("no base but have the base minerals + the fee → build a base", () => {
    expect(cmd({ hasAnyBase: false, hasBaseMinerals: true, credits: 100000 }))
      .toMatch(/build base/i);
  });

  it("has a base, starter ship, modest credits → grow the base", () => {
    expect(stage({ hasAnyBase: true, hasBaseHere: true, shipIsStarter: true, credits: 1000 }))
      .toBe("grow-base");
  });

  it("based + flush + still on the starter → trade up the ship", () => {
    expect(cmd({ hasAnyBase: true, shipIsStarter: true, credits: 100000 }))
      .toMatch(/shipyard|produce/i);
  });

  it("well-established (bigger ship) → open-ended exploration", () => {
    const a = nextStep(snap({ hasAnyBase: true, shipIsStarter: false, credits: 500000 }));
    expect(a.stage).toBe("explore");
    expect(a.message.length).toBeGreaterThan(0);
  });

  it("advice toward a milestone is STABLE regardless of carried ore", () => {
    const withOre = nextStep(snap({ hasAnyBase: false, hasBaseMinerals: false, hasOreInCargo: true, hasAnyGoods: true }));
    const without = nextStep(snap({ hasAnyBase: false, hasBaseMinerals: false }));
    expect(withOre.stage).toBe(without.stage);
    expect(withOre.suggestedCommand ?? "").not.toMatch(/^sell\b/);
  });

  it("always returns a message and a stage", () => {
    for (const s of [{}, { inCombat: true }, { hasAnyBase: true }, { credits: 0 }]) {
      const a = nextStep(snap(s));
      expect(typeof a.message).toBe("string");
      expect(a.message.length).toBeGreaterThan(0);
      expect(a.stage.length).toBeGreaterThan(0);
    }
  });
});

describe("distressCost — always affordable, expensive, non-negative", () => {
  it("is min(credits, fee): never exceeds your credits, never negative", () => {
    expect(DISTRESS_FEE).toBeGreaterThan(0);
    expect(distressCost(0)).toBe(0);
    expect(distressCost(DISTRESS_FEE * 10)).toBe(DISTRESS_FEE);
    expect(distressCost(100)).toBe(100);                 // broke-ish: takes what you have
    for (const c of [0, 1, 4999, 5000, 999999]) {
      const cost = distressCost(c);
      expect(cost).toBeLessThanOrEqual(c);               // never drives credits negative
      expect(cost).toBeGreaterThanOrEqual(0);
      expect(cost).toBeLessThanOrEqual(DISTRESS_FEE);    // capped at the fee
    }
  });
});
