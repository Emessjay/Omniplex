/**
 * Deterministic, seed-based procedural universe generator.
 *
 * `systemAt(seed, coord)` and `planetAt(seed, coord)` are PURE functions of
 * their arguments: same seed + same coords ⇒ deeply-equal output, forever,
 * across processes (AC#1). Nothing is stored — the whole galaxy is recomputed
 * on demand. All randomness comes from `makeRng`, which hashes the seed and
 * coordinates into a deterministic PRNG stream.
 *
 * Design note on the hazard→rarity coupling (AC#5): a planet's deposits are
 * drawn from the catalog with weights that depend on both the planet's hazard
 * and each resource's rarity. Calm worlds favor common metals; savage worlds
 * favor rare ones, and legendary voidstone is effectively gated behind the
 * most savage hazards. See `depositsFor` below.
 */

import {
  ATMOSPHERES,
  BIOMES,
  MAX_PLANETS,
  STAR_CLASSES,
  type Atmosphere,
  type Biome,
  type Planet,
  type PlanetCoord,
  type ResourceDeposit,
  type StarClass,
  type StarSystem,
  type SystemCoord,
} from "./types";
import { RESOURCES } from "./resources";
import {
  makeRng,
  pick,
  randFloat,
  randInt,
  weightedIndex,
  type Rng,
} from "./prng";

// ---------------------------------------------------------------------------
// Location keys (AC#7). Compact, stable, colon-delimited. These strings are
// the keys used by world_deltas / discoveries / markets rows, so the format
// must not drift.
// ---------------------------------------------------------------------------

/** `"<sector>:<system>"` */
export function systemKey(coord: SystemCoord): string {
  return `${coord.sector}:${coord.system}`;
}

/** `"<sector>:<system>:<planet>"` */
export function planetKey(coord: PlanetCoord): string {
  return `${coord.sector}:${coord.system}:${coord.planet}`;
}

/**
 * Parse a system or planet key back into its coord object. Two segments →
 * `SystemCoord`; three → `PlanetCoord`. Throws on malformed input.
 */
export function parseLocationKey(key: string): SystemCoord | PlanetCoord {
  const parts = key.split(":");
  const nums = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n)) {
      throw new Error(`invalid location key segment: ${p} in ${key}`);
    }
    return n;
  });
  if (nums.length === 2) {
    return { sector: nums[0]!, system: nums[1]! };
  }
  if (nums.length === 3) {
    return { sector: nums[0]!, system: nums[1]!, planet: nums[2]! };
  }
  throw new Error(`invalid location key: ${key}`);
}

// ---------------------------------------------------------------------------
// Navigation (AC#8).
// ---------------------------------------------------------------------------

/** Galaxy-space distance between sectors, so cross-sector jumps cost more. */
const SECTOR_SPAN = 100;

/**
 * Distance between two systems. 0 to self, symmetric, positive between
 * distinct systems. Euclidean over (sector·SECTOR_SPAN, system) so a hop to a
 * neighboring system is cheap and a sector change is a long haul. Fuel-cost
 * scaling off this is `command-core`'s concern.
 */
export function warpDistance(a: SystemCoord, b: SystemCoord): number {
  const dx = (a.sector - b.sector) * SECTOR_SPAN;
  const dy = a.system - b.system;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Naming.
// ---------------------------------------------------------------------------

/** Catalog-style stellar designation prefixes (flavor only). */
const STAR_PREFIXES = [
  "KEPLER",
  "GLIESE",
  "TRAPPIST",
  "WOLF",
  "ROSS",
  "PROXIMA",
  "SIRIUS",
  "VEGA",
  "RIGEL",
  "ALTAIR",
  "TAU",
  "ZETA",
] as const;

/** Deterministic system name, e.g. "KEPLER-442". */
function systemName(rng: Rng): string {
  const prefix = pick(rng, STAR_PREFIXES);
  // A 3–4 digit catalog number derived deterministically from the stream.
  const num = randInt(rng, 100, 9999);
  return `${prefix}-${num}`;
}

/** Planet name from its system + index: "KEPLER-442b", "…c", … (a is the star). */
function planetName(sysName: string, planetIndex: number): string {
  return `${sysName}${String.fromCharCode(98 + planetIndex)}`;
}

// ---------------------------------------------------------------------------
// Star class — weighted toward cooler, more common stars (M/K/G), which also
// shifts the temperature baseline for their planets.
// ---------------------------------------------------------------------------

const STAR_CLASS_WEIGHTS: Record<StarClass, number> = {
  O: 1,
  B: 3,
  A: 6,
  F: 12,
  G: 20,
  K: 28,
  M: 30,
};

/** Rough relative surface-temperature offset (°C) contributed by the star. */
const STAR_TEMP_BASE: Record<StarClass, number> = {
  O: 600,
  B: 450,
  A: 300,
  F: 180,
  G: 90,
  K: 20,
  M: -40,
};

function starClassFor(rng: Rng): StarClass {
  const weights = STAR_CLASSES.map((c) => STAR_CLASS_WEIGHTS[c]);
  return STAR_CLASSES[weightedIndex(rng, weights)]!;
}

// ---------------------------------------------------------------------------
// Hazard — coupled to temperature extremity.
//
// Hazard rises *rapidly* as a planet's mean temperature departs from a
// temperate "comfort band" toward either extreme — scorching or frozen worlds
// come out markedly more savage, while temperate worlds stay low-hazard. A
// modest random jitter rides on top so two similar-temperature worlds still
// differ (and so the distribution keeps enough spread for both calm and savage
// planets to exist). Via the hazard→rarity coupling below, the most extreme
// worlds therefore also carry the rarest resources.
// ---------------------------------------------------------------------------

/** Center of the comfortable temperature band (°C) — roughly Earth-like. */
const TEMP_COMFORT_MID = 15;
/** Half-width of the comfort band (°C); within ±this of the mid, no temp hazard. */
const TEMP_COMFORT_BAND = 50;
/** Temperature departure *beyond the band* (°C) that maps to full extremity. */
const TEMP_EXTREME_SCALE = 200;
/** Exponent on normalized extremity; >1 makes hazard climb sharply at the edges. */
const TEMP_HAZARD_POWER = 1.5;
/** Share of the [0,1] hazard range the temperature term commands. */
const TEMP_HAZARD_WEIGHT = 0.9;
/** Max random jitter added on top (keeps similar-temperature worlds distinct). */
const HAZARD_JITTER = 0.25;

/**
 * Derive hazard in [0, 1] from a planet's temperature plus a small random
 * jitter. We take the temperature's distance *outside* the comfort band,
 * normalize it over `TEMP_EXTREME_SCALE`, and raise it to `TEMP_HAZARD_POWER`
 * (>1) so danger ramps up fast for very hot / very cold worlds while temperate
 * worlds stay near zero. The jitter is the only random component, so the curve
 * is otherwise a pure function of temperature. Result is clamped to [0, 1].
 */
function hazardFor(rng: Rng, temperature: number): number {
  const departure = Math.max(
    0,
    Math.abs(temperature - TEMP_COMFORT_MID) - TEMP_COMFORT_BAND,
  );
  const normalized = Math.min(1, departure / TEMP_EXTREME_SCALE);
  const extremity = Math.pow(normalized, TEMP_HAZARD_POWER);
  const jitter = rng() * HAZARD_JITTER;
  const hazard = extremity * TEMP_HAZARD_WEIGHT + jitter;
  return Math.min(1, Math.max(0, hazard));
}

// ---------------------------------------------------------------------------
// Deposits — the hazard→rarity coupling (AC#5).
// ---------------------------------------------------------------------------

/**
 * Weight of a resource of the given `rarity` appearing on a planet of the
 * given `hazard`. A Gaussian centered on a hazard-driven "preferred rarity":
 * calm worlds (hazard≈0) center near rarity 1, savage worlds (hazard≈1) near
 * rarity 5. The narrow width makes the coupling sharp — legendary voidstone
 * (rarity 5) gets effectively zero weight on calm worlds and real weight only
 * as hazard climbs toward 1.
 */
function rarityWeight(rarity: number, hazard: number): number {
  const center = 1 + 4 * hazard; // hazard 0→1 maps to preferred rarity 1→5
  const spread = 1.1; // smaller = sharper coupling
  const d = rarity - center;
  return Math.exp(-(d * d) / (2 * spread * spread));
}

/**
 * Draw the deposits for a planet. Most planets get 1–3 deposits; a minority
 * are barren. Each slot picks a distinct resource weighted by
 * `rarityWeight(rarity, hazard)`, so the resource mix shifts with hazard.
 */
function depositsFor(rng: Rng, hazard: number): ResourceDeposit[] {
  // 0:barren  1  2  3  — most planets carry at least one deposit (>0.5).
  const slots = [1, 1, 2, 2, 2, 3, 3, 0][randInt(rng, 0, 7)]!;
  if (slots === 0) return [];

  const available = RESOURCES.slice();
  const deposits: ResourceDeposit[] = [];
  for (let i = 0; i < slots && available.length > 0; i++) {
    const weights = available.map((r) => rarityWeight(r.rarity, hazard));
    const idx = weightedIndex(rng, weights);
    const resource = available[idx]!;
    available.splice(idx, 1); // distinct resource per slot

    // Abundance in (0, 1], biased by rarity so common ore forms richer veins
    // and rare ore forms leaner ones: the upper bound of the random draw
    // shrinks as rarity climbs (rarity 1→full range, rarity 5→a low ceiling).
    // The draw keeps a random component, so veins still vary; only the
    // expected abundance trends down (monotonically) with rarity.
    const rarityBias = 1 - 0.15 * (resource.rarity - 1); // 1.0 at r1 → 0.4 at r5
    const richness = randFloat(rng, 0.1, 1) * rarityBias;
    const abundance = Math.min(1, richness);
    deposits.push({ resourceId: resource.id, abundance });
  }
  return deposits;
}

// ---------------------------------------------------------------------------
// Planet & system generation.
// ---------------------------------------------------------------------------

/** Surface biomes, weighted so the galaxy is varied but barren/desert common. */
const BIOME_WEIGHTS: Record<Biome, number> = {
  barren: 16,
  desert: 12,
  tundra: 10,
  ocean: 9,
  jungle: 8,
  volcanic: 8,
  toxic: 7,
  crystalline: 6,
  gas: 8,
  irradiated: 6,
};

function biomeFor(rng: Rng): Biome {
  const weights = BIOMES.map((b) => BIOME_WEIGHTS[b]);
  return BIOMES[weightedIndex(rng, weights)]!;
}

function atmosphereFor(rng: Rng): Atmosphere {
  return pick(rng, ATMOSPHERES);
}

/**
 * Generate a single planet. Pure in (seed, coord, starClass): the star class
 * is passed in (derived once per system) so the planet's temperature can
 * reflect its sun while the planet keeps its own independent RNG stream keyed
 * by its planet key — that independence is what lets `planetAt` reproduce a
 * planet without regenerating sibling planets.
 */
function generatePlanet(
  seed: string,
  coord: PlanetCoord,
  sysName: string,
  starClass: StarClass,
): Planet {
  const rng = makeRng(seed, "planet", coord.sector, coord.system, coord.planet);

  const biome = biomeFor(rng);
  const atmosphere = atmosphereFor(rng);
  const gravity = Number(randFloat(rng, 0.1, 2.8).toFixed(3)); // g, (0,10]
  // Temperature first — hazard is derived from it (extreme temps ⇒ savage).
  const temperature = Number(
    (STAR_TEMP_BASE[starClass] + randFloat(rng, -120, 120)).toFixed(1),
  );
  const hazard = Number(hazardFor(rng, temperature).toFixed(4));
  const deposits = depositsFor(rng, hazard).map((d) => ({
    resourceId: d.resourceId,
    abundance: Number(d.abundance.toFixed(4)),
  }));

  return {
    coord,
    name: planetName(sysName, coord.planet),
    biome,
    atmosphere,
    gravity,
    hazard,
    temperature,
    deposits,
  };
}

/**
 * The star system at `coord`: its name, star class, planet count, and the
 * full list of planets (each planet's `coord.planet` equals its index).
 */
export function systemAt(seed: string, coord: SystemCoord): StarSystem {
  const rng = makeRng(seed, "system", coord.sector, coord.system);

  const name = systemName(rng);
  const starClass = starClassFor(rng);
  const planetCount = randInt(rng, 1, MAX_PLANETS);

  const planets: Planet[] = [];
  for (let p = 0; p < planetCount; p++) {
    planets.push(
      generatePlanet(seed, { ...coord, planet: p }, name, starClass),
    );
  }

  return { coord, name, starClass, planetCount, planets };
}

/**
 * The planet at `coord`. Equivalent to `systemAt(seed, coord).planets[planet]`
 * — it regenerates the system's name/star (cheap, deterministic) and the one
 * requested planet, so it agrees exactly with the system's planet list.
 */
export function planetAt(seed: string, coord: PlanetCoord): Planet {
  const sysRng = makeRng(seed, "system", coord.sector, coord.system);
  const name = systemName(sysRng);
  const starClass = starClassFor(sysRng);
  return generatePlanet(seed, coord, name, starClass);
}
