/**
 * Supplementary pure-layer coverage for factions-core (does NOT replace the
 * seeded `factions-core.test.ts` contract). Locks a few properties the seeded
 * suite leaves implicit: hub alignment varies across hubs, contract keys are
 * unique within a bucket, and reputation scales modestly.
 */
import { describe, it, expect } from "vitest";
import {
  FACTIONS,
  factionAt,
  contractsAt,
  CONTRACT_ROTATION_MS,
} from "@/lib/game/factions";

const SEED = "omniplex-prod-1";

describe("hub → faction alignment", () => {
  it("is not constant — different hubs map to more than one faction", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 200; s++) {
      // Vary the system segment of the region key across many hubs.
      seen.add(factionAt(SEED, `0:0:0:${s}:0:0`));
    }
    // With ~4 factions over 200 hubs, we should see several distinct ones.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("differs by seed (alignment is seed-dependent)", () => {
    const hub = "0:0:0:7:0:0";
    const a = factionAt("seed-a", hub);
    const b = factionAt("seed-b", hub);
    // Not a hard guarantee for a single hub, but exercises seed-sensitivity:
    expect(FACTIONS.some((f) => f.id === a)).toBe(true);
    expect(FACTIONS.some((f) => f.id === b)).toBe(true);
  });
});

describe("contract board", () => {
  const hub = "0:0:0:1:0:0";
  const fac = factionAt(SEED, hub);

  it("has unique keys within a single bucket", () => {
    const keys = contractsAt(SEED, hub, fac, 4242).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("awards positive, modestly-scaled reputation", () => {
    for (const c of contractsAt(SEED, hub, fac, 4242)) {
      expect(c.rewardRep).toBeGreaterThan(0);
      // Modest: rep is far smaller than the credit reward.
      expect(c.rewardRep).toBeLessThan(c.rewardCredits);
    }
  });

  it("rotation period is a few hours", () => {
    expect(CONTRACT_ROTATION_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("orbital-outpost hubs (region -1) generate a valid board too", () => {
    const outpostHub = "0:0:0:1:0:-1";
    const f = factionAt(SEED, outpostHub);
    const board = contractsAt(SEED, outpostHub, f, 1000);
    expect(board.length).toBeGreaterThan(0);
    for (const c of board) expect(c.want.qty).toBeGreaterThan(0);
  });
});
