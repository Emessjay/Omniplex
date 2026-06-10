import { describe, it, expect } from "vitest";
import {
  FACTIONS, FACTION_IDS, getFaction, rivalOf,
  rivalRepPenalty, repPriceDiscount, RIVAL_REP_PENALTY_FRACTION,
  MAX_RANK_TIER,
} from "@/lib/game/factions";

describe("rivalries — symmetric, total, two opposed pairs", () => {
  it("every faction has exactly one rival, never itself, symmetric", () => {
    for (const f of FACTIONS) {
      const r = rivalOf(f.id);
      expect(FACTION_IDS).toContain(r);
      expect(r).not.toBe(f.id);
      expect(rivalOf(r)).toBe(f.id);          // symmetric
    }
  });

  it("pairs the 4 factions into 2 disjoint rivalry pairs", () => {
    const pairs = new Set(FACTIONS.map((f) => [f.id, rivalOf(f.id)].sort().join("|")));
    expect(pairs.size).toBe(FACTIONS.length / 2);
  });
});

describe("standing trade-off (rivalRepPenalty)", () => {
  it("is floor(gain × fraction): >=0, <= gain, monotonic", () => {
    expect(RIVAL_REP_PENALTY_FRACTION).toBeGreaterThan(0);
    expect(RIVAL_REP_PENALTY_FRACTION).toBeLessThanOrEqual(1);
    expect(rivalRepPenalty(0)).toBe(0);
    let prev = 0;
    for (const g of [1, 5, 10, 50, 100, 1000]) {
      const p = rivalRepPenalty(g);
      expect(p).toBe(Math.floor(g * RIVAL_REP_PENALTY_FRACTION));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(g);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe("rank trade perk (repPriceDiscount)", () => {
  it("is 0 at tier 0, monotonic non-decreasing, bounded below 1", () => {
    expect(repPriceDiscount(0)).toBe(0);
    let prev = -1;
    for (let t = 0; t <= MAX_RANK_TIER; t++) {
      const d = repPriceDiscount(t);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);              // never free/negative prices
      expect(d).toBeGreaterThanOrEqual(prev); // monotonic
      prev = d;
    }
    // a higher rank discounts strictly more than tier 0 (the perk is real)
    expect(repPriceDiscount(MAX_RANK_TIER)).toBeGreaterThan(repPriceDiscount(0));
  });
});
