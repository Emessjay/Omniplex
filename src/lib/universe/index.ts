/**
 * Public API of the procedural universe generator.
 *
 * Every gameplay system reads from here. `command-core` imports `systemAt`,
 * `planetAt`, `planetKey`, `warpDistance`, and the `RESOURCES` catalog; keep
 * these signatures stable. See `CLAUDE.md` §"Conventions" for the
 * load-bearing decisions established by this module.
 */

export { RESOURCES, getResource, mineralsForBiome, isBiomeSpecific } from "./resources";
export type { Resource, ResourceId } from "./resources";

export {
  BIOMES,
  ATMOSPHERES,
  STAR_CLASSES,
  MAX_PLANETS,
  REGION_COUNT_MIN,
  REGION_COUNT_MAX,
  PALETTE_MIN,
  PALETTE_MAX,
  ARM_COUNT_MIN,
  ARM_COUNT_MAX,
} from "./types";
export type {
  Biome,
  Atmosphere,
  StarClass,
  SystemCoord,
  PlanetCoord,
  RegionCoord,
  ResourceDeposit,
  Planet,
  Region,
  StarSystem,
  Galaxy,
} from "./types";

export {
  galaxyAt,
  systemAt,
  planetAt,
  regionAt,
  systemKey,
  planetKey,
  regionKey,
  parseLocationKey,
  warpDistance,
  atmosphereDensity,
  biomeTempOffset,
  biomeHazardOffset,
  HABITABLE_BIOMES,
  hasSettlement,
  systemOutpostPlanets,
  hasOutpost,
  ARM_SPAN,
  CLUSTER_SPAN,
  SYSTEM_SPAN,
} from "./gen";
