/**
 * Sapient species — the foundation the org-layer pillars need at full scale
 * (per `docs/design/pillars.md` §Foundation). The galaxy is populated by
 * **aliens**: a handful of hand-authored DOMINANT species (the narrative
 * anchors, each with cultural DNA grown from its origin ecology) plus a pure
 * deterministic GENERATOR for the vast many minor species.
 *
 * This module is PURE (no IO, no `Date`, no `Math.random`) — the catalog is the
 * code source of truth like `RESOURCES`/`FACTIONS`, and `minorSpeciesAt` is a
 * deterministic function of `(seed, key)`, so the same hub always shows the same
 * inhabitants and the universe stays effectively infinite without storing a
 * single species row.
 *
 * SCOPE (additive, no migration): this phase adds the species LAYER + the DNA
 * model + ties existing factions/hubs to species. It does NOT add player-species,
 * species-specific goods/diplomacy, or restructure factions (Politics-pillar
 * phases). The `Species` DNA is data + flavor + the hook the future Nimbus
 * blurb-writer consumes; minor species are pure FLAVOR here (no gameplay gates).
 */
import { makeRng, pick, weightedIndex } from "@/lib/universe/prng";

/**
 * The kind of homeworld a species evolved on. Origin ecology is the ROOT of the
 * cultural DNA: it biases body form, tech aptitude, and social structure (a
 * high-gravity world breeds compact, hierarchical builders; an extreme world
 * breeds tightly-bonded hive/consensus survivors; a temperate world breeds
 * broad generalists). The set mirrors the universe's planet/biome flavor so an
 * origin can plausibly be a real world out there.
 */
export type OriginWorld =
  | "high-gravity"
  | "low-gravity"
  | "ocean"
  | "desert"
  | "frozen"
  | "volcanic"
  | "irradiated"
  | "temperate"
  | "gas";

export const ORIGIN_WORLDS: readonly OriginWorld[] = [
  "high-gravity",
  "low-gravity",
  "ocean",
  "desert",
  "frozen",
  "volcanic",
  "irradiated",
  "temperate",
  "gas",
] as const;

/**
 * What a species is good at — cascades into what its empire trades and
 * researches (so a faction's demand theme has an in-world REASON once anchored
 * to a species). Matches the faction demand themes: industry/materials ↔ a
 * militarist metals-and-parts power, biotech ↔ an agrarian power, computation ↔
 * a scientific power, broad ↔ a mercantile generalist.
 */
export type TechAptitude = "biotech" | "materials" | "computation" | "industry" | "broad";

export const TECH_APTITUDES: readonly TechAptitude[] = [
  "biotech",
  "materials",
  "computation",
  "industry",
  "broad",
] as const;

/** How a species organizes itself — flavors its politics (later pillar phases). */
export type SocialStructure =
  | "hive"
  | "hierarchical"
  | "consensus"
  | "nomadic"
  | "isolationist";

export const SOCIAL_STRUCTURES: readonly SocialStructure[] = [
  "hive",
  "hierarchical",
  "consensus",
  "nomadic",
  "isolationist",
] as const;

/**
 * A sapient species. The DNA fields (`originWorld`/`techAptitude`/
 * `socialStructure` + the light body/appearance flavor) are the "facts" a future
 * blurb-writer turns into prose; `blurb` is a hand- or rule-authored one-liner
 * good enough to read today.
 */
export interface Species {
  id: string;
  name: string;
  blurb: string;
  originWorld: OriginWorld;
  techAptitude: TechAptitude;
  socialStructure: SocialStructure;
  /** Light body archetype (e.g. "insectoid", "cephalopodan") — flavor. */
  body: string;
  /** A short physical descriptor (e.g. "squat and dense-boned") — flavor. */
  appearance: string;
}

// ---------------------------------------------------------------------------
// Dominant species — the hand-authored narrative anchors. "A handful, not
// necessarily four": five distinct species spanning the origin/tech/social
// space, four of them anchoring the existing factions (see `factions.ts`) and
// one (the Tessarin) a known major species whose empire is TBD (a hook for the
// later Politics pillar). techAptitude is chosen to MATCH the anchored faction's
// demand theme so the economy now has an in-world cause.
// ---------------------------------------------------------------------------

export const DOMINANT_SPECIES: readonly Species[] = [
  {
    id: "kthar",
    name: "Kthar",
    blurb:
      "Squat, dense-boned forge-builders from a crushing high-gravity world; they organize as rigid martial castes and arm without end.",
    originWorld: "high-gravity",
    techAptitude: "industry",
    socialStructure: "hierarchical",
    body: "exo-plated bipedal",
    appearance: "squat and dense-boned, built for crushing gravity",
  },
  {
    id: "sylvani",
    name: "Sylvani",
    blurb:
      "Amphibious tenders from a world of warm shallow seas; a consensus people who cultivate life and feed whole frontiers.",
    originWorld: "ocean",
    techAptitude: "biotech",
    socialStructure: "consensus",
    body: "amphibious",
    appearance: "smooth-skinned and frill-gilled, hued like reef water",
  },
  {
    id: "cindrel",
    name: "Cindrel",
    blurb:
      "Pale, slow-moving scholars from a frozen dark world; their hive-mind archives chase the rare, the exotic, and the ancient.",
    originWorld: "frozen",
    techAptitude: "computation",
    socialStructure: "hive",
    body: "crystalline-shelled",
    appearance: "pale and translucent, lit from within by cold light",
  },
  {
    id: "voorn",
    name: "Voorn",
    blurb:
      "Wandering desert merchants who carry their cities on their backs; they deal in everything and belong to no one place.",
    originWorld: "desert",
    techAptitude: "broad",
    socialStructure: "nomadic",
    body: "reptilian",
    appearance: "lean and dust-scaled, with hooded sun-narrowed eyes",
  },
  {
    id: "tessarin",
    name: "Tessarin",
    blurb:
      "Reclusive volcanic-world artisans who shun outsiders; master materials-smiths whose worlds are rumored, never visited.",
    originWorld: "volcanic",
    techAptitude: "materials",
    socialStructure: "isolationist",
    body: "obsidian-hided",
    appearance: "tall and ember-veined, wreathed in heat-shimmer",
  },
] as const;

/** Valid dominant-species ids (the catalog ids; minor species are not listed here). */
export const SPECIES_IDS: readonly string[] = DOMINANT_SPECIES.map((s) => s.id);

const BY_ID: ReadonlyMap<string, Species> = new Map(DOMINANT_SPECIES.map((s) => [s.id, s]));

/** Whether `id` is a known DOMINANT species id. */
export function isSpeciesId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a DOMINANT species by id. Throws on unknown ids (mirrors `getResource`
 * / `getFaction`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getSpecies(id: string): Species {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown species id: ${id}`);
  return s;
}

// ---------------------------------------------------------------------------
// Procedural minor species — the vast many. A deterministic generator over the
// SAME DNA parameters as the dominant catalog, with sensible coupling from
// origin ecology to body/tech/social. Pure: `minorSpeciesAt(seed, key)` is a
// function of its inputs (its own `makeRng(seed, "species", key)` stream), so a
// hub always resolves the same inhabitants and variety is effectively endless.
// ---------------------------------------------------------------------------

/**
 * Per-origin weights over `TECH_APTITUDES` — the ecology→aptitude coupling
 * (e.g. ocean worlds skew biotech, frozen worlds computation, high-gravity and
 * volcanic worlds industry/materials, temperate worlds broad). Order matches
 * `TECH_APTITUDES`: [biotech, materials, computation, industry, broad].
 */
const TECH_WEIGHTS: Record<OriginWorld, readonly number[]> = {
  "high-gravity": [1, 3, 1, 5, 2],
  "low-gravity": [2, 2, 3, 2, 3],
  ocean: [6, 1, 2, 1, 3],
  desert: [2, 2, 2, 2, 5],
  frozen: [1, 2, 6, 1, 2],
  volcanic: [1, 6, 1, 4, 1],
  irradiated: [2, 3, 4, 3, 1],
  temperate: [3, 2, 3, 2, 5],
  gas: [2, 1, 4, 1, 3],
};

/**
 * Per-origin weights over `SOCIAL_STRUCTURES` — the ecology→society coupling
 * (extreme/scarce worlds skew hive/isolationist; high-gravity skews
 * hierarchical; deserts skew nomadic; temperate/ocean skew consensus). Order
 * matches `SOCIAL_STRUCTURES`: [hive, hierarchical, consensus, nomadic, isolationist].
 */
const SOCIAL_WEIGHTS: Record<OriginWorld, readonly number[]> = {
  "high-gravity": [2, 6, 1, 1, 2],
  "low-gravity": [1, 1, 3, 5, 2],
  ocean: [2, 1, 6, 1, 1],
  desert: [1, 2, 1, 6, 1],
  frozen: [4, 1, 1, 1, 4],
  volcanic: [3, 2, 1, 1, 4],
  irradiated: [5, 1, 1, 1, 3],
  temperate: [1, 2, 5, 2, 2],
  gas: [4, 1, 2, 1, 3],
};

/** Body archetypes keyed loosely to origin, for flavor variety. */
const BODY_BY_ORIGIN: Record<OriginWorld, readonly string[]> = {
  "high-gravity": ["exo-plated bipedal", "squat quadruped", "stone-hided"],
  "low-gravity": ["elongated bipedal", "gossamer-limbed", "tendrilled drifter"],
  ocean: ["amphibious", "cephalopodan", "scaled swimmer"],
  desert: ["reptilian", "chitin-armored", "burrowing"],
  frozen: ["crystalline-shelled", "furred hexapod", "slow-blooded"],
  volcanic: ["obsidian-hided", "magma-veined", "ash-feathered"],
  irradiated: ["silicon-boned", "many-eyed", "leaden-scaled"],
  temperate: ["mammalian bipedal", "avian", "ridged saurian"],
  gas: ["gasbag-buoyant", "diaphanous floater", "tentacled aeronaut"],
};

/** Physical descriptors for color, paired with bodies for the blurb. */
const APPEARANCE_BY_ORIGIN: Record<OriginWorld, readonly string[]> = {
  "high-gravity": ["squat and dense-boned", "broad and low-slung", "thick-limbed"],
  "low-gravity": ["impossibly tall and frail", "willowy and light", "stretched and pale"],
  ocean: ["smooth-skinned and frill-gilled", "iridescent and finned", "reef-hued"],
  desert: ["lean and dust-scaled", "sand-camouflaged", "hooded and sun-narrowed"],
  frozen: ["pale and translucent", "rime-furred", "glacier-blue and slow"],
  volcanic: ["ember-veined and tall", "soot-dark and heat-wreathed", "cracked like cooling lava"],
  irradiated: ["sickly-luminous", "scarred and many-eyed", "heavy and grey"],
  temperate: ["unremarkably humanoid", "bright-plumed", "ridge-crested"],
  gas: ["bulbous and buoyant", "near-transparent", "trailing long filaments"],
};

const NAME_PREFIX: readonly string[] = [
  "Vor", "Kth", "Syl", "Zen", "Qel", "Tarn", "Mol", "Ix", "Drae", "Oph",
  "Cind", "Bly", "Wex", "Ny", "Tha", "Gro", "Esh", "Ul", "Pra", "Yor",
  "Mek", "Sso", "Iri", "Dol", "Vash",
];
const NAME_MID: readonly string[] = ["", "a", "e", "i", "o", "u", "ae", "ya", "el", "or"];
const NAME_SUFFIX: readonly string[] = [
  "ar", "oon", "ix", "eth", "ai", "un", "or", "is", "ans", "ari",
  "ux", "een", "oth", "il", "ess", "ok", "ya", "im",
];

/** A capitalized, multi-syllable species name drawn deterministically. */
function makeName(rng: ReturnType<typeof makeRng>): string {
  const raw = pick(rng, NAME_PREFIX) + pick(rng, NAME_MID) + pick(rng, NAME_SUFFIX);
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * A deterministic minor (procedurally-generated) sapient species for `key` (any
 * stable string — a hub location key, a system key, …). Same `(seed, key)` ⇒
 * byte-identical species. Origin ecology is drawn uniformly, then biases tech +
 * social via the coupling tables, so the DNA reads coherently. Pure: own
 * `makeRng(seed, "species", key)` stream, no `Date`/`Math.random`.
 */
export function minorSpeciesAt(seed: string, key: string): Species {
  const rng = makeRng(seed, "species", key);
  const originWorld = pick(rng, ORIGIN_WORLDS);
  const techAptitude = TECH_APTITUDES[weightedIndex(rng, TECH_WEIGHTS[originWorld])]!;
  const socialStructure = SOCIAL_STRUCTURES[weightedIndex(rng, SOCIAL_WEIGHTS[originWorld])]!;
  const body = pick(rng, BODY_BY_ORIGIN[originWorld]);
  const appearance = pick(rng, APPEARANCE_BY_ORIGIN[originWorld]);
  const name = makeName(rng);
  // Content-based id (name slug). Minor species are not in the dominant catalog,
  // so this never collides with a dominant id (those are lowercase words too,
  // but `isSpeciesId` only matches the curated dominant set).
  const id = `minor-${name.toLowerCase()}`;
  const blurb = `A ${appearance} ${socialStructure} people of ${body} build, ${originWorldBlurb(originWorld)}, with a knack for ${techAptitude}.`;
  return { id, name, blurb, originWorld, techAptitude, socialStructure, body, appearance };
}

/** A short origin-ecology clause for a minor species' blurb. */
function originWorldBlurb(origin: OriginWorld): string {
  switch (origin) {
    case "high-gravity": return "evolved under crushing gravity";
    case "low-gravity": return "born to a feather-light world";
    case "ocean": return "risen from a world of seas";
    case "desert": return "hardened on burning sands";
    case "frozen": return "shaped by endless ice";
    case "volcanic": return "forged on a world of fire";
    case "irradiated": return "thriving under a killing sky";
    case "temperate": return "raised on a gentle world";
    case "gas": return "drifting the skies of a gas giant";
  }
}
