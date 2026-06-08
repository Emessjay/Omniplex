/**
 * Public API of the procedural universe generator.
 *
 * Every gameplay system reads from here. `command-core` imports `systemAt`,
 * `planetAt`, `planetKey`, `warpDistance`, and the `RESOURCES` catalog; keep
 * these signatures stable. See `CLAUDE.md` §"Conventions" for the
 * load-bearing decisions established by this module.
 */

export { RESOURCES, getResource } from "./resources";
export type { Resource, ResourceId } from "./resources";

export {
  BIOMES,
  ATMOSPHERES,
  STAR_CLASSES,
  MAX_PLANETS,
} from "./types";
export type {
  Biome,
  Atmosphere,
  StarClass,
  SystemCoord,
  PlanetCoord,
  ResourceDeposit,
  Planet,
  StarSystem,
} from "./types";

export {
  systemAt,
  planetAt,
  systemKey,
  planetKey,
  parseLocationKey,
  warpDistance,
} from "./gen";
