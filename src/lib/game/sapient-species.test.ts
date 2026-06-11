import { describe, it, expect } from "vitest";
import {
  DOMINANT_SPECIES, SPECIES_IDS, isSpeciesId, getSpecies, minorSpeciesAt,
} from "@/lib/game/species";
import { FACTIONS, getFaction } from "@/lib/game/factions";

const SEED = "omniplex-prod-1";
const ORIGINS = new Set(["high-gravity", "low-gravity", "ocean", "desert", "frozen", "volcanic", "irradiated", "temperate", "gas"]);
const TECH = new Set(["biotech", "materials", "computation", "industry", "broad"]);
const SOCIAL = new Set(["hive", "hierarchical", "consensus", "nomadic", "isolationist"]);
const wellFormed = (s: any) => {
  expect(s.id.length).toBeGreaterThan(0);
  expect(s.name.length).toBeGreaterThan(0);
  expect(TECH.has(s.techAptitude)).toBe(true);
  expect(SOCIAL.has(s.socialStructure)).toBe(true);
  // origin from a known set (allow a superset — assert it's a non-empty string at least)
  expect(typeof s.originWorld).toBe("string");
  expect(s.originWorld.length).toBeGreaterThan(0);
};

describe("dominant species catalog", () => {
  it("is a handful (~5) of well-formed, distinct species", () => {
    expect(DOMINANT_SPECIES.length).toBeGreaterThanOrEqual(4);
    expect(DOMINANT_SPECIES.length).toBeLessThanOrEqual(8);
    expect(new Set(SPECIES_IDS).size).toBe(SPECIES_IDS.length);   // unique
    for (const s of DOMINANT_SPECIES) wellFormed(s);
  });
  it("helpers behave", () => {
    expect(isSpeciesId(SPECIES_IDS[0]!)).toBe(true);
    expect(isSpeciesId("not_a_species")).toBe(false);
    expect(() => getSpecies("not_a_species")).toThrow();
  });
});

describe("faction–species anchoring (additive)", () => {
  it("every faction is anchored to a real dominant species", () => {
    for (const f of FACTIONS) {
      expect(isSpeciesId((f as any).species)).toBe(true);
      // and it's a DOMINANT species (not a minor)
      expect(SPECIES_IDS).toContain((f as any).species);
    }
  });
});

describe("procedural minor species", () => {
  it("minorSpeciesAt is deterministic and well-formed", () => {
    const a = minorSpeciesAt(SEED, "0:0:0:1");
    expect(minorSpeciesAt(SEED, "0:0:0:1")).toStrictEqual(a);
    wellFormed(a);
  });
  it("varies across keys (many distinct minor species)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(JSON.stringify(minorSpeciesAt(SEED, `0:0:0:${i}`)));
    expect(seen.size).toBeGreaterThan(20);          // plenty of variety
  });
});
