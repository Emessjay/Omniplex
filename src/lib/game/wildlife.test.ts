/**
 * Wild flora/fauna are now PROCEDURAL (cascade tier 5b): the fixed
 * `wildlife.ts` `FLORA`/`FAUNA` catalogs + `pickForBiome` are gone, replaced by
 * the genome (`universe/genome.ts`: `regionFlora`/`regionFauna`/`speciesDrop`)
 * and `speciesCombatStats`. This suite (migrated from the P5 catalog tests)
 * keeps the catalog-independent contracts — `combatRound`, `exploreOutcome`, the
 * `materials` catalog — and re-points the biome-appropriate-selection coverage
 * at the genome (env-fit generation + drops feeding real materials).
 */
import { describe, it, expect } from "vitest";
import {
  combatRound,
  exploreOutcome,
  speciesCombatStats,
  PLAYER_BASE_ATTACK,
} from "@/lib/game/rules";
import {
  MATERIALS,
  isMaterialId,
  getMaterial,
  materialValue,
} from "@/lib/game/materials";
import {
  regionFlora,
  regionFauna,
  speciesDrop,
  systemAt,
  regionGrid,
  regionIndex,
} from "@/lib/universe";

const SEED = "omniplex-prod-1";

/** A landable rocky region with a decent grid, for genome generation tests. */
function rockyRegion() {
  for (let c = 40; c < 64; c++)
    for (let s = 0; s < 80; s++)
      for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster: c, system: s }).planets)
        if (!p.isGas && p.regionCount >= 400) {
          const { rows, cols } = regionGrid(p);
          return { pc: p.coord, region: regionIndex(Math.floor(rows / 2), Math.floor(cols / 2), cols) };
        }
  throw new Error("no rocky region");
}

describe("combatRound — simultaneous damage", () => {
  it("both sides take damage in a single round", () => {
    const r = combatRound({ playerHp: 100, playerAtk: 12, creatureHp: 30, creatureAtk: 8 });
    expect(r.creatureHp).toBe(18); // 30 - 12
    expect(r.playerHp).toBe(92); // 100 - 8
    expect(r.playerDead).toBe(false);
    expect(r.creatureDead).toBe(false);
  });

  it("clamps HP at 0 and flags death; both can die in the same round", () => {
    const r = combatRound({ playerHp: 5, playerAtk: 50, creatureHp: 4, creatureAtk: 9 });
    expect(r.creatureHp).toBe(0);
    expect(r.playerHp).toBe(0);
    expect(r.creatureDead).toBe(true);
    expect(r.playerDead).toBe(true);
  });

  it("PLAYER_BASE_ATTACK is a positive number", () => {
    expect(PLAYER_BASE_ATTACK).toBeGreaterThan(0);
  });
});

describe("exploreOutcome", () => {
  it("maps rolls to the three outcomes and only those", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(exploreOutcome(i / 100));
    for (const o of seen) expect(["scavenge", "flora", "fauna"]).toContain(o);
    expect(seen.size).toBeGreaterThan(1); // not all the same outcome
  });
});

describe("materials catalog", () => {
  it("non-empty; values positive; helpers behave", () => {
    expect(MATERIALS.length).toBeGreaterThan(0);
    for (const m of MATERIALS) {
      expect(m.value).toBeGreaterThan(0);
      expect(["flora", "animal", "relic", "mineral", "food", "consumable", "crop"]).toContain(m.category);
    }
    const anyId = MATERIALS[0]!.id;
    expect(isMaterialId(anyId)).toBe(true);
    expect(isMaterialId("definitely-not-a-material")).toBe(false);
    expect(materialValue(anyId)).toBe(getMaterial(anyId).value);
  });

  it("includes at least one high-value relic", () => {
    const relics = MATERIALS.filter((m) => m.category === "relic");
    expect(relics.length).toBeGreaterThan(0);
  });
});

describe("genome-driven wild life (replaces fixed FLORA/FAUNA)", () => {
  const { pc, region } = rockyRegion();
  const coord = { ...pc, region };

  it("a region always has flora to find, and every generated species drops a real material", () => {
    const flora = regionFlora(SEED, coord);
    expect(flora.length).toBeGreaterThan(0); // base of the web is never empty
    for (const sp of [...flora, ...regionFauna(SEED, coord)]) {
      const d = speciesDrop(sp);
      expect(isMaterialId(d.materialId)).toBe(true);
      expect(d.qty).toBeGreaterThan(0);
    }
  });

  it("generated fauna have sane combat stats derived from traits", () => {
    for (const sp of regionFauna(SEED, coord)) {
      const stats = speciesCombatStats(sp);
      expect(stats.maxHp).toBeGreaterThan(0);
      expect(stats.attack).toBeGreaterThanOrEqual(0);
      expect(typeof stats.hostile).toBe("boolean");
    }
  });
});
