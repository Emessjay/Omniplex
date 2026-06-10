/**
 * Core types and enums for the procedural universe.
 *
 * `BIOMES` and `ATMOSPHERES` are exported readonly arrays that are the source
 * of truth for the `Biome` / `Atmosphere` unions — the generator and tests
 * both validate membership against them, so adding a value in one place keeps
 * everything consistent.
 */

import type { ResourceId } from "./resources";

/** Planet surface archetypes. Source of truth for the `Biome` union. */
export const BIOMES = [
  "barren",
  "ocean",
  "jungle",
  "desert",
  "tundra",
  "volcanic",
  "toxic",
  "crystalline",
  "gas",
  "irradiated",
] as const;
export type Biome = (typeof BIOMES)[number];

/** Atmospheric compositions. Source of truth for the `Atmosphere` union. */
export const ATMOSPHERES = [
  "none",
  "thin",
  "breathable",
  "toxic",
  "corrosive",
  "inert",
  "dense",
] as const;
export type Atmosphere = (typeof ATMOSPHERES)[number];

/** Stellar spectral classes, hottest (O) to coolest (M). */
export const STAR_CLASSES = ["O", "B", "A", "F", "G", "K", "M"] as const;
export type StarClass = (typeof STAR_CLASSES)[number];

/**
 * Physical planet size classes, grounded in the Kopparapu (2018, ApJ 856)
 * occurrence data. Ordered small → large; the radius (R⊕) boundaries are:
 * Rocky 0.5–1, Super-Earth 1–1.75, Sub-Neptune 1.75–3.5, Sub-Jovian 3.5–6,
 * Jovian 6–14.3. A planet's `radius` is sampled from the paper's size
 * occurrence and its class follows from which band it lands in. Worlds at
 * `radius >= 1.75 R⊕` (Sub-Neptune and up) are GAS giants — orbit-only, with no
 * surface (no biomes/regions/deposits); smaller worlds are ROCKY.
 */
export const SIZE_CLASSES = [
  "rocky",
  "super_earth",
  "sub_neptune",
  "sub_jovian",
  "jovian",
] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** Human-readable size-class labels for display (`scan`/`map`/`inventory`). */
export const SIZE_CLASS_LABELS: Record<SizeClass, string> = {
  rocky: "Rocky",
  super_earth: "Super-Earth",
  sub_neptune: "Sub-Neptune",
  sub_jovian: "Sub-Jovian",
  jovian: "Jovian",
};

/**
 * The radius (R⊕) at and above which a planet is a GAS giant rather than a
 * ROCKY world. Sub-Neptune and larger (≥ 1.75) are gas: orbit-only, no surface.
 */
export const GAS_RADIUS_THRESHOLD = 1.75;

/** Largest number of planets a system may hold (AC#4). */
export const MAX_PLANETS = 8;

/**
 * Region-count bounds. A planet is subdivided into many regions (its
 * `regionCount`), each with its own biome + deposits. The count is rolled
 * LOG-uniformly across `[REGION_COUNT_MIN, REGION_COUNT_MAX]` so planet sizes
 * span ~10²–10⁵ and vary wildly.
 */
export const REGION_COUNT_MIN = 100;
export const REGION_COUNT_MAX = 100_000;

/**
 * Per-planet biome palette size bounds. Each planet picks a distinct subset of
 * `BIOMES` of size in `[PALETTE_MIN, PALETTE_MAX]`; its regions only ever draw
 * their biome from that palette, giving each world a coherent-but-varied look.
 *
 * `PALETTE_MIN` is 1 because palette SIZE is now coupled to temperature
 * extremity (`biome-consistency` phase): temperature-extreme worlds (very hot /
 * very cold) collapse toward a single, coherent biome, while moderate worlds
 * spread up to `PALETTE_MAX`. Gas giants are also size-1 (`["gas"]`, exclusive).
 */
export const PALETTE_MIN = 1;
export const PALETTE_MAX = 4;

/**
 * Per-galaxy spiral-arm count bounds. A galaxy's `armCount` is rolled uniformly
 * in `[ARM_COUNT_MIN, ARM_COUNT_MAX]` (deterministic per galaxy), and arm
 * indices are canonical modulo that count — warping to arm `armCount` lands on
 * arm 0, and arm distance wraps symmetrically around the ring.
 */
export const ARM_COUNT_MIN = 2;
export const ARM_COUNT_MAX = 16;

/**
 * Integer six-tier address of a star system, matching the `players` columns
 * (`galaxy`, `arm`, `cluster`, `system`). The hierarchy is
 * `galaxy → arm → cluster → system → planet → region`:
 *  - `galaxy`  ≥ 0, UNBOUNDED (effectively infinite outward). Inter-galaxy
 *    travel is a later phase; for now everyone is in galaxy 0.
 *  - `arm`     a RING within the galaxy, canonical in `[0, armCount)`; indices
 *    wrap modulo the galaxy's `armCount` (see `galaxyAt`).
 *  - `cluster` ≥ 0, index of a cluster within an arm (was `sector`).
 *  - `system`  ≥ 0, index of a system within a cluster.
 */
export interface SystemCoord {
  readonly galaxy: number;
  readonly arm: number;
  readonly cluster: number;
  readonly system: number;
}

/**
 * Address of a CLUSTER (a `SystemCoord` minus its `system`): the cloud of
 * `STARS_PER_CLUSTER` stars a `system` index addresses into. Used by the
 * per-cluster star-position generator (`clusterStars` / `systemPosition` /
 * `systemFromPosition`).
 */
export interface ClusterCoord {
  readonly galaxy: number;
  readonly arm: number;
  readonly cluster: number;
}

/**
 * A star's floating-point position within its cluster (`star-coordinates`).
 * Sampled from an isotropic Gaussian cloud centered on the cluster origin and
 * ROUNDED to 2 decimals (so two stars never share a position, and a coordinate
 * warp is an exact 2-dp match). Each `system` index `0..STARS_PER_CLUSTER-1`
 * maps to exactly one of these.
 */
export interface StarPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Integer six-tier address of a planet; `planet` is its 0-based index. */
export interface PlanetCoord extends SystemCoord {
  readonly planet: number;
}

/**
 * Integer six-tier address of a region within a planet; `region` is its 0-based
 * index in `[0, planet.regionCount)`. The full six-integer location key.
 */
export interface RegionCoord extends PlanetCoord {
  readonly region: number;
}

/**
 * A deterministically-generated galaxy: its index, a flavor name, and the
 * number of spiral arms it has (`[ARM_COUNT_MIN, ARM_COUNT_MAX]`). Different
 * galaxies have different arm counts, so arm-wrap distance is galaxy-relative.
 */
export interface Galaxy {
  readonly index: number;
  readonly name: string;
  readonly armCount: number;
}

/** A resource deposit on a planet: which resource and how rich (0..1). */
export interface ResourceDeposit {
  readonly resourceId: ResourceId;
  /** Relative abundance / yield potential, in [0, 1]. */
  readonly abundance: number;
}

/**
 * A fully-described, recomputable planet.
 *
 * A planet is NOT a single place: it is subdivided into `regionCount` regions,
 * each with its own biome (drawn from `biomePalette`) and its own deposits (see
 * `Region` / `regionAt`). The planet itself therefore no longer carries a
 * single `biome` or `deposits` — those moved down to the region tier. The
 * planet-level fields (`temperature`, `hazard`, `gravity`, `atmosphere`) still
 * describe the whole world (e.g. the landing gate reads `temperature`).
 */
export interface Planet {
  readonly coord: PlanetCoord;
  /** Deterministic, human-readable name, e.g. "KEPLER-442b". */
  readonly name: string;
  /**
   * Physical radius in Earth radii (R⊕), sampled from the Kopparapu (2018) size
   * occurrence; in `[0.5, 14.3]`. Drives `sizeClass`, the rocky/gas split, and
   * (via the paper's per-size zone mix) the planet's `temperature`.
   */
  readonly radius: number;
  /** Size class implied by `radius` (Rocky … Jovian). */
  readonly sizeClass: SizeClass;
  /**
   * Whether this is a GAS giant (`radius >= GAS_RADIUS_THRESHOLD`). Gas giants
   * are ORBIT-ONLY: `biomePalette` is exactly `["gas"]`, `regionCount` is 0, and
   * they carry no surface regions/deposits — you orbit and `scan` them but can't
   * disembark/mine/build there. Rocky worlds (`isGas === false`) have a full
   * surface (palette / regions / deposits) as before.
   */
  readonly isGas: boolean;
  /**
   * The distinct subset of `BIOMES` (size `[PALETTE_MIN, PALETTE_MAX]`) that
   * this planet's regions may draw their biome from. For a gas giant this is
   * exactly `["gas"]` and there are no regions to draw it for.
   */
  readonly biomePalette: readonly Biome[];
  /**
   * Number of surface regions on this planet. A rocky world has an integer in
   * `[REGION_COUNT_MIN, REGION_COUNT_MAX]`; a GAS giant has 0 (no surface).
   */
  readonly regionCount: number;
  readonly atmosphere: Atmosphere;
  /** Surface gravity in g; (0, 10]. */
  readonly gravity: number;
  /** Environmental danger in [0, 1]; high = "savage". */
  readonly hazard: number;
  /** Mean surface temperature in °C (finite). */
  readonly temperature: number;
  /**
   * Orbital mechanics (deterministic per planet coord; time is NEVER stored
   * here). Planets actually orbit their sun in real time, so the distance
   * between two planets — and the regular-fuel cost of flying between them
   * (`land`) — varies with WHEN you travel. The pure helpers in `rules.ts`
   * (`planetPosition` / `interplanetaryDistance`) take these three fields plus a
   * `timeMs` and compute the current position/separation.
   *
   *  - `orbitalRadius` — distance from the sun in AU-ish units, in
   *    `[ORBIT_RADIUS_MIN, ORBIT_RADIUS_MAX]`.
   *  - `orbitalPeriod` — the length of this planet's year, in MILLISECONDS of
   *    REAL time, in `[ORBIT_PERIOD_MIN_MS, ORBIT_PERIOD_MAX_MS]` (≈6h→30d), so
   *    orbits visibly shift over hours-to-weeks of wall-clock time.
   *  - `orbitalPhase` — its starting angle at t=0, in `[0, 2π)`.
   */
  readonly orbitalRadius: number;
  readonly orbitalPeriod: number;
  readonly orbitalPhase: number;
}

/**
 * A fully-described, recomputable region of a planet. Its `biome` is always a
 * member of the planet's `biomePalette`. The region carries its OWN
 * `temperature` and `hazard`, derived from the planet's by a small per-biome
 * offset (`biomeTempOffset` / `biomeHazardOffset`): a `volcanic` region reads
 * hotter and more hazardous than a `barren` one on the same world. The
 * temperature offset is CLAMPED so a region never crosses the 0°C / 100°C lines
 * its planet sits on (a moderate planet's regions stay in [0,100], a boiling
 * planet's stay > 100, a freezing planet's stay < 0) — so region variation can
 * never flip the planet-level landing category. `deposits` are rolled with the
 * REGION's hazard, so the savage→rare coupling now bites per-region.
 */
export interface Region {
  readonly coord: RegionCoord;
  readonly biome: Biome;
  /** Mean surface temperature of THIS region in °C (planet temp ± biome offset, band-clamped). */
  readonly temperature: number;
  /** Environmental danger of THIS region in [0, 1] (planet hazard ± biome offset). */
  readonly hazard: number;
  /** Harvestable deposits; may be empty (barren), usually ≥1. */
  readonly deposits: readonly ResourceDeposit[];
}

/** A fully-described, recomputable star system. */
export interface StarSystem {
  readonly coord: SystemCoord;
  /** Deterministic, human-readable name, e.g. "KEPLER-442". */
  readonly name: string;
  readonly starClass: StarClass;
  /**
   * The star's floating-point position within its cluster (`star-coordinates`),
   * from `systemPosition(seed, coord)`. Intra-cluster `warpDistance` is the
   * Euclidean distance between two systems' positions.
   */
  readonly position: StarPosition;
  /** Number of planets; in [1, MAX_PLANETS]. */
  readonly planetCount: number;
  /** The system's planets; `planets.length === planetCount`. */
  readonly planets: readonly Planet[];
}
