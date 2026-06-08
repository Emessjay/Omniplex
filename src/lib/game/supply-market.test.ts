import { describe, it, expect } from "vitest";
import {
  supplyTowardBaseline,
  UPGRADE_SUPPLY_BASELINE,
  PART_SUPPLY_BASELINE,
  SUPPLY_REVERT_PER_MS,
} from "@/lib/game/rules";

const HOUR = 3_600_000;

describe("supply baselines & rate", () => {
  it("baselines positive; revert rate a small positive number", () => {
    expect(UPGRADE_SUPPLY_BASELINE).toBeGreaterThan(0);
    expect(PART_SUPPLY_BASELINE).toBeGreaterThan(0);
    expect(SUPPLY_REVERT_PER_MS).toBeGreaterThan(0);
    expect(SUPPLY_REVERT_PER_MS).toBeLessThan(1); // gradual
  });
});

describe("supplyTowardBaseline — reverts both directions, never overshoots", () => {
  it("is unchanged at elapsed 0", () => {
    expect(supplyTowardBaseline(0, 5, 0, 1e-4)).toBe(0);
    expect(supplyTowardBaseline(9, 5, 0, 1e-4)).toBe(9);
  });

  it("a depleted system restocks toward baseline (rises, capped at baseline)", () => {
    const a = supplyTowardBaseline(0, 5, 2 * HOUR, 1e-4);
    const b = supplyTowardBaseline(0, 5, 10 * HOUR, 1e-4);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a); // more time, more restock
    expect(b).toBeLessThanOrEqual(5); // never overshoots the baseline
    expect(supplyTowardBaseline(0, 5, 1e15, 1e-4)).toBe(5); // eventually exactly baseline
  });

  it("an over-supplied system drains toward baseline (falls, floored at baseline)", () => {
    expect(supplyTowardBaseline(20, 5, 10 * HOUR, 1e-4)).toBeLessThanOrEqual(20);
    expect(supplyTowardBaseline(20, 5, 10 * HOUR, 1e-4)).toBeGreaterThanOrEqual(5);
    expect(supplyTowardBaseline(20, 5, 1e15, 1e-4)).toBe(5);
  });

  it("stays at baseline when already there; integer & non-negative", () => {
    expect(supplyTowardBaseline(5, 5, 9 * HOUR, 1e-4)).toBe(5);
    const v = supplyTowardBaseline(2, 7, 3 * HOUR, 1e-4);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  });
});
