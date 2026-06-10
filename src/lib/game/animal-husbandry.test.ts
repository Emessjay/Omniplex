import { describe, it, expect } from "vitest";
import {
  FARM_ANIMALS, FARM_ANIMAL_IDS, isFarmAnimalId, getFarmAnimal, farmAnimalsForBiome,
} from "@/lib/game/livestock";
import { isCropId } from "@/lib/game/crops";
import { getMaterial, isMaterialId } from "@/lib/game/materials";
import {
  livestockCanBreed, feedAmount, breedOffspring, LIVESTOCK_PEN_CAPACITY,
} from "@/lib/game/rules";
import { STRUCTURE_KINDS, isStructureKind, buildingCost } from "@/lib/game/bases";
import { BIOMES } from "@/lib/universe";
import type { Biome } from "@/lib/universe";

describe("farm-animal catalog — diverse, biome-affined, feeds on crops", () => {
  it("has ≥8 animals across ≥4 biomes (≥1 per covered biome)", () => {
    expect(FARM_ANIMALS.length).toBeGreaterThanOrEqual(8);
    const covered = new Set<Biome>();
    for (const a of FARM_ANIMALS) for (const b of a.biomes) covered.add(b);
    expect(covered.size).toBeGreaterThanOrEqual(4);
    for (const b of covered) expect(farmAnimalsForBiome(b).length).toBeGreaterThanOrEqual(1);
  });

  it("every animal is well-formed: real biomes, REAL crop feed, real animal product", () => {
    for (const a of FARM_ANIMALS) {
      expect(a.biomes.length).toBeGreaterThan(0);
      for (const b of a.biomes) expect(BIOMES).toContain(b);
      expect(isCropId(a.feed.cropId)).toBe(true);          // crops→feed loop
      expect(a.feed.qtyPerHead).toBeGreaterThan(0);
      expect(a.breedMs).toBeGreaterThan(0);
      expect(a.acquireCost).toBeGreaterThan(0);
      expect(isMaterialId(a.product.materialId)).toBe(true);
      expect(getMaterial(a.product.materialId).category).toBe("animal");
      expect(a.product.qty).toBeGreaterThan(0);
    }
  });

  it("farmAnimalsForBiome returns only biome-valid animals", () => {
    for (const b of BIOMES) for (const a of farmAnimalsForBiome(b)) expect(a.biomes).toContain(b);
  });

  it("helpers behave", () => {
    expect(isFarmAnimalId(FARM_ANIMAL_IDS[0]!)).toBe(true);
    expect(isFarmAnimalId("not_an_animal")).toBe(false);
    expect(() => getFarmAnimal("not_an_animal")).toThrow();
  });
});

describe("breed / feed rules (pure)", () => {
  it("livestockCanBreed gates on elapsed breedMs", () => {
    const b = 60_000;
    expect(livestockCanBreed(0, b - 1, b)).toBe(false);
    expect(livestockCanBreed(0, b, b)).toBe(true);
    expect(livestockCanBreed(0, b + 5, b)).toBe(true);
  });

  it("feedAmount scales with head count, 0 for empty herd", () => {
    expect(feedAmount(0, 2)).toBe(0);
    expect(feedAmount(1, 2)).toBeGreaterThanOrEqual(2);
    expect(feedAmount(5, 2)).toBeGreaterThan(feedAmount(2, 2));
  });

  it("breedOffspring adds at least one for a non-empty herd", () => {
    expect(breedOffspring(0)).toBe(0);
    expect(breedOffspring(1)).toBeGreaterThanOrEqual(1);
    expect(breedOffspring(10)).toBeGreaterThanOrEqual(breedOffspring(2));
  });
});

describe("livestock_pen building", () => {
  it("is a structure kind with a positive-credit cost and capacity", () => {
    expect(STRUCTURE_KINDS).toContain("livestock_pen");
    expect(isStructureKind("livestock_pen")).toBe(true);
    expect(buildingCost("livestock_pen").credits).toBeGreaterThan(0);
    expect(LIVESTOCK_PEN_CAPACITY).toBeGreaterThan(0);
  });
});
