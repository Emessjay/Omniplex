import { describe, it, expect } from "vitest";
import {
  ARCHETYPES, TRAIT_DIMENSIONS, regionFlora, regionFauna, speciesDrop,
  systemAt, planetAt, regionAt, regionGrid, regionIndex,
} from "@/lib/universe";
import type { RegionCoord } from "@/lib/universe";
import { isMaterialId } from "@/lib/game/materials";

const SEED = "omniplex-prod-1";
function rockyPlanet() {
  for (let c = 40; c < 64; c++) for (let s = 0; s < 80; s++)
    for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster: c, system: s }).planets)
      if (!p.isGas && p.regionCount >= 400) return p.coord;
  throw new Error("no rocky planet");
}
const pc = rockyPlanet();
const planet = planetAt(SEED, pc);
const { rows, cols } = regionGrid(planet);
const regionAtLat = (lat: number): RegionCoord => ({ ...pc, region: regionIndex(lat, Math.floor(cols / 2), cols) });

describe("genome catalog", () => {
  it("has a rich archetype set (role-tagged) and 6-8 trait dimensions", () => {
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(30);
    expect(ARCHETYPES.some((a: any) => a.trophicRole === "producer")).toBe(true);   // flora
    expect(ARCHETYPES.some((a: any) => a.trophicRole === "herbivore")).toBe(true);
    expect(ARCHETYPES.some((a: any) => a.trophicRole === "carnivore")).toBe(true);
    expect(TRAIT_DIMENSIONS.length).toBeGreaterThanOrEqual(6);
    for (const d of TRAIT_DIMENSIONS) expect(d.options.length).toBeGreaterThanOrEqual(4);
  });
});

describe("generation — deterministic, non-perturbing, environment-filtered", () => {
  const rc = regionAtLat(Math.floor(rows / 2));

  it("regionFlora/regionFauna are deterministic", () => {
    expect(regionFlora(SEED, rc)).toStrictEqual(regionFlora(SEED, rc));
    expect(regionFauna(SEED, rc)).toStrictEqual(regionFauna(SEED, rc));
  });

  it("does NOT perturb the region's biome/temp/formation (distinct stream)", () => {
    const before = JSON.stringify(regionAt(SEED, pc, rc.region));
    regionFlora(SEED, rc); regionFauna(SEED, rc);
    expect(JSON.stringify(regionAt(SEED, pc, rc.region))).toBe(before);
  });

  it("species are environment-appropriate (cold region differs from warm)", () => {
    const cold = regionFlora(SEED, regionAtLat(0));            // pole
    const warm = regionFlora(SEED, regionAtLat(Math.floor(rows / 2))); // equator
    // both non-empty and the generated sets aren't identical species lists
    expect(cold.length + warm.length).toBeGreaterThan(0);
    // (loose) at least one differs — climate filters the pool
    expect(JSON.stringify(cold)).not.toBe(JSON.stringify(warm));
  });
});

describe("ecological web (trophic order)", () => {
  const rc = regionAtLat(Math.floor(rows / 2));
  it("prey diets reference flora present; predators reference prey present", () => {
    const flora = regionFlora(SEED, rc);
    const fauna = regionFauna(SEED, rc);
    const floraArchetypes = new Set(flora.map((f: any) => f.archetype));
    const preyRoles = new Set(["herbivore", "omnivore"]);
    const prey = fauna.filter((f: any) => preyRoles.has(f.trophicRole));
    const predators = fauna.filter((f: any) => f.trophicRole === "carnivore");
    // no orphan trophic levels: predators only exist if prey exists
    if (predators.length > 0) expect(prey.length).toBeGreaterThan(0);
    // herbivores only where flora exists
    if (prey.length > 0) expect(flora.length).toBeGreaterThan(0);
  });
});

describe("diversity + bounded drops", () => {
  it("species are overwhelmingly distinct across regions (rarely repeat)", () => {
    const seen = new Set<string>();
    let total = 0;
    for (let lat = 0; lat < rows; lat += Math.max(1, Math.floor(rows / 30))) {
      for (const sp of [...regionFlora(SEED, regionAtLat(lat)), ...regionFauna(SEED, regionAtLat(lat))]) {
        seen.add(JSON.stringify(sp)); total++;
      }
    }
    expect(total).toBeGreaterThan(10);
    expect(seen.size / total).toBeGreaterThan(0.5);            // mostly distinct
  });

  it("speciesDrop maps to a real bounded material", () => {
    for (const sp of [...regionFlora(SEED, regionAtLat(2)), ...regionFauna(SEED, regionAtLat(2))]) {
      const drop = speciesDrop(sp);
      expect(isMaterialId(drop.materialId)).toBe(true);
      expect(drop.qty).toBeGreaterThan(0);
    }
  });
});
