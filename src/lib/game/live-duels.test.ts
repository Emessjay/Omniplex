import { describe, it, expect } from "vitest";
import { combatLogPenalty, duelTurnExpired } from "@/lib/game/rules";

describe("combatLogPenalty — disconnecting mid-duel stings", () => {
  it("is a significant, positive, bounded credit hit", () => {
    const p = combatLogPenalty(100_000);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(100_000);   // never more than you have
    expect(Number.isInteger(p)).toBe(true);
    // "significant" — a meaningful bite, not a rounding error
    expect(p).toBeGreaterThanOrEqual(1000);
  });
  it("never goes negative and never exceeds available credits", () => {
    expect(combatLogPenalty(0)).toBe(0);
    expect(combatLogPenalty(50)).toBeLessThanOrEqual(50);
    expect(combatLogPenalty(50)).toBeGreaterThanOrEqual(0);
  });
  it("is monotonic non-decreasing in credits (the rich pay more)", () => {
    expect(combatLogPenalty(1_000_000)).toBeGreaterThanOrEqual(combatLogPenalty(10_000));
  });
});

describe("duelTurnExpired — slow-turn detection", () => {
  it("true once the deadline has passed, false before / at it", () => {
    const now = 1_700_000_000_000;
    expect(duelTurnExpired(now - 1, now)).toBe(true);     // deadline in the past
    expect(duelTurnExpired(now + 10_000, now)).toBe(false); // deadline in the future
  });
  it("a null/absent deadline is not expired (no timer yet)", () => {
    expect(duelTurnExpired(null as any, 1_700_000_000_000)).toBe(false);
  });
});
