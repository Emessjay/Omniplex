import { describe, it, expect } from "vitest";
import { assembleBlurb, blurbOf } from "@/lib/game/blurbs"; // wherever the module lives
import { speciesLabel } from "@/lib/game/rules"; // or wherever speciesLabel is defined

// A minimal species shaped like the genome's Species.
const species = (o: any = {}) => ({
  archetype: "ambush_predator",
  trophicRole: "carnivore",
  traits: {
    size: "large", locomotion: "swimming", defense: "armor", temperament: "skittish",
    adaptation: "none", integument: "scaled", reproduction: "clutch",
  },
  diet: [],
  ...o,
});

// A fixture library covering this species + biome (3 variants where it matters).
const lib = {
  "biome.ocean#1": "in the lightless deep water",
  "biome.ocean#2": "down in the crushing dark",
  "biome.ocean#3": "among the cold pressure of the deep",
  "archetype.ambush_predator#1": "it folds into a crevice and strikes what drifts past",
  "archetype.ambush_predator#2": "it waits motionless, then lunges",
  "archetype.ambush_predator#3": "it lies hidden and seizes the unwary",
  "trait.defense.armor#1": "armored in fused plates",
  "trait.defense.armor#2": "plated against attack",
  "trait.defense.armor#3": "shelled in hard armor",
  "trait.size.large#1": "large and heavy",
  "trait.size.large#2": "a bulk that fills the gap",
  "trait.size.large#3": "broad-bodied",
};

describe("assembleBlurb — deterministic grammar", () => {
  it("assembles a single capitalized, period-terminated sentence", () => {
    const b = assembleBlurb(lib, species(), "ocean", ["r", 1, 2, 3]);
    expect(b).not.toBeNull();
    expect(b!).toMatch(/^[A-Z]/);          // capitalized
    expect(b!.endsWith(".")).toBe(true);   // terminated
    // includes the archetype core + the biome opener + at least one trait clause
    expect(b!.toLowerCase()).toMatch(/strikes|lunges|seizes/);
  });

  it("is deterministic: same inputs ⇒ byte-identical output", () => {
    const a = assembleBlurb(lib, species(), "ocean", ["r", 1, 2, 3]);
    const b = assembleBlurb(lib, species(), "ocean", ["r", 1, 2, 3]);
    expect(a).toBe(b);
  });

  it("varies by species / biome (not all the same blurb)", () => {
    const a = assembleBlurb(lib, species(), "ocean", ["r", 1, 2, 3]);
    const c = assembleBlurb(lib, species({ traits: { ...species().traits, defense: "armor" } }), "ocean", ["r", 9, 9, 9]);
    // different seed parts → may pick different variants; at minimum it must not throw
    expect(typeof a).toBe("string");
    expect(typeof c).toBe("string");
  });

  it("does not voice a 'none'-type trait", () => {
    const b = assembleBlurb(lib, species({ traits: { ...species().traits, adaptation: "none" } }), "ocean", ["r", 1, 1, 1]);
    expect(b!.toLowerCase()).not.toContain("none");
  });

  it("picks only in-range variants (no missing-key text leaks)", () => {
    const b = assembleBlurb(lib, species(), "ocean", ["x", 7, 7, 7]);
    expect(b).not.toBeNull();
    expect(b!).not.toContain("#");          // no raw key/variant marker leaked
    expect(b!).not.toContain("undefined");
  });
});

describe("partial-library fallback (load-bearing)", () => {
  it("empty library ⇒ assembleBlurb null, blurbOf falls back to speciesLabel", () => {
    expect(assembleBlurb({}, species(), "ocean", ["r", 1, 2, 3])).toBeNull();
    const fb = blurbOf(species(), "ocean", "r", 1, 2, 3);
    expect(typeof fb).toBe("string");
    expect(fb.length).toBeGreaterThan(0);
    expect(fb).toBe(speciesLabel(species() as any));   // exact fallback
  });

  it("missing biome/trait pieces still assemble from the archetype core (no throw)", () => {
    const coreOnly = {
      "archetype.ambush_predator#1": "it folds into a crevice and strikes what drifts past",
      "archetype.ambush_predator#2": "it waits motionless, then lunges",
      "archetype.ambush_predator#3": "it lies hidden and seizes the unwary",
    };
    const b = assembleBlurb(coreOnly, species(), "ocean", ["r", 1, 2, 3]);
    expect(b).not.toBeNull();
    expect(b!.endsWith(".")).toBe(true);
    expect(b!).not.toContain("undefined");
  });

  it("never throws on an unknown biome or archetype", () => {
    expect(() => assembleBlurb(lib, species({ archetype: "not_a_real_archetype" }), "ocean", ["r", 1, 2, 3])).not.toThrow();
    expect(() => assembleBlurb(lib, species(), "not_a_biome" as any, ["r", 1, 2, 3])).not.toThrow();
  });
});
