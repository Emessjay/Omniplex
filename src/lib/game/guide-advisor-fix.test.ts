import { describe, it, expect } from "vitest";
import { nextStep } from "@/lib/game/advisor";

// A baseline on-foot snapshot; override per case. Extend with whatever stable
// fields the reworked GuideSnapshot needs — these are the expected ones.
const BASE = {
  embarked: false, landed: true, onFoot: true, currentPlanetIsGas: false,
  atTradeLocation: false, inCombat: false,
  credits: 1000, hasAnyBase: false, hasBaseHere: false,
  hasOreInCargo: false, hasAnyGoods: false, hasBaseMinerals: false,
  shipIsStarter: true,
};
const snap = (o: object) => ({ ...BASE, ...o });
const advise = (o: object) => nextStep(snap(o));
const cmd = (o: object) => advise(o).suggestedCommand ?? "";
const msg = (o: object) => advise(o).message;

describe("no mine↔sell flip-flop", () => {
  it("a player toward their first base is NOT bounced between mine and sell", () => {
    // same milestone (no base), with vs without ore in cargo → advice must be
    // toward the SAME forward goal (base), never 'sell' one moment and 'mine' the next.
    const withOre = advise({ hasOreInCargo: true, hasAnyGoods: true, hasBaseMinerals: false });
    const without = advise({ hasOreInCargo: false, hasAnyGoods: false, hasBaseMinerals: false });
    // neither should be the bare "sell" rung that ping-pongs with mining
    expect(withOre.suggestedCommand ?? "").not.toMatch(/^sell\b/);
    // both point at the base milestone (mine base mats / build base), i.e. same stage
    expect(withOre.stage).toBe(without.stage);
  });

  it("a brand-new player is told to MINE base materials + build a base, not sell", () => {
    const a = advise({ onFoot: true, hasBaseMinerals: false, hasAnyBase: false, credits: 1000 });
    expect(cmd({ onFoot: true, hasBaseMinerals: false, hasAnyBase: false, credits: 1000 }))
      .toMatch(/mine|scan|build base/i);
    expect(a.suggestedCommand ?? "").not.toMatch(/^sell\b/);
  });
});

describe("advances through milestones (distinct forward rungs)", () => {
  it("yields different stages as the player progresses", () => {
    const newPlayer = advise({ hasAnyBase: false, hasBaseMinerals: false });
    const readyToBuild = advise({ hasAnyBase: false, hasBaseMinerals: true, credits: 5000 });
    const hasBase = advise({ hasAnyBase: true, hasBaseHere: true });
    const established = advise({ hasAnyBase: true, hasBaseHere: true, shipIsStarter: false, credits: 500000 });
    const stages = [newPlayer.stage, readyToBuild.stage, hasBase.stage, established.stage];
    expect(new Set(stages).size).toBeGreaterThanOrEqual(3);     // it actually advances
    expect(cmd({ hasAnyBase: false, hasBaseMinerals: true, credits: 5000 })).toMatch(/build base/i);
    expect(hasBase.message.length).toBeGreaterThan(0);
  });

  it("combat and on-foot-prereq rungs still fire first when applicable", () => {
    expect(cmd({ inCombat: true })).toMatch(/attack|flee/i);
    expect(cmd({ embarked: true, landed: false, currentPlanetIsGas: false })).toMatch(/land/i);
    expect(cmd({ embarked: true, landed: true })).toMatch(/disembark/i);
  });

  it("always returns a non-empty message + stage (total)", () => {
    for (const o of [{}, { inCombat: true }, { hasAnyBase: true }, { credits: 0 }]) {
      const a = advise(o);
      expect(typeof a.message).toBe("string");
      expect(a.message.length).toBeGreaterThan(0);
      expect(a.stage.length).toBeGreaterThan(0);
    }
  });
});
