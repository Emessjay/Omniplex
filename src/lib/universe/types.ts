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

/** Integer galaxy address of a star system (matches the `players` columns). */
export interface SystemCoord {
  readonly sector: number;
  readonly system: number;
}

/** Integer galaxy address of a planet; `planet` is its 0-based index. */
export interface PlanetCoord extends SystemCoord {
  readonly planet: number;
}

/** A resource deposit on a planet: which resource and how rich (0..1). */
export interface ResourceDeposit {
  readonly resourceId: ResourceId;
  /** Relative abundance / yield potential, in [0, 1]. */
  readonly abundance: number;
}

/** A fully-described, recomputable planet. */
export interface Planet {
  readonly coord: PlanetCoord;
  /** Deterministic, human-readable name, e.g. "KEPLER-442b". */
  readonly name: string;
  readonly biome: Biome;
  readonly atmosphere: Atmosphere;
  /** Surface gravity in g; (0, 10]. */
  readonly gravity: number;
  /** Environmental danger in [0, 1]; high = "savage". */
  readonly hazard: number;
  /** Mean surface temperature in °C (finite). */
  readonly temperature: number;
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
