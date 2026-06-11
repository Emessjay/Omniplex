/**
 * The creature genome + ecological web (cascade tier 5a) — the "alive" layer.
 *
 * Fixed wildlife catalogs (`src/lib/game/wildlife.ts`) read the same for every
 * player; this module replaces that with a COMBINATORIAL genome so a player
 * rarely meets the same creature twice, each life-form fits its environment, and
 * a region's life forms a coherent FOOD WEB.
 *
 * A species is `{ archetype, traits, trophicRole, diet }`:
 *  - an **archetype** — a broad, stable body-plan (towering canopy, pack hunter,
 *    …), tagged by its `trophicRole`. The archetype is the future blurb writer's
 *    ANCHOR.
 *  - a set of **traits** — one option per `TRAIT_DIMENSION` (size, locomotion,
 *    defense, …). The archetype + trait combination is the species' identity and
 *    the "scientific facts" a blurb is generated from later. ~30k+ combinations.
 *  - a **diet** — the archetype ids it consumes (empty for producers). This is
 *    what wires the food web: a herbivore's diet references producer archetypes
 *    actually present in its region; a carnivore's diet references prey actually
 *    present.
 *
 * Generation is PURE & deterministic per region coord, on RNG streams DISTINCT
 * from `regionAt`'s (`"genome-flora"` / `"genome-fauna"`), so reading a region's
 * ecology never perturbs the region's biome/temperature/hazard/formation. The
 * generators FILTER on the region's environment — biome, temperature, hazard,
 * galactic radiation, and geology — so a cold region yields cold-adapted species,
 * a high-radiation region radiation-tolerant ones, and so on. Fauna are generated
 * in TROPHIC ORDER (flora → prey → predators → scavengers) with each tier's diet
 * keyed to the tier below, so the web is closed BY CONSTRUCTION (no predators
 * without sustaining prey, no herbivores without flora).
 *
 * **This phase is GENERATION ONLY.** Nothing here is wired into
 * `explore`/`harvest`/`attack`/`ranch` yet — the old `wildlife.ts` gameplay keeps
 * working unchanged. Phase 5b swaps gameplay over to these functions; the Science
 * pillar's breeding and the Nimbus blurb writer build on them too.
 */

import {
  type Biome,
  type PlanetCoord,
  type RegionCoord,
  type RegionFormation,
} from "./types";
import { galacticRadiation, regionAt, RADIATION_MAX } from "./gen";
import { makeRng, randInt, weightedIndex, type Rng } from "./prng";

// ---------------------------------------------------------------------------
// Trophic roles & archetypes.
// ---------------------------------------------------------------------------

/**
 * A species' role in the food web. `producer` = flora (the base of the web,
 * needs no lower level); `herbivore` eats producers; `carnivore` eats other
 * fauna; `omnivore` eats both (a cross-link, counted with prey); `scavenger`
 * consumes carrion (any fauna present).
 */
export const TROPHIC_ROLES = [
  "producer",
  "herbivore",
  "carnivore",
  "omnivore",
  "scavenger",
] as const;
export type TrophicRole = (typeof TROPHIC_ROLES)[number];

/**
 * A broad body-plan, tagged by trophic role and given a (soft) biome preference
 * used only to BIAS selection — an archetype is never hard-excluded from a
 * biome, so a region always has life to find. The stable anchor a generated
 * species hangs its traits (and, later, its blurb) on.
 */
export interface Archetype {
  readonly id: string;
  readonly name: string;
  readonly trophicRole: TrophicRole;
  /** Biomes this body-plan favors (soft preference; empty = generalist). */
  readonly biomes: readonly Biome[];
}

/**
 * The archetype catalog (≥30, role-tagged). Producers (flora body-plans) form
 * the base of every web; herbivores/omnivores are the prey tier; carnivores the
 * predator tier; scavengers the cleanup crew. Biome preferences only weight
 * selection — every role pool is non-empty so generation never stalls.
 */
export const ARCHETYPES: readonly Archetype[] = [
  // ---- Producers (flora body-plans) ----
  { id: "towering_canopy", name: "Towering Canopy", trophicRole: "producer", biomes: ["jungle"] },
  { id: "creeping_groundcover", name: "Creeping Groundcover", trophicRole: "producer", biomes: ["tundra", "barren"] },
  { id: "fungal_bloom", name: "Fungal Bloom", trophicRole: "producer", biomes: ["toxic", "jungle"] },
  { id: "crystalline_symbiote", name: "Crystalline Symbiote", trophicRole: "producer", biomes: ["crystalline", "irradiated"] },
  { id: "floating_frond", name: "Floating Frond", trophicRole: "producer", biomes: ["gas", "ocean"] },
  { id: "carnivorous_snare", name: "Carnivorous Snare", trophicRole: "producer", biomes: ["jungle", "toxic"] },
  { id: "lichen_mat", name: "Lichen Mat", trophicRole: "producer", biomes: ["tundra", "barren"] },
  { id: "succulent_column", name: "Succulent Column", trophicRole: "producer", biomes: ["desert"] },
  { id: "reed_thicket", name: "Reed Thicket", trophicRole: "producer", biomes: ["ocean", "jungle"] },
  { id: "spore_tower", name: "Spore Tower", trophicRole: "producer", biomes: ["toxic", "irradiated"] },
  { id: "tuber_network", name: "Tuber Network", trophicRole: "producer", biomes: ["desert", "barren"] },
  { id: "bladder_kelp", name: "Bladder Kelp", trophicRole: "producer", biomes: ["ocean"] },

  // ---- Herbivores (prey tier) ----
  { id: "grazer", name: "Grazer", trophicRole: "herbivore", biomes: ["tundra", "desert"] },
  { id: "browser", name: "Browser", trophicRole: "herbivore", biomes: ["jungle"] },
  { id: "herd_beast", name: "Herd Beast", trophicRole: "herbivore", biomes: ["tundra", "barren"] },
  { id: "burrower", name: "Burrower", trophicRole: "herbivore", biomes: ["barren", "desert"] },
  { id: "filter_feeder", name: "Filter Feeder", trophicRole: "herbivore", biomes: ["ocean"] },
  { id: "gnawer", name: "Gnawer", trophicRole: "herbivore", biomes: ["jungle", "toxic"] },
  { id: "trundler", name: "Trundler", trophicRole: "herbivore", biomes: ["crystalline", "barren"] },
  { id: "canopy_forager", name: "Canopy Forager", trophicRole: "herbivore", biomes: ["jungle", "gas"] },

  // ---- Carnivores (predator tier) ----
  { id: "pack_hunter", name: "Pack Hunter", trophicRole: "carnivore", biomes: ["tundra", "barren"] },
  { id: "ambush_predator", name: "Ambush Predator", trophicRole: "carnivore", biomes: ["jungle", "ocean"] },
  { id: "pouncer", name: "Pouncer", trophicRole: "carnivore", biomes: ["desert", "barren"] },
  { id: "stalker", name: "Stalker", trophicRole: "carnivore", biomes: ["tundra", "jungle"] },
  { id: "raptor_flyer", name: "Raptor Flyer", trophicRole: "carnivore", biomes: ["gas", "desert"] },
  { id: "armored_colossus", name: "Armored Colossus", trophicRole: "carnivore", biomes: ["volcanic", "irradiated"] },
  { id: "leviathan", name: "Leviathan", trophicRole: "carnivore", biomes: ["ocean"] },
  { id: "lash_hunter", name: "Lash Hunter", trophicRole: "carnivore", biomes: ["toxic", "volcanic"] },
  { id: "venom_striker", name: "Venom Striker", trophicRole: "carnivore", biomes: ["toxic", "desert"] },

  // ---- Omnivores (prey-tier cross-links) ----
  { id: "swarm", name: "Swarm", trophicRole: "omnivore", biomes: ["toxic", "irradiated"] },
  { id: "forager_beast", name: "Forager Beast", trophicRole: "omnivore", biomes: ["jungle", "tundra"] },
  { id: "opportunist", name: "Opportunist", trophicRole: "omnivore", biomes: ["barren", "desert"] },
  { id: "tusked_rooter", name: "Tusked Rooter", trophicRole: "omnivore", biomes: ["jungle", "volcanic"] },
  { id: "shell_crab", name: "Shell Crab", trophicRole: "omnivore", biomes: ["ocean", "crystalline"] },

  // ---- Scavengers (cleanup crew) ----
  { id: "carrion_crawler", name: "Carrion Crawler", trophicRole: "scavenger", biomes: ["barren", "volcanic"] },
  { id: "bone_picker", name: "Bone Picker", trophicRole: "scavenger", biomes: ["desert", "tundra"] },
  { id: "rot_grazer", name: "Rot Grazer", trophicRole: "scavenger", biomes: ["toxic", "jungle"] },
  { id: "dust_sifter", name: "Dust Sifter", trophicRole: "scavenger", biomes: ["barren", "irradiated"] },
] as const;

const ARCHETYPE_BY_ID: ReadonlyMap<string, Archetype> = new Map(
  ARCHETYPES.map((a) => [a.id, a]),
);

/** Every archetype id. */
export const ARCHETYPE_IDS: readonly string[] = ARCHETYPES.map((a) => a.id);

/** Whether `id` is a known archetype id. */
export function isArchetypeId(id: string): boolean {
  return ARCHETYPE_BY_ID.has(id);
}

/** Look up an archetype by id. Throws on unknown (mirrors `getResource`). */
export function getArchetype(id: string): Archetype {
  const a = ARCHETYPE_BY_ID.get(id);
  if (!a) throw new Error(`unknown archetype id: ${id}`);
  return a;
}

/** Every archetype with the given trophic role. */
export function archetypesForRole(role: TrophicRole): Archetype[] {
  return ARCHETYPES.filter((a) => a.trophicRole === role);
}

// ---------------------------------------------------------------------------
// Trait dimensions — the combinatorics.
// ---------------------------------------------------------------------------

/** One axis of variation: an id and its discrete options (≥4 each). */
export interface TraitDimension {
  readonly id: string;
  readonly options: readonly string[];
}

/**
 * The trait dimensions (7 axes, each ≥4 options). The product over these axes
 * (5·6·6·4·5·6·5 ≈ 108k) crossed with ~38 archetypes is the combinatorial space
 * that delivers "rarely the same creature twice". A `Species`'s `traits` carries
 * exactly one option per dimension, assembled in THIS order, so its JSON is
 * stable and two differing combinations compare distinct.
 */
export const TRAIT_DIMENSIONS: readonly TraitDimension[] = [
  { id: "size", options: ["minute", "small", "medium", "large", "colossal"] },
  { id: "locomotion", options: ["sessile", "crawling", "walking", "swimming", "flying", "burrowing"] },
  { id: "defense", options: ["none", "armor", "venom", "camouflage", "speed", "spines"] },
  { id: "temperament", options: ["placid", "skittish", "territorial", "hostile"] },
  { id: "adaptation", options: ["none", "radiation_tolerant", "thermophilic", "cryophilic", "desiccation_resistant"] },
  { id: "integument", options: ["scaled", "furred", "chitinous", "membranous", "crystalline", "slimy"] },
  { id: "reproduction", options: ["spores", "live_birth", "clutch", "budding", "swarm_brood"] },
] as const;

const TRAIT_DIMENSION_BY_ID: ReadonlyMap<string, TraitDimension> = new Map(
  TRAIT_DIMENSIONS.map((d) => [d.id, d]),
);

/** Every trait-dimension id, in assembly order. */
export const TRAIT_DIMENSION_IDS: readonly string[] = TRAIT_DIMENSIONS.map((d) => d.id);

/** The options for a trait dimension. Throws on an unknown dimension id. */
export function traitOptions(dimensionId: string): readonly string[] {
  const d = TRAIT_DIMENSION_BY_ID.get(dimensionId);
  if (!d) throw new Error(`unknown trait dimension: ${dimensionId}`);
  return d.options;
}

// ---------------------------------------------------------------------------
// Species.
// ---------------------------------------------------------------------------

/**
 * A fully-described, recomputable species: a body-plan `archetype` (its
 * `trophicRole` mirrored here for convenience), a `traits` map carrying one
 * option per `TRAIT_DIMENSION`, and a `diet` of the archetype ids it consumes
 * (EMPTY for producers; for fauna, ids that are actually present in the region —
 * this is the food-web edge). Same region coord ⇒ byte-identical species.
 */
export interface Species {
  readonly archetype: string;
  readonly trophicRole: TrophicRole;
  readonly traits: Readonly<Record<string, string>>;
  readonly diet: readonly string[];
}

/**
 * Validate a species against the catalog: a real archetype, a `trophicRole`
 * matching it, every trait dimension present with a valid option, and a diet of
 * real archetype ids. Pure helper for tests/tools.
 */
export function isValidSpecies(species: Species): boolean {
  const archetype = ARCHETYPE_BY_ID.get(species.archetype);
  if (!archetype) return false;
  if (archetype.trophicRole !== species.trophicRole) return false;
  for (const dim of TRAIT_DIMENSIONS) {
    const value = species.traits[dim.id];
    if (value === undefined || !dim.options.includes(value)) return false;
  }
  if (!species.diet.every((id) => ARCHETYPE_BY_ID.has(id))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Environment-filtered trait & archetype selection.
// ---------------------------------------------------------------------------

/** The local environment a region's life is generated to fit. */
interface RegionEnv {
  readonly biome: Biome;
  readonly temperature: number;
  readonly hazard: number;
  readonly radiation: number;
  readonly formation: RegionFormation;
}

/** Temperature below which a region counts as "cold" (favors cryophilic life). */
const COLD_C = 0;
/** Temperature above which a region counts as "hot" (favors thermophilic life). */
const HOT_C = 100;
/** Radiation above which a region favors radiation-tolerant life. */
const HIGH_RADIATION = RADIATION_MAX * 0.5;
/** How strongly the environment skews the `adaptation` trait toward the fitting option. */
const ENV_ADAPT_WEIGHT = 12;
/** Soft archetype biome-preference bonus (added to a base weight of 1). */
const ARCHETYPE_BIOME_BONUS = 3;
/** Soft formation bonus for archetypes whose body-plan suits the geology. */
const FORMATION_LOCOMOTION_BONUS = 2;
/** How much a producer favors the `sessile` locomotion option. */
const PRODUCER_SESSILE_WEIGHT = 12;

/** Burrowing/subterranean formations that favor burrowers & burrowing locomotion. */
const SUBTERRANEAN_FORMATIONS: ReadonlySet<RegionFormation> = new Set([
  "cave_system",
  "tectonic_ridge",
]);

/**
 * Pick one option of a trait `dimension`, weighting by `role` and `env`:
 *  - `adaptation` is strongly skewed toward the option that fits the climate
 *    (cryophilic when cold, thermophilic when hot, radiation_tolerant when
 *    irradiated, desiccation_resistant in deserts) — the main "species suit the
 *    environment" signal.
 *  - `locomotion` favors `sessile` for producers and `burrowing` in
 *    subterranean formations.
 *  - every other dimension is uniform.
 * Consumes exactly one `rng()` draw (a weighted pick), so trait assembly stays
 * deterministic.
 */
function pickTraitOption(
  rng: Rng,
  dimension: TraitDimension,
  role: TrophicRole,
  env: RegionEnv,
): string {
  const weights = dimension.options.map((opt) => {
    if (dimension.id === "adaptation") {
      let w = 1;
      if (opt === "cryophilic" && env.temperature < COLD_C) w += ENV_ADAPT_WEIGHT;
      if (opt === "thermophilic" && env.temperature > HOT_C) w += ENV_ADAPT_WEIGHT;
      if (opt === "radiation_tolerant" && env.radiation > HIGH_RADIATION) w += ENV_ADAPT_WEIGHT;
      if (
        opt === "desiccation_resistant" &&
        (env.biome === "desert" || env.biome === "barren")
      ) {
        w += ENV_ADAPT_WEIGHT / 2;
      }
      return w;
    }
    if (dimension.id === "locomotion") {
      if (role === "producer") return opt === "sessile" ? PRODUCER_SESSILE_WEIGHT : 1;
      let w = 1;
      if (opt === "swimming" && env.biome === "ocean") w += 4;
      if (opt === "flying" && env.biome === "gas") w += 4;
      if (opt === "burrowing" && SUBTERRANEAN_FORMATIONS.has(env.formation)) {
        w += FORMATION_LOCOMOTION_BONUS;
      }
      if (opt === "sessile") w = 0.2; // motile fauna very rarely sessile
      return w;
    }
    return 1;
  });
  return dimension.options[weightedIndex(rng, weights)]!;
}

/**
 * Assemble a full trait map for a species of `role` in `env`, drawing each
 * dimension in `TRAIT_DIMENSIONS` order (so key order — hence JSON — is stable).
 * Consumes exactly one draw per dimension.
 */
function assembleTraits(
  rng: Rng,
  role: TrophicRole,
  env: RegionEnv,
): Record<string, string> {
  const traits: Record<string, string> = {};
  for (const dim of TRAIT_DIMENSIONS) {
    traits[dim.id] = pickTraitOption(rng, dim, role, env);
  }
  return traits;
}

/**
 * Pick an archetype of `role`, weighted toward those whose biome preference
 * matches `env.biome` (and burrowers in subterranean formations). The full role
 * pool is always in play (base weight 1), so selection never fails. One draw.
 */
function pickArchetype(rng: Rng, role: TrophicRole, env: RegionEnv): Archetype {
  const pool = archetypesForRole(role);
  const weights = pool.map((a) => {
    let w = 1;
    if (a.biomes.includes(env.biome)) w += ARCHETYPE_BIOME_BONUS;
    if (a.id === "burrower" && SUBTERRANEAN_FORMATIONS.has(env.formation)) {
      w += FORMATION_LOCOMOTION_BONUS;
    }
    return w;
  });
  return pool[weightedIndex(rng, weights)]!;
}

/**
 * Draw `k` distinct elements of `arr` (or all of them if `k ≥ arr.length`),
 * using `rng`. Deterministic given the stream; consumes `min(k, arr.length)`
 * draws. Used to wire a fauna's diet to a non-empty subset of the archetypes
 * present at the tier below it.
 */
function sampleDistinct(rng: Rng, arr: readonly string[], k: number): string[] {
  const pool = [...arr];
  const n = Math.min(k, pool.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return out;
}

/** Distinct archetype ids present in a species list (preserves first-seen order). */
function distinctArchetypes(species: readonly Species[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sp of species) {
    if (!seen.has(sp.archetype)) {
      seen.add(sp.archetype);
      out.push(sp.archetype);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-region ecology generation.
// ---------------------------------------------------------------------------

/** A planet coord from a region coord (drops the region index). */
function planetOf(coord: RegionCoord): PlanetCoord {
  return {
    galaxy: coord.galaxy,
    arm: coord.arm,
    cluster: coord.cluster,
    system: coord.system,
    planet: coord.planet,
  };
}

/** Resolve the local environment of a region (pure read of `regionAt`/radiation). */
function regionEnv(seed: string, coord: RegionCoord): RegionEnv {
  const region = regionAt(seed, planetOf(coord), coord.region);
  return {
    biome: region.biome,
    temperature: region.temperature,
    hazard: region.hazard,
    radiation: galacticRadiation(coord.cluster),
    formation: region.formation,
  };
}

/** Species-count bounds per region (before the hazard penalty). */
const FLORA_MIN = 2;
const FLORA_MAX = 5;
const PREY_MAX = 4;
const PREDATOR_MAX = 3;

/** Harsher (higher-hazard) regions sustain fewer species. */
function harshnessPenalty(hazard: number): number {
  return Math.floor(Math.max(0, Math.min(1, hazard)) * 2);
}

/**
 * The producer (flora) species of a region — the base of its food web. Pure &
 * deterministic on the `"genome-flora"` stream (distinct from `regionAt`'s, so
 * it never perturbs region generation). Always returns ≥1 producer (a region is
 * never lifeless at the base), up to `FLORA_MAX`, fewer on harsh worlds. Each
 * producer's archetype is weighted toward the region's biome and its
 * `adaptation` trait toward the region's climate, so the flora suits the
 * environment.
 */
export function regionFlora(seed: string, coord: RegionCoord): Species[] {
  const env = regionEnv(seed, coord);
  const rng = makeRng(
    seed,
    "genome-flora",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
    coord.region,
  );
  const penalty = harshnessPenalty(env.hazard);
  const count = Math.max(1, Math.min(FLORA_MAX, randInt(rng, FLORA_MIN, FLORA_MAX) - penalty));
  const flora: Species[] = [];
  for (let i = 0; i < count; i++) {
    const archetype = pickArchetype(rng, "producer", env);
    const traits = assembleTraits(rng, "producer", env);
    flora.push({ archetype: archetype.id, trophicRole: "producer", traits, diet: [] });
  }
  return flora;
}

/**
 * The fauna species of a region, generated in TROPHIC ORDER so the food web is
 * closed by construction. Pure & deterministic on the `"genome-fauna"` stream
 * (distinct from `regionAt`'s):
 *  1. **Prey** (herbivores + omnivores) — only if flora is present; each one's
 *     `diet` references producer archetypes actually present (`regionFlora`).
 *  2. **Predators** (carnivores) — only if prey is present; each one's `diet`
 *     references prey archetypes actually present.
 *  3. **Scavengers** — only if any fauna is present; `diet` references fauna
 *     archetypes present.
 * So there are never predators without sustaining prey, nor herbivores without
 * flora (AC#3). Counts shrink on harsher worlds. Archetype/adaptation selection
 * is environment-weighted exactly like `regionFlora`.
 */
export function regionFauna(seed: string, coord: RegionCoord): Species[] {
  const env = regionEnv(seed, coord);
  const flora = regionFlora(seed, coord);
  const floraArchetypes = distinctArchetypes(flora);
  const rng = makeRng(
    seed,
    "genome-fauna",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
    coord.region,
  );
  const penalty = harshnessPenalty(env.hazard);
  const fauna: Species[] = [];

  // (1) Prey tier — herbivores + omnivores keyed to the flora present.
  const preyList: Species[] = [];
  const preyCount =
    floraArchetypes.length > 0 ? Math.max(0, randInt(rng, 1, PREY_MAX) - penalty) : 0;
  for (let i = 0; i < preyCount; i++) {
    const role: TrophicRole = rng() < 0.7 ? "herbivore" : "omnivore";
    const archetype = pickArchetype(rng, role, env);
    const traits = assembleTraits(rng, role, env);
    const dietSize = randInt(rng, 1, Math.min(2, floraArchetypes.length));
    const diet = sampleDistinct(rng, floraArchetypes, dietSize);
    const sp: Species = { archetype: archetype.id, trophicRole: role, traits, diet };
    preyList.push(sp);
    fauna.push(sp);
  }

  // (2) Predator tier — carnivores keyed to the prey present.
  const preyArchetypes = distinctArchetypes(preyList);
  const predatorCount =
    preyArchetypes.length > 0 ? Math.max(0, randInt(rng, 0, PREDATOR_MAX) - penalty) : 0;
  const predatorList: Species[] = [];
  for (let i = 0; i < predatorCount; i++) {
    const archetype = pickArchetype(rng, "carnivore", env);
    const traits = assembleTraits(rng, "carnivore", env);
    const dietSize = randInt(rng, 1, Math.min(2, preyArchetypes.length));
    const diet = sampleDistinct(rng, preyArchetypes, dietSize);
    const sp: Species = { archetype: archetype.id, trophicRole: "carnivore", traits, diet };
    predatorList.push(sp);
    fauna.push(sp);
  }

  // (3) Scavenger tier — keyed to any fauna present (a closed cleanup link).
  const faunaArchetypes = distinctArchetypes([...preyList, ...predatorList]);
  const scavengerCount = faunaArchetypes.length > 0 ? randInt(rng, 0, 1) : 0;
  for (let i = 0; i < scavengerCount; i++) {
    const archetype = pickArchetype(rng, "scavenger", env);
    const traits = assembleTraits(rng, "scavenger", env);
    const diet = sampleDistinct(rng, faunaArchetypes, 1);
    fauna.push({ archetype: archetype.id, trophicRole: "scavenger", traits, diet });
  }

  return fauna;
}

// ---------------------------------------------------------------------------
// Drops — bounded materials (no material explosion).
// ---------------------------------------------------------------------------

/**
 * The material a species yields when harvested/killed, and how much — a PURE,
 * deterministic function of the species' role + traits (no rng). The species is
 * the variety/flavor; the economic output stays a BOUNDED, sane set drawn
 * entirely from the existing `MATERIALS` catalog:
 *  - producers → plant materials (`luminous_spores` for crystalline/luminous
 *    flora, else `ironbark_resin`);
 *  - fauna → animal materials chosen by trait (venom → `venom_gland`; armor/
 *    spines → `thick_hide`; furred → `woolly_fleece`; thermophilic → `ember_tallow`;
 *    big-bodied → `coarse_sinew`/`tender_loin`; else `scaled_hide`).
 * `qty` is ≥1, bumped by one for large/colossal bodies. Every returned
 * `materialId` is a real `MATERIALS` id (AC#5).
 */
export function speciesDrop(species: Species): { materialId: string; qty: number } {
  const { trophicRole, traits } = species;
  const size = traits.size;
  const qty = 1 + (size === "large" || size === "colossal" ? 1 : 0);

  if (trophicRole === "producer") {
    const materialId =
      traits.integument === "crystalline" || traits.integument === "membranous"
        ? "luminous_spores"
        : "ironbark_resin";
    return { materialId, qty };
  }

  // Fauna — pick an animal material by trait, in priority order.
  let materialId: string;
  if (traits.defense === "venom") materialId = "venom_gland";
  else if (traits.defense === "armor" || traits.defense === "spines") materialId = "thick_hide";
  else if (traits.integument === "furred") materialId = "woolly_fleece";
  else if (traits.adaptation === "thermophilic") materialId = "ember_tallow";
  else if (size === "colossal") materialId = "coarse_sinew";
  else if (size === "large") materialId = "tender_loin";
  else materialId = "scaled_hide";
  return { materialId, qty };
}

// ---------------------------------------------------------------------------
// Descriptive labels — a placeholder for the future Nimbus blurb writer.
// ---------------------------------------------------------------------------

/** Size words that read naturally as a leading adjective (others are dropped). */
const SIZE_ADJECTIVE: Readonly<Record<string, string>> = {
  minute: "minute",
  tiny: "tiny",
  small: "small",
  large: "large",
  big: "huge",
  huge: "huge",
  colossal: "colossal",
};

/** Defense → a descriptive adjective (the most "visible" trait of a creature). */
const DEFENSE_ADJECTIVE: Readonly<Record<string, string>> = {
  armor: "armored",
  venom: "venomous",
  spines: "spiny",
  camouflage: "camouflaged",
  speed: "swift",
};

/**
 * A short, descriptive label for a species built from its archetype + key
 * traits — e.g. "large armored grazer", "venomous ambush predator". A
 * deterministic PLACEHOLDER until the Nimbus blurb writer prose-ifies a species
 * from the same trait facts. No article (callers add "a"/"an"). Pure.
 */
export function speciesLabel(species: Species): string {
  const archetype = ARCHETYPE_BY_ID.get(species.archetype);
  const noun = (archetype?.name ?? species.archetype).toLowerCase();
  const parts: string[] = [];
  const sizeAdj = SIZE_ADJECTIVE[species.traits.size ?? ""];
  if (sizeAdj) parts.push(sizeAdj);
  const defenseAdj = DEFENSE_ADJECTIVE[species.traits.defense ?? ""];
  if (defenseAdj) parts.push(defenseAdj);
  parts.push(noun);
  return parts.join(" ");
}

/** The indefinite article ("a"/"an") for a phrase, by its first letter. */
export function speciesArticle(label: string): string {
  return /^[aeiou]/i.test(label.trim()) ? "an" : "a";
}
