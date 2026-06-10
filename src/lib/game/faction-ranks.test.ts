import { describe, it, expect } from "vitest";
import {
  RANKS, rankFor, MAX_RANK_TIER, factionAt, contractsAt, getFaction,
} from "@/lib/game/factions";
import { RESOURCES, getResource } from "@/lib/universe";
import { isMaterialId, materialValue } from "@/lib/game/materials";
import { isPartId, partValue } from "@/lib/game/parts";

const SEED = "omniplex-prod-1";
const isResourceId = (id: string) => RESOURCES.some((r) => r.id === id);
const unitValue = (id: string) =>
  isResourceId(id) ? getResource(id).baseValue
  : isPartId(id) ? partValue(id) : isMaterialId(id) ? materialValue(id) : NaN;

describe("rank ladder", () => {
  it("is an ascending tiered ladder; rankFor picks the highest minRep <= rep", () => {
    expect(RANKS.length).toBeGreaterThanOrEqual(4);
    expect(RANKS[0]!.minRep).toBe(0);
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i]!.minRep).toBeGreaterThan(RANKS[i - 1]!.minRep);
      expect(RANKS[i]!.tier).toBe(RANKS[i - 1]!.tier + 1);
    }
    expect(rankFor(0).tier).toBe(0);
    expect(rankFor(-5).tier).toBe(0);                       // clamp low
    const top = RANKS[RANKS.length - 1]!;
    expect(rankFor(top.minRep + 999_999).tier).toBe(top.tier);
    expect(MAX_RANK_TIER).toBe(top.tier);
  });

  it("rankFor is monotonic non-decreasing in rep", () => {
    let prev = 0;
    for (let rep = 0; rep <= 10_000; rep += 137) {
      const t = rankFor(rep).tier;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});

describe("rank-gated contracts", () => {
  const hub = "0:0:0:1:0:0";
  const fac = factionAt(SEED, hub);
  const demand = new Set(getFaction(fac).demand);

  it("at every rank: deterministic, wants from demand, premium over market", () => {
    for (const rank of [0, 1, MAX_RANK_TIER]) {
      const cs = contractsAt(SEED, hub, fac, 1000, rank);
      expect(cs).toStrictEqual(contractsAt(SEED, hub, fac, 1000, rank)); // deterministic
      expect(cs.length).toBeGreaterThan(0);
      for (const c of cs) {
        expect(demand.has(c.want.itemId)).toBe(true);
        expect(c.want.qty).toBeGreaterThan(0);
        expect(c.rewardCredits).toBeGreaterThan(unitValue(c.want.itemId) * c.want.qty); // premium holds
      }
    }
  });

  it("is monotonic in rank — a higher rank's contracts are at least as lucrative", () => {
    const best = (rank: number) =>
      Math.max(...contractsAt(SEED, hub, fac, 1000, rank).map((c) => c.rewardCredits));
    let prev = best(0);
    for (let rank = 1; rank <= MAX_RANK_TIER; rank++) {
      const cur = best(rank);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("rotates across buckets at a fixed rank (keys bucket-distinct)", () => {
    const k1 = contractsAt(SEED, hub, fac, 1000, 1).map((c) => c.key);
    const k2 = contractsAt(SEED, hub, fac, 1001, 1).map((c) => c.key);
    expect(k1.some((k) => k2.includes(k))).toBe(false);
  });
});
