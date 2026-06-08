import { describe, it, expect } from "vitest";
import { BASE_BUILD_COST, canAffordBase } from "@/lib/game/bases";

describe("base build cost", () => {
  it("declares a non-empty, positive cost", () => {
    const entries = Object.entries(BASE_BUILD_COST);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, qty] of entries) expect(qty as number).toBeGreaterThan(0);
  });

  it("canAffordBase checks credits + every mineral in the cost", () => {
    // Construct a "have" that exactly meets the cost.
    const have: Record<string, number> = {};
    for (const [k, v] of Object.entries(BASE_BUILD_COST)) have[k] = v as number;
    expect(canAffordBase(have, BASE_BUILD_COST)).toBe(true);
    // Remove one unit of the first ingredient -> can't afford.
    const firstKey = Object.keys(BASE_BUILD_COST)[0]!;
    expect(canAffordBase({ ...have, [firstKey]: have[firstKey]! - 1 }, BASE_BUILD_COST)).toBe(false);
  });
});
