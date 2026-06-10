import { describe, it, expect } from "vitest";
import {
  FACTIONS, FACTION_IDS, isFactionId, getFaction,
  factionAt, contractsAt, CONTRACT_ROTATION_MS, CONTRACT_REWARD_MARKUP,
} from "@/lib/game/factions";
import { RESOURCES, getResource } from "@/lib/universe";
import { isMaterialId, materialValue } from "@/lib/game/materials";
import { isPartId, partValue } from "@/lib/game/parts";

const SEED = "omniplex-prod-1";
const isResourceId = (id: string) => RESOURCES.some((r) => r.id === id);
const unitValue = (id: string) =>
  isResourceId(id) ? getResource(id).baseValue
  : isPartId(id) ? partValue(id)
  : isMaterialId(id) ? materialValue(id)
  : NaN;

describe("faction catalog", () => {
  it("has ~4 factions, each demanding only real carriable goods", () => {
    expect(FACTIONS.length).toBeGreaterThanOrEqual(3);
    expect(FACTION_IDS.length).toBe(FACTIONS.length);
    for (const f of FACTIONS) {
      expect(f.demand.length).toBeGreaterThan(0);
      for (const id of f.demand) {
        const real = isResourceId(id) || isMaterialId(id) || isPartId(id);
        expect(real).toBe(true);                 // real resource/material/part
        expect(Number.isFinite(unitValue(id))).toBe(true);
      }
    }
  });

  it("helpers behave", () => {
    expect(isFactionId(FACTION_IDS[0]!)).toBe(true);
    expect(isFactionId("nope")).toBe(false);
    expect(() => getFaction("nope")).toThrow();
  });
});

describe("hub → faction alignment is deterministic", () => {
  it("factionAt returns a real faction, stable per hub", () => {
    const hub = "0:0:0:1:0:0";
    expect(FACTION_IDS).toContain(factionAt(SEED, hub));
    expect(factionAt(SEED, hub)).toBe(factionAt(SEED, hub));
  });
});

describe("contract generation — deterministic, rotating, premium", () => {
  const hub = "0:0:0:1:0:0";
  const fac = factionAt(SEED, hub);

  it("is deterministic per (hub, bucket) and yields a bounded valid set", () => {
    const a = contractsAt(SEED, hub, fac, 1000);
    const b = contractsAt(SEED, hub, fac, 1000);
    expect(a).toStrictEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(8);
    const demand = new Set(getFaction(fac).demand);
    for (const c of a) {
      expect(c.factionId).toBe(fac);
      expect(demand.has(c.want.itemId)).toBe(true);   // wants from the faction's demand
      expect(c.want.qty).toBeGreaterThan(0);
    }
  });

  it("rotates across time buckets (keys differ bucket-to-bucket)", () => {
    const k1 = contractsAt(SEED, hub, fac, 1000).map((c) => c.key);
    const k2 = contractsAt(SEED, hub, fac, 1001).map((c) => c.key);
    // no contract key from bucket 1000 reappears in bucket 1001
    expect(k1.some((k) => k2.includes(k))).toBe(false);
  });

  it("rewardCredits is a strict PREMIUM over dumping the goods on the market", () => {
    for (const c of contractsAt(SEED, hub, fac, 1000)) {
      const market = unitValue(c.want.itemId) * c.want.qty;
      expect(c.rewardCredits).toBeGreaterThan(market);
      expect(c.rewardRep).toBeGreaterThan(0);
    }
    expect(CONTRACT_REWARD_MARKUP).toBeGreaterThan(1);
    expect(CONTRACT_ROTATION_MS).toBeGreaterThan(0);
  });
});
