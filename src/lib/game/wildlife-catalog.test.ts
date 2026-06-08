/**
 * Supplementary (non-seeded) guards for the P5 wildlife catalogs and helpers.
 * The seeded `wildlife.test.ts` owns the core contract; these lock down the
 * cross-catalog invariants this implementation relies on (every biome is
 * inhabited, harvest/drop/scavenge ids all resolve, scavenge never yields an
 * animal part) so a future catalog edit can't silently break the explore loop.
 */
import { describe, it, expect } from "vitest";
import { BIOMES } from "@/lib/universe";
import {
  FLORA,
  FAUNA,
  floraForBiome,
  faunaForBiome,
} from "@/lib/game/wildlife";
import { isMaterialId, SCAVENGEABLE, pickScavenge } from "@/lib/game/materials";
import { exploreOutcome, combatRound } from "@/lib/game/rules";

describe("wildlife catalogs", () => {
  it("every biome has at least one flora and one fauna", () => {
    for (const biome of BIOMES) {
      expect(floraForBiome(biome).length, `flora for ${biome}`).toBeGreaterThan(0);
      expect(faunaForBiome(biome).length, `fauna for ${biome}`).toBeGreaterThan(0);
    }
  });

  it("every flora harvest + fauna drop points at a real material", () => {
    for (const f of FLORA) {
      expect(isMaterialId(f.harvest.materialId), `${f.id} harvest`).toBe(true);
      expect(f.harvest.qty).toBeGreaterThan(0);
    }
    for (const f of FAUNA) {
      expect(isMaterialId(f.drop.materialId), `${f.id} drop`).toBe(true);
      expect(f.drop.qty).toBeGreaterThan(0);
      expect(f.maxHp).toBeGreaterThan(0);
      expect(f.attack).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("scavenging", () => {
  it("only ever yields scavengeable (never animal) materials", () => {
    for (const m of SCAVENGEABLE) expect(m.category).not.toBe("animal");
    for (let i = 0; i < 100; i++) {
      const m = pickScavenge(i / 100);
      expect(m.category).not.toBe("animal");
      expect(SCAVENGEABLE).toContain(m);
    }
  });

  it("low rolls turn up the rare relics", () => {
    expect(pickScavenge(0).category).toBe("relic");
  });
});

describe("explore thresholds + combat boundaries", () => {
  it("partitions the roll range in scavenge<flora<fauna order", () => {
    expect(exploreOutcome(0)).toBe("scavenge");
    expect(exploreOutcome(0.5)).toBe("flora");
    expect(exploreOutcome(0.99)).toBe("fauna");
  });

  it("combatRound never returns negative HP", () => {
    const r = combatRound({ playerHp: 1, playerAtk: 1, creatureHp: 1, creatureAtk: 1000 });
    expect(r.playerHp).toBe(0);
    expect(r.creatureHp).toBe(0);
    expect(r.playerDead).toBe(true);
    expect(r.creatureDead).toBe(true);
  });
});
