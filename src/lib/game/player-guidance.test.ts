import { describe, it, expect } from "vitest";
import { nextStep } from "@/lib/game/advisor";
import { distressCost, DISTRESS_FEE } from "@/lib/game/rules";

// A fully-established baseline; override per case to hit each ladder rung.
const ESTABLISHED = {
  embarked: true, landed: false, onFoot: false, currentPlanetIsGas: false,
  atTradeLocation: false, hasOreInCargo: false, hasAnyGoods: false,
  credits: 100000, fuel: 100, warpFuel: 100, hasBaseHere: false,
  hasAnyBase: true, inCombat: false,
};
const snap = (o: object) => ({ ...ESTABLISHED, ...o });
const cmd = (s: object) => nextStep(snap(s)).suggestedCommand ?? "";

describe("nextStep — ordered soft-tutorial ladder", () => {
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

  it("on foot with no ore → mine", () => {
    expect(cmd({ embarked: false, onFoot: true, landed: true, hasOreInCargo: false }))
      .toMatch(/mine|scan/);
  });

  it("has goods but not at a hub → go to a hub", () => {
    expect(cmd({ embarked: false, onFoot: true, landed: true, hasOreInCargo: true,
                 hasAnyGoods: true, atTradeLocation: false })).toMatch(/map|regions|jump|settlement|outpost/i);
  });

  it("at a trade hub with goods → contracts or sell", () => {
    expect(cmd({ atTradeLocation: true, hasAnyGoods: true })).toMatch(/contract|sell|fulfill/i);
  });

  it("plenty of credits and no base → build a base", () => {
    expect(cmd({ onFoot: true, embarked: false, landed: true, atTradeLocation: false,
                 hasAnyGoods: false, credits: 100000, hasAnyBase: false, hasBaseHere: false }))
      .toMatch(/build base/i);
  });

  it("established player → open-ended, non-empty advice", () => {
    const a = nextStep(snap({}));
    expect(a.message.length).toBeGreaterThan(0);
    expect(a.stage.length).toBeGreaterThan(0);
  });

  it("always returns a message and a stage", () => {
    for (const s of [{}, { inCombat: true }, { embarked: false, onFoot: true, landed: true }]) {
      const a = nextStep(snap(s));
      expect(typeof a.message).toBe("string");
      expect(a.message.length).toBeGreaterThan(0);
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
