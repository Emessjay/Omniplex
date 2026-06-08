import { describe, it, expect } from "vitest";
import {
  excavatorYield,
  baseCapacity,
  SILO_CAPACITY,
  EXCAVATOR_RATE_PER_MS,
} from "@/lib/game/rules";

const HOUR = 3_600_000;

describe("constants", () => {
  it("silo capacity positive; excavator rate a small positive number", () => {
    expect(SILO_CAPACITY).toBeGreaterThan(0);
    expect(EXCAVATOR_RATE_PER_MS).toBeGreaterThan(0);
    expect(EXCAVATOR_RATE_PER_MS).toBeLessThan(1); // "slowly"
  });
});

describe("baseCapacity", () => {
  it("scales linearly with silo count", () => {
    expect(baseCapacity(0)).toBe(0);
    expect(baseCapacity(1)).toBe(SILO_CAPACITY);
    expect(baseCapacity(3)).toBe(SILO_CAPACITY * 3);
  });
});

describe("excavatorYield", () => {
  it("is zero without abundance or elapsed time", () => {
    expect(excavatorYield(0, HOUR)).toBe(0);
    expect(excavatorYield(0.8, 0)).toBe(0);
    expect(excavatorYield(0.8, -5)).toBe(0);
  });

  it("is a non-negative integer that grows with time and abundance", () => {
    const y = excavatorYield(0.9, 10 * HOUR);
    expect(Number.isInteger(y)).toBe(true);
    expect(y).toBeGreaterThan(0);
    expect(excavatorYield(0.9, 20 * HOUR)).toBeGreaterThanOrEqual(
      excavatorYield(0.9, 10 * HOUR),
    );
    expect(excavatorYield(0.9, 10 * HOUR)).toBeGreaterThanOrEqual(
      excavatorYield(0.3, 10 * HOUR),
    );
  });
});
