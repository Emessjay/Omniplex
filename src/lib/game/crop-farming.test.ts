import { describe, it, expect } from "vitest";
import {
  CROPS, CROP_IDS, isCropId, getCrop, cropsForBiome,
} from "@/lib/game/crops";
import {
  MATERIALS, getMaterial, isMaterialId, SCAVENGEABLE,
} from "@/lib/game/materials";
import { cropMature, CROP_FARM_PLOTS } from "@/lib/game/rules";
import { STRUCTURE_KINDS, isStructureKind, buildingCost } from "@/lib/game/bases";
import { BIOMES } from "@/lib/universe";
import type { Biome } from "@/lib/universe";

describe("crop catalog — diverse, biome-affined, valid", () => {
  it("has ≥10 crops across ≥4 biomes, ≥2 per covered biome", () => {
    expect(CROPS.length).toBeGreaterThanOrEqual(10);
    const covered = new Set<Biome>();
    for (const c of CROPS) for (const b of c.biomes) covered.add(b);
    expect(covered.size).toBeGreaterThanOrEqual(4);
    for (const b of covered) {
      expect(cropsForBiome(b).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("every crop is well-formed and yields a real crop material", () => {
    for (const c of CROPS) {
      expect(c.biomes.length).toBeGreaterThan(0);
      for (const b of c.biomes) expect(BIOMES).toContain(b);
      expect(c.growMs).toBeGreaterThan(0);
      expect(c.yield.qty).toBeGreaterThan(0);
      expect(isMaterialId(c.yield.materialId)).toBe(true);
      expect(getMaterial(c.yield.materialId).category).toBe("crop");
    }
  });

  it("cropsForBiome returns only crops valid for that biome", () => {
    for (const b of BIOMES) {
      for (const c of cropsForBiome(b)) expect(c.biomes).toContain(b);
    }
  });

  it("helpers behave", () => {
    expect(isCropId(CROP_IDS[0]!)).toBe(true);
    expect(isCropId("not_a_crop")).toBe(false);
    expect(() => getCrop("not_a_crop")).toThrow();
  });
});

describe("crop materials", () => {
  it("there is at least one 'crop' material, all sellable, none scavengeable", () => {
    const crops = MATERIALS.filter((m) => m.category === "crop");
    expect(crops.length).toBeGreaterThanOrEqual(1);
    for (const m of crops) {
      expect(m.value).toBeGreaterThan(0);
      expect(SCAVENGEABLE).not.toContain(m.category); // crops are farmed, not found
    }
  });
});

describe("cropMature — time-gated growth (pure)", () => {
  it("is false before growMs, true at/after, monotonic in elapsed", () => {
    const grow = 60_000;
    expect(cropMature(1000, 1000, grow)).toBe(false);          // 0 elapsed
    expect(cropMature(1000, 1000 + grow - 1, grow)).toBe(false);
    expect(cropMature(1000, 1000 + grow, grow)).toBe(true);    // exactly ripe
    expect(cropMature(1000, 1000 + grow + 999, grow)).toBe(true);
  });
});

describe("crop_farm building", () => {
  it("is a structure kind with a positive-credit cost and provides plots", () => {
    expect(STRUCTURE_KINDS).toContain("crop_farm");
    expect(isStructureKind("crop_farm")).toBe(true);
    expect(buildingCost("crop_farm").credits).toBeGreaterThan(0);
    expect(CROP_FARM_PLOTS).toBeGreaterThan(0);
  });
});
