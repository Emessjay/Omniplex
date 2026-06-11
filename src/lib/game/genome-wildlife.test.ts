import { describe, it, expect } from "vitest";
import { speciesCombatStats } from "@/lib/game/rules"; // or wherever it lives
import { regionFauna, regionFlora, speciesDrop, systemAt, planetAt, regionGrid, regionIndex } from "@/lib/universe";
import { isMaterialId } from "@/lib/game/materials";

const SEED = "omniplex-prod-1";
function rockyRegion() {
  for (let c = 40; c < 64; c++) for (let s = 0; s < 80; s++)
    for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster: c, system: s }).planets)
      if (!p.isGas && p.regionCount >= 400) {
        const { cols } = regionGrid(p);
        return { pc: p.coord, region: regionIndex(Math.floor(regionGrid(p).rows / 2), Math.floor(cols / 2), cols) };
      }
  throw new Error("no rocky region");
}

describe("speciesCombatStats — derived from traits", () => {
  const { pc, region } = rockyRegion();
  const fauna = regionFauna(SEED, { ...pc, region });

  it("returns positive maxHp/attack and a hostile flag, deterministic", () => {
    expect(fauna.length).toBeGreaterThan(0);
    for (const sp of fauna) {
      const s = speciesCombatStats(sp);
      expect(s.maxHp).toBeGreaterThan(0);
      expect(s.attack).toBeGreaterThanOrEqual(0);
      expect(typeof s.hostile).toBe("boolean");
      expect(speciesCombatStats(sp)).toStrictEqual(s);     // deterministic
    }
  });

  it("predators/larger creatures are tougher than small grazers", () => {
    // construct two contrasting species (shapes per the 5a genome)
    const big: any = { archetype: "armored_colossus", trophicRole: "herbivore",
      traits: { size: "huge", defense: "armor", temperament: "territorial" } };
    const small: any = { archetype: "swarm", trophicRole: "herbivore",
      traits: { size: "tiny", defense: "none", temperament: "skittish" } };
    expect(speciesCombatStats(big).maxHp).toBeGreaterThan(speciesCombatStats(small).maxHp);
    const pred: any = { archetype: "ambush_predator", trophicRole: "carnivore",
      traits: { size: "large", defense: "venom", temperament: "hostile" } };
    expect(speciesCombatStats(pred).attack).toBeGreaterThan(speciesCombatStats(small).attack);
    expect(speciesCombatStats(pred).hostile).toBe(true);     // hostile temperament
  });
});

describe("drops feed real materials", () => {
  it("every generated flora/fauna drop is a real bounded material", () => {
    const { pc, region } = rockyRegion();
    for (const sp of [...regionFlora(SEED, { ...pc, region }), ...regionFauna(SEED, { ...pc, region })]) {
      const d = speciesDrop(sp);
      expect(isMaterialId(d.materialId)).toBe(true);
      expect(d.qty).toBeGreaterThan(0);
    }
  });
});
