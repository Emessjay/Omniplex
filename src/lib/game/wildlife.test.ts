import { describe, it, expect } from "vitest";
import { combatRound, exploreOutcome, PLAYER_BASE_ATTACK } from "@/lib/game/rules";
import {
  MATERIALS,
  isMaterialId,
  getMaterial,
  materialValue,
} from "@/lib/game/materials";
import { FAUNA, FLORA, pickForBiome } from "@/lib/game/wildlife";
import { BIOMES } from "@/lib/universe";

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
      expect(["flora", "animal", "relic", "mineral", "food", "consumable"]).toContain(m.category);
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

describe("biome-appropriate selection", () => {
  it("every fauna/flora declares at least one valid biome", () => {
    const biomeSet = new Set(BIOMES);
    for (const f of [...FAUNA, ...FLORA]) {
      expect(f.biomes.length).toBeGreaterThan(0);
      for (const b of f.biomes) expect(biomeSet.has(b)).toBe(true);
    }
  });

  it("pickForBiome only returns entries valid for that biome", () => {
    // Pick a biome that at least one fauna supports, then sample picks.
    const biome = FAUNA[0]!.biomes[0]!;
    const candidates = FAUNA.filter((f) => f.biomes.includes(biome));
    for (let i = 0; i < 20; i++) {
      const pick = pickForBiome(candidates, biome, i / 20);
      expect(pick).not.toBeNull();
      expect(pick!.biomes).toContain(biome);
    }
  });
});
