import { describe, it, expect } from "vitest";
import {
  effectiveHull, conditionAfterDefeat, conditionAfterRepair,
  repairCreditsFor, repairMetalFor, pointsAffordable,
  MAX_SHIP_CONDITION, DISABLED_CONDITION, MIN_HULL_FRACTION,
} from "@/lib/game/rules";

describe("effectiveHull — combat hull scales with condition", () => {
  it("is full at full condition and lower when damaged", () => {
    expect(effectiveHull(200, MAX_SHIP_CONDITION)).toBe(200);
    expect(effectiveHull(200, 50)).toBeLessThan(200);
    expect(effectiveHull(200, 50)).toBeGreaterThan(0);
  });
  it("is monotonic non-decreasing in condition", () => {
    let prev = -1;
    for (const c of [0, 15, 30, 60, 100]) {
      const h = effectiveHull(200, c);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });
  it("floors at MIN_HULL_FRACTION so a disabled ship still fights feebly", () => {
    expect(MIN_HULL_FRACTION).toBeGreaterThan(0);
    expect(effectiveHull(200, 0)).toBeGreaterThanOrEqual(Math.round(200 * MIN_HULL_FRACTION));
    expect(effectiveHull(200, 0)).toBeGreaterThan(0);
  });
});

describe("conditionAfterDefeat — towed in disabled", () => {
  it("drops to the disabled floor (low but flyable, > 0)", () => {
    expect(DISABLED_CONDITION).toBeGreaterThan(0);
    expect(DISABLED_CONDITION).toBeLessThan(MAX_SHIP_CONDITION);
    expect(conditionAfterDefeat(100)).toBe(DISABLED_CONDITION);
  });
  it("never raises an already-lower condition", () => {
    expect(conditionAfterDefeat(5)).toBeLessThanOrEqual(DISABLED_CONDITION);
  });
});

describe("repair cost + partial application", () => {
  it("cost scales with missing condition and is positive", () => {
    const missing = MAX_SHIP_CONDITION - DISABLED_CONDITION;
    expect(repairCreditsFor(missing)).toBeGreaterThan(0);
    expect(repairMetalFor(missing)).toBeGreaterThan(0);
    expect(repairCreditsFor(missing)).toBeGreaterThan(repairCreditsFor(Math.floor(missing / 2)));
  });
  it("zero missing ⇒ zero cost", () => {
    expect(repairCreditsFor(0)).toBe(0);
    expect(repairMetalFor(0)).toBe(0);
  });
  it("pointsAffordable + conditionAfterRepair: partial repair, capped at MAX, never overshoot", () => {
    // afford only some points → partial
    const perPoint = repairCreditsFor(1) || 1;
    const have = perPoint * 10;
    expect(pointsAffordable(have, perPoint)).toBe(10);
    expect(conditionAfterRepair(DISABLED_CONDITION, 10)).toBe(DISABLED_CONDITION + 10);
    // capped at MAX, never beyond
    expect(conditionAfterRepair(95, 999)).toBe(MAX_SHIP_CONDITION);
    // zero funds → no points → unchanged (stays flyable, go mine)
    expect(pointsAffordable(0, perPoint)).toBe(0);
    expect(conditionAfterRepair(DISABLED_CONDITION, 0)).toBe(DISABLED_CONDITION);
    // never negative / never below current
    expect(conditionAfterRepair(40, -5)).toBeGreaterThanOrEqual(40);
  });
});
