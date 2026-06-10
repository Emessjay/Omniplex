import { describe, it, expect } from "vitest";
import {
  CARTO_RANKS, cartographyRank, MAX_CARTO_TIER,
} from "@/lib/game/cartography";

describe("cartography rank ladder", () => {
  it("is an ascending tiered ladder starting at 0", () => {
    expect(CARTO_RANKS.length).toBeGreaterThanOrEqual(4);
    expect(CARTO_RANKS[0]!.minCharted).toBe(0);
    expect(CARTO_RANKS[0]!.tier).toBe(0);
    for (let i = 1; i < CARTO_RANKS.length; i++) {
      expect(CARTO_RANKS[i]!.minCharted).toBeGreaterThan(CARTO_RANKS[i - 1]!.minCharted);
      expect(CARTO_RANKS[i]!.tier).toBe(CARTO_RANKS[i - 1]!.tier + 1);
      expect(CARTO_RANKS[i]!.title.length).toBeGreaterThan(0);
    }
  });

  it("cartographyRank picks the highest minCharted <= charted, clamps both ends", () => {
    expect(cartographyRank(0).tier).toBe(0);
    expect(cartographyRank(-3).tier).toBe(0);            // clamp low
    const top = CARTO_RANKS[CARTO_RANKS.length - 1]!;
    expect(cartographyRank(top.minCharted).tier).toBe(top.tier);
    expect(cartographyRank(top.minCharted + 10_000).tier).toBe(top.tier);
    expect(MAX_CARTO_TIER).toBe(top.tier);
  });

  it("is monotonic non-decreasing in charted", () => {
    let prev = 0;
    for (let c = 0; c <= 500; c += 7) {
      const t = cartographyRank(c).tier;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("a higher charted count never gives a lower-tier title than tier 0", () => {
    expect(cartographyRank(MAX_CARTO_TIER === 0 ? 0 : 999).tier).toBeGreaterThan(0);
  });
});
