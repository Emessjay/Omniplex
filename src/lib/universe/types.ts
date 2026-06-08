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
 */
export const PALETTE_MIN = 2;
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
   * The distinct subset of `BIOMES` (size `[PALETTE_MIN, PALETTE_MAX]`) that
   * this planet's regions may draw their biome from.
   */
  readonly biomePalette: readonly Biome[];
  /** Number of regions on this planet; integer in `[REGION_COUNT_MIN, REGION_COUNT_MAX]`. */
  readonly regionCount: number;
  readonly atmosphere: Atmosphere;
  /** Surface gravity in g; (0, 10]. */
  readonly gravity: number;
  /** Environmental danger in [0, 1]; high = "savage". */
  readonly hazard: number;
  /** Mean surface temperature in °C (finite). */
  readonly temperature: number;
}

/**
 * A fully-described, recomputable region of a planet. Its `biome` is always a
 * member of the planet's `biomePalette`; its `deposits` are rolled with the
 * planet's hazard (so the savage→rare coupling carries down to the region).
 */
export interface Region {
  readonly coord: RegionCoord;
  readonly biome: Biome;
  /** Harvestable deposits; may be empty (barren), usually ≥1. */
  readonly deposits: readonly ResourceDeposit[];
}

/** A fully-described, recomputable star system. */
export interface StarSystem {
  readonly coord: SystemCoord;
  /** Deterministic, human-readable name, e.g. "KEPLER-442". */
  readonly name: string;
  readonly starClass: StarClass;
  /** Number of planets; in [1, MAX_PLANETS]. */
  readonly planetCount: number;
  /** The system's planets; `planets.length === planetCount`. */
  readonly planets: readonly Planet[];
}
