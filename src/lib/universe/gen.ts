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
  ARM_COUNT_MAX,
  ARM_COUNT_MIN,
  ATMOSPHERES,
  BIOMES,
  GAS_RADIUS_THRESHOLD,
  MAX_PLANETS,
  PALETTE_MAX,
  PALETTE_MIN,
  REGION_COUNT_MAX,
  REGION_COUNT_MIN,
  REGION_FORMATIONS,
  STAR_CLASSES,
  type Atmosphere,
  type Biome,
  type ClusterCoord,
  type Galaxy,
  type Planet,
  type PlanetCoord,
  type RegionFormation,
  SITE_TYPES,
  type Region,
  type RegionCoord,
  type ResourceDeposit,
  type Site,
  type SizeClass,
  type StarClass,
  type StarPosition,
  type StarSystem,
  type SystemCoord,
} from "./types";
import { mineralsForBiome } from "./resources";
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

/** `"<galaxy>:<arm>:<cluster>:<system>"` (4 segments). */
export function systemKey(coord: SystemCoord): string {
  return `${coord.galaxy}:${coord.arm}:${coord.cluster}:${coord.system}`;
}

/** `"<galaxy>:<arm>:<cluster>:<system>:<planet>"` (5 segments). */
export function planetKey(coord: PlanetCoord): string {
  return `${systemKey(coord)}:${coord.planet}`;
}

/**
 * `"<galaxy>:<arm>:<cluster>:<system>:<planet>:<region>"` (6 segments) — the
 * per-region depletion key.
 */
export function regionKey(coord: RegionCoord): string {
  return `${planetKey(coord)}:${coord.region}`;
}

/**
 * Parse a system / planet / region key back into its coord object. Four
 * segments → `SystemCoord`; five → `PlanetCoord`; six → `RegionCoord`. Old
 * 2/3/4-segment keys were migrated to the galaxy-0/arm-0 prefix form by the
 * `addressing-overhaul` migration, so only 4/5/6 are valid now. Throws on
 * malformed input.
 */
export function parseLocationKey(
  key: string,
): SystemCoord | PlanetCoord | RegionCoord {
  const parts = key.split(":");
  const nums = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n)) {
      throw new Error(`invalid location key segment: ${p} in ${key}`);
    }
    return n;
  });
  if (nums.length === 4) {
    return { galaxy: nums[0]!, arm: nums[1]!, cluster: nums[2]!, system: nums[3]! };
  }
  if (nums.length === 5) {
    return {
      galaxy: nums[0]!,
      arm: nums[1]!,
      cluster: nums[2]!,
      system: nums[3]!,
      planet: nums[4]!,
    };
  }
  if (nums.length === 6) {
    return {
      galaxy: nums[0]!,
      arm: nums[1]!,
      cluster: nums[2]!,
      system: nums[3]!,
      planet: nums[4]!,
      region: nums[5]!,
    };
  }
  throw new Error(`invalid location key: ${key}`);
}

// ---------------------------------------------------------------------------
// Star positions within a cluster (star-coordinates).
//
// A cluster is no longer an open-ended ribbon of systems addressed by a linear
// index: it is a FIXED CLOUD of exactly `STARS_PER_CLUSTER` stars, each with a
// real floating-point `(x, y, z)` position sampled from an isotropic Gaussian
// centered on the cluster origin (σ = `STAR_CLUSTER_SIGMA`). Positions are
// rounded to 2 decimals and de-duplicated (no two stars in a cluster share a
// rounded position), so a coordinate warp is an exact 2-dp match. The whole
// cloud is a PURE, deterministic function of the cluster coord — nothing stored.
// The `system` index `0..STARS_PER_CLUSTER-1` simply indexes into this cloud,
// so existing stored `system` identities (DB column, location keys) are
// unaffected; clusters just became finite.
// ---------------------------------------------------------------------------

/**
 * Stars per cluster. A `system` index is canonical in `[0, STARS_PER_CLUSTER)`;
 * the cluster index itself stays unbounded (`cluster ≥ 0`).
 */
export const STARS_PER_CLUSTER = 1024;

/**
 * Standard deviation (per axis) of the isotropic Gaussian star cloud. A single
 * global constant — the cloud is isotropic (same σ on every axis) and the same
 * for every cluster. EXTENSION POINT: a per-cluster σ or an anisotropic Σ would
 * make clouds vary in size/shape; out of scope here.
 */
export const STAR_CLUSTER_SIGMA = 10;

/**
 * Hard radius bound on the star cloud (cluster origin to star). The Gaussian is
 * TRUNCATED to this finite sphere — a cluster is a bounded region of space, not
 * an infinite tail. Default ≈ 4σ, so truncation is rare but the cloud is
 * provably finite. Because every star sits within this sphere, intra-cluster
 * `warpDistance` is bounded by `2 · STAR_CLUSTER_MAX_RADIUS · SYSTEM_SPAN`. The
 * bound is checked on the FINAL ROUNDED position, so a returned star is always
 * in-sphere.
 */
export const STAR_CLUSTER_MAX_RADIUS = 40;

/** Round a position component to 2 decimals (the stored star-position precision). */
function round2(n: number): number {
  // `+0` collapses a possible `-0` to `0` so position keys/equality never split
  // on signed zero.
  return Math.round(n * 100) / 100 + 0;
}

/**
 * One standard-normal sample via the Box–Muller transform over two of the
 * PRNG's uniforms (NO `Math.random`). `1 - u` keeps the log argument in `(0, 1]`
 * so it is never `log(0)`. Deterministic: consumes exactly two stream draws.
 */
function gaussian(rng: Rng): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
}

/** The cluster a system coordinate belongs to (drops `system`). */
export function clusterOf(coord: SystemCoord): ClusterCoord {
  return { galaxy: coord.galaxy, arm: coord.arm, cluster: coord.cluster };
}

const POS_KEY = (p: StarPosition): string => `${p.x},${p.y},${p.z}`;

/**
 * The full cloud of `STARS_PER_CLUSTER` star positions for a cluster, in
 * `system`-index order (index `i` is the position of `system = i`). PURE &
 * deterministic, with its own RNG stream keyed by the cluster coord. Each star's
 * three components are isotropic-Gaussian (σ = `STAR_CLUSTER_SIGMA`), rounded to
 * 2 dp, and the cloud is TRUNCATED to a finite sphere of radius
 * `STAR_CLUSTER_MAX_RADIUS`. A freshly-sampled rounded position is RESAMPLED
 * from the same stream when it is either out-of-sphere OR a duplicate of an
 * already-placed star — one deterministic reject-and-resample loop covering both
 * — so every returned position is distinct AND provably within the sphere, and
 * the result is reproducible byte-for-byte.
 */
export function clusterStars(seed: string, cluster: ClusterCoord): StarPosition[] {
  const rng = makeRng(
    seed,
    "cluster-stars",
    cluster.galaxy,
    cluster.arm,
    cluster.cluster,
  );
  const positions: StarPosition[] = [];
  const seen = new Set<string>();
  const maxR2 = STAR_CLUSTER_MAX_RADIUS * STAR_CLUSTER_MAX_RADIUS;
  for (let i = 0; i < STARS_PER_CLUSTER; i++) {
    let pos: StarPosition;
    let k: string;
    // Reject-and-resample (deterministic — the stream order is fixed) until the
    // ROUNDED position is BOTH inside the sphere AND not a duplicate.
    do {
      pos = {
        x: round2(gaussian(rng) * STAR_CLUSTER_SIGMA),
        y: round2(gaussian(rng) * STAR_CLUSTER_SIGMA),
        z: round2(gaussian(rng) * STAR_CLUSTER_SIGMA),
      };
      k = POS_KEY(pos);
    } while (pos.x * pos.x + pos.y * pos.y + pos.z * pos.z > maxR2 || seen.has(k));
    seen.add(k);
    positions.push(pos);
  }
  return positions;
}

/**
 * The position of the star at `coord` = `clusterStars(seed, clusterOf(coord))`
 * indexed by `coord.system`. Throws a clear error if `system` is outside
 * `[0, STARS_PER_CLUSTER)` (clusters are finite now).
 */
export function systemPosition(seed: string, coord: SystemCoord): StarPosition {
  if (
    !Number.isInteger(coord.system) ||
    coord.system < 0 ||
    coord.system >= STARS_PER_CLUSTER
  ) {
    throw new Error(
      `systemPosition: system ${coord.system} out of range (valid 0–${STARS_PER_CLUSTER - 1})`,
    );
  }
  return clusterStars(seed, clusterOf(coord))[coord.system]!;
}

/**
 * The `system` index whose rounded position equals `pos` (an exact 2-dp match),
 * or `null` if no star in the cluster sits there. The query position is rounded
 * to 2 dp first, so callers may pass raw floats. Positions are unique by
 * construction, so the match (if any) is unambiguous.
 */
export function systemFromPosition(
  seed: string,
  cluster: ClusterCoord,
  pos: StarPosition,
): number | null {
  const target = POS_KEY({ x: round2(pos.x), y: round2(pos.y), z: round2(pos.z) });
  const stars = clusterStars(seed, cluster);
  for (let i = 0; i < stars.length; i++) {
    if (POS_KEY(stars[i]!) === target) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation (AC#8).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Polar galaxy geometry (galactic-structure).
//
// A galaxy is a flat DISK. Within it we treat `arm` as an ANGLE θ (arm ·
// 2π/armCount — arms are evenly-spaced rays from the core) and `cluster` as a
// RADIUS r (rings of clusters marching outward from the core). So a cluster's
// position in the galactic plane is the polar point `(r cosθ, r sinθ)`, and the
// warp distance between two clusters is just the real planar distance between
// those points (the law of cosines). This SUBSUMES the old flat
// `ARM_SPAN`/`CLUSTER_SPAN` weighted sum — the radial scale `CLUSTER_RING_SPAN`
// now plays the `CLUSTER_SPAN` role, and the arm term emerges from the geometry
// (arms CONVERGE near the core and SPLAY at the rim: a fixed arm gap is a
// shorter chord at small r). `SYSTEM_SPAN` survives as the intra-cluster
// multiplier (the fine, sub-cluster Euclidean term). The galaxy is FINITE:
// `cluster ∈ [0, MAX_CLUSTERS_PER_ARM)` — the rim is a hard edge enforced by the
// game layer (`warp`/`map`).
// ---------------------------------------------------------------------------

/**
 * Radial distance per cluster ring. Plays the old `CLUSTER_SPAN` role. Set to
 * `10 * STAR_CLUSTER_SIGMA` (= 100) so a one-ring radial step cleanly exceeds
 * the star-cloud diameter (`2 * STAR_CLUSTER_MAX_RADIUS` = 8σ = 80) — rings
 * don't overlap radially, the `cluster-span-retune` non-overlap rule made radial.
 */
export const CLUSTER_RING_SPAN = 10 * STAR_CLUSTER_SIGMA; // 100
/**
 * Core offset (in ring units) so cluster 0 is a real ring with a positive radius
 * rather than the degenerate galactic center (where every arm coincides and the
 * polar metric would collapse). Must be ≥ 1.
 */
export const CLUSTER_R0 = 1;
/**
 * The galaxy's radius in cluster rings — a FINITE disk. `cluster` is valid in
 * `[0, MAX_CLUSTERS_PER_ARM)`; the game layer rejects targets at/beyond this rim.
 * Tunable (~32–128).
 */
export const MAX_CLUSTERS_PER_ARM = 64;
/** Multiplier on the intra-cluster (sub-cluster) Euclidean star distance. */
export const SYSTEM_SPAN = 1;
/** Peak galactic-center radiation (arbitrary "level" units); the core maxes out here. */
export const RADIATION_MAX = 100;

/** The angle (radians) of an arm: `arm · 2π / armCount` (evenly-spaced rays). */
export function armAngle(arm: number, armCount: number): number {
  return (arm * 2 * Math.PI) / armCount;
}

/**
 * The radius (galactic-plane distance from the core) of a cluster ring:
 * `(cluster + CLUSTER_R0) · CLUSTER_RING_SPAN`. Strictly increasing in `cluster`,
 * positive at cluster 0 (the `CLUSTER_R0` offset keeps the core non-degenerate).
 */
export function clusterRadius(cluster: number): number {
  return (cluster + CLUSTER_R0) * CLUSTER_RING_SPAN;
}

/**
 * The Cartesian position of a cluster in the galactic plane: the polar point
 * `(r cosθ, r sinθ)` where `r = clusterRadius(cluster)` and
 * `θ = armAngle(arm, armCount)`.
 */
export function clusterCenter(
  arm: number,
  cluster: number,
  armCount: number,
): { x: number; y: number } {
  const r = clusterRadius(cluster);
  const theta = armAngle(arm, armCount);
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

/**
 * Galactic-center radiation at a cluster ring: maximal at the core (cluster 0)
 * and decaying linearly to ~0 at the rim. In `[0, RADIATION_MAX]`, monotonically
 * non-increasing in `cluster`. Pure & display-only THIS phase — its gameplay
 * consequences (a hazard floor + a radiation-shield gate) are a later 0b.
 */
export function galacticRadiation(cluster: number): number {
  return RADIATION_MAX * Math.max(0, 1 - cluster / MAX_CLUSTERS_PER_ARM);
}

/**
 * Maximum hazard FLOOR imposed by galactic radiation (reached at the core,
 * radiation `RADIATION_MAX`). Tunable (~0.5–0.6) — high enough that coreward
 * worlds are reliably savage (rare ore + dangerous surfaces via the
 * hazard→rarity / hazard→damage couplings), but below 1 so it never erases all
 * variation. Lives in the universe layer (a physical property of the cluster),
 * re-exported from `rules.ts` for the game layer (mirrors `atmosphereDensity`).
 */
export const RAD_HAZARD_FLOOR_MAX = 0.55;

/**
 * The minimum planet hazard imposed by galactic radiation at a given radiation
 * level: linear from 0 at no radiation up to `RAD_HAZARD_FLOOR_MAX` at
 * `RADIATION_MAX`. Pure, monotonically non-decreasing, clamped to
 * `[0, RAD_HAZARD_FLOOR_MAX]`. Planet hazard is `max(tempHazard, this(rad))`, so
 * the floor raises hazard coreward without erasing the temperature signal at the
 * rim (where radiation → 0 → floor 0 → hazard is fully temperature-driven).
 */
export function radiationHazardFloor(radiation: number): number {
  const r = Math.max(0, Math.min(RADIATION_MAX, radiation));
  return (r / RADIATION_MAX) * RAD_HAZARD_FLOOR_MAX;
}

/**
 * Distance between two systems within the SAME galaxy (0 to self, symmetric,
 * positive between distinct same-galaxy coords), in the polar disk geometry:
 *
 *  - Same arm AND same cluster (same star cloud) → the fine intra-cluster term:
 *    the EUCLIDEAN distance between the two stars' `(x, y, z)` positions ×
 *    `SYSTEM_SPAN` (derived via `systemPosition` — hence the seed). 0 to self.
 *  - Different cluster/arm → the planar distance between the two clusters'
 *    CENTERS, `|clusterCenter(a) − clusterCenter(b)|` (law of cosines
 *    `√(rₐ² + r_b² − 2 rₐ r_b cos(θₐ − θ_b))`). Because arms are rays from the
 *    core, a fixed arm gap is a shorter chord near the core than at the rim —
 *    arms converge coreward, splay rimward.
 *
 * Different galaxies return `Infinity` — inter-galaxy travel is NOT a warp
 * (condensate-gated). Callers supply `armCount` from
 * `galaxyAt(coord.galaxy).armCount`. PURE — positions are derived from the seed.
 */
export function warpDistance(
  seed: string,
  a: SystemCoord,
  b: SystemCoord,
  armCount: number,
): number {
  if (a.galaxy !== b.galaxy) return Infinity;
  if (a.arm === b.arm && a.cluster === b.cluster) {
    // Same star cloud: fine-grained intra-cluster Euclidean distance.
    const pa = systemPosition(seed, a);
    const pb = systemPosition(seed, b);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) * SYSTEM_SPAN;
  }
  // Different cluster/arm: real planar distance between the cluster centers.
  const ca = clusterCenter(a.arm, a.cluster, armCount);
  const cb = clusterCenter(b.arm, b.cluster, armCount);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

// ---------------------------------------------------------------------------
// Galaxies. A galaxy is a deterministic function of its index: a flavor name
// and an arm count. The arm count varies per galaxy and bounds the arm ring
// for `warpDistance` / arm-wrapping in `warp`.
// ---------------------------------------------------------------------------

/** Flavor galaxy-name fragments (purely cosmetic). */
const GALAXY_NAMES = [
  "Andromeda",
  "Whirlpool",
  "Pinwheel",
  "Sombrero",
  "Triangulum",
  "Cartwheel",
  "Sunflower",
  "Cigar",
  "Tadpole",
  "Hoag",
] as const;

/**
 * The galaxy at `galaxy` (an unbounded index ≥ 0). Pure & deterministic: same
 * seed + index ⇒ identical `{ index, name, armCount }`. `armCount` is rolled
 * uniformly in `[ARM_COUNT_MIN, ARM_COUNT_MAX]`, so different galaxies differ.
 */
export function galaxyAt(seed: string, galaxy: number): Galaxy {
  const rng = makeRng(seed, "galaxy", galaxy);
  const name = `${pick(rng, GALAXY_NAMES)}-${randInt(rng, 1, 9999)}`;
  const armCount = randInt(rng, ARM_COUNT_MIN, ARM_COUNT_MAX);
  return { index: galaxy, name, armCount };
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

function starClassFor(rng: Rng): StarClass {
  const weights = STAR_CLASSES.map((c) => STAR_CLASS_WEIGHTS[c]);
  return STAR_CLASSES[weightedIndex(rng, weights)]!;
}

// ---------------------------------------------------------------------------
// Planet size & temperature ← Kopparapu (2018, ApJ 856) occurrence data
// (planet-taxonomy).
//
// A planet's PHYSICAL SIZE (`radius`, R⊕) is sampled from the paper's size
// occurrence: pick a size class weighted by its share, then a radius log-uniform
// within that class's radius band. The rocky/gas split follows from the radius
// (`radius >= GAS_RADIUS_THRESHOLD` ⇒ gas), giving ≈49% rocky / ≈51% gas.
//
// TEMPERATURE is derived from the radius (the old star-brightness/orbital-
// closeness physics was DROPPED): each size class carries a cold/warm/hot zone
// MIX from the paper's Table 3, and a planet's mix is INTERPOLATED smoothly by
// `log10(radius)` between the per-class anchors. A uniform draw `u` is mapped
// through an inverse-CDF with breakpoints at 0°C and 100°C — `u < c` lands in
// the COLD band `[TEMP_MIN, 0)`, `[c, c+w)` in the WARM band `[0, 100)`, and the
// rest in the HOT band `(100, TEMP_MAX]` — linear within each segment, so the
// realized zone proportions exactly match `(c, w, h)` while temperature stays a
// smooth, bounded, continuous function. Temperature is INDEPENDENT of orbital
// distance now (a system's temps are not a distance gradient — expected).
// ---------------------------------------------------------------------------

/** Coldest / hottest mean surface temperature a planet can take (°C). */
export const TEMP_MIN = -160;
export const TEMP_MAX = 520;

/**
 * Per-size-class occurrence + zone mix (Kopparapu 2018). `share` is the relative
 * occurrence weight; `[rLo, rHi]` the radius band (R⊕); `logMid` the log10 of the
 * band's geometric mean (the interpolation anchor); `(cold, warm, hot)` the
 * normalized zone fractions from the paper's Table 3. Rocky/Super-Earth are
 * rocky; Sub-Neptune and up are gas. Shares sum to ≈100; the rocky classes sum
 * to ≈49.3, so the population is ≈49% rocky / ≈51% gas.
 */
interface SizeClassDef {
  id: SizeClass;
  rLo: number;
  rHi: number;
  logMid: number;
  share: number;
  cold: number;
  warm: number;
  hot: number;
}

const SIZE_DEFS: readonly SizeClassDef[] = [
  { id: "rocky", rLo: 0.5, rHi: 1.0, logMid: log10mid(0.5, 1.0), share: 30.1, cold: 0.664, warm: 0.104, hot: 0.232 },
  { id: "super_earth", rLo: 1.0, rHi: 1.75, logMid: log10mid(1.0, 1.75), share: 19.2, cold: 0.772, warm: 0.114, hot: 0.114 },
  { id: "sub_neptune", rLo: 1.75, rHi: 3.5, logMid: log10mid(1.75, 3.5), share: 23.2, cold: 0.731, warm: 0.054, hot: 0.215 },
  { id: "sub_jovian", rLo: 3.5, rHi: 6.0, logMid: log10mid(3.5, 6.0), share: 16.1, cold: 0.871, warm: 0.084, hot: 0.045 },
  { id: "jovian", rLo: 6.0, rHi: 14.3, logMid: log10mid(6.0, 14.3), share: 11.3, cold: 0.928, warm: 0.021, hot: 0.051 },
];

/** log10 of the geometric mean of a radius band (the per-class interpolation anchor). */
function log10mid(lo: number, hi: number): number {
  return (Math.log10(lo) + Math.log10(hi)) / 2;
}

/**
 * Sample a planet's physical size: choose a size class by `share`, then a radius
 * log-uniformly within that class's `[rLo, rHi]` band (so the radius distribution
 * matches the paper's). Pure given the rng draws. Radius is rounded to 3 decimals
 * and stays within `[0.5, 14.3)` (so always ≥ 0.5 and < the top of the range).
 */
function sampleSize(rng: Rng): { sizeClass: SizeClass; radius: number } {
  const def = SIZE_DEFS[weightedIndex(rng, SIZE_DEFS.map((d) => d.share))]!;
  const logR = randFloat(rng, Math.log10(def.rLo), Math.log10(def.rHi));
  const radius = Number((10 ** logR).toFixed(3));
  return { sizeClass: def.id, radius };
}

/**
 * The (cold, warm, hot) zone mix for a planet of the given radius: piecewise-
 * linear interpolation of the per-class anchors by `log10(radius)`, clamped to the
 * first/last anchor outside the anchor range. Normalized to sum to 1.
 */
function zoneMix(radius: number): { c: number; w: number; h: number } {
  const x = Math.log10(radius);
  const first = SIZE_DEFS[0]!;
  const last = SIZE_DEFS[SIZE_DEFS.length - 1]!;
  let c: number, w: number, h: number;
  if (x <= first.logMid) {
    [c, w, h] = [first.cold, first.warm, first.hot];
  } else if (x >= last.logMid) {
    [c, w, h] = [last.cold, last.warm, last.hot];
  } else {
    let lo = first;
    let hi = last;
    for (let i = 0; i < SIZE_DEFS.length - 1; i++) {
      if (x >= SIZE_DEFS[i]!.logMid && x <= SIZE_DEFS[i + 1]!.logMid) {
        lo = SIZE_DEFS[i]!;
        hi = SIZE_DEFS[i + 1]!;
        break;
      }
    }
    const t = (x - lo.logMid) / (hi.logMid - lo.logMid);
    c = lo.cold + (hi.cold - lo.cold) * t;
    w = lo.warm + (hi.warm - lo.warm) * t;
    h = lo.hot + (hi.hot - lo.hot) * t;
  }
  const sum = c + w + h;
  return { c: c / sum, w: w / sum, h: h / sum };
}

/**
 * A planet's mean surface temperature (°C) from its radius, via the paper's
 * per-radius zone mix and an inverse-CDF with breakpoints at 0°C and 100°C
 * (cold `[TEMP_MIN, 0)`, warm `[0, 100)`, hot `(100, TEMP_MAX]`). PURE and
 * deterministic given the radius + the rng draw; smooth + bounded to
 * `[TEMP_MIN, TEMP_MAX]`.
 */
function temperatureFromRadius(radius: number, rng: Rng): number {
  const { c, w } = zoneMix(radius);
  const u = rng();
  if (u < c) {
    // Cold band: linearly across [TEMP_MIN, 0).
    return TEMP_MIN + (u / c) * (0 - TEMP_MIN);
  }
  if (u < c + w) {
    // Warm band: linearly across [0, 100).
    return ((u - c) / w) * 100;
  }
  // Hot band: linearly across (100, TEMP_MAX]. `h = 1 - c - w`.
  const h = 1 - c - w;
  return 100 + ((u - c - w) / h) * (TEMP_MAX - 100);
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
// Geology — region formations + their resource signatures (cascade tier 4b).
//
// A region's GEOLOGY is independent of its CLIMATE (biome). Each region is
// assigned a `RegionFormation` (volcanic vent / impact crater / cave system /
// …), chosen on a sub-stream DISTINCT from the climate/biome draw so it never
// perturbs them. The formation distribution reflects the planet's geology
// PROFILE (`volcanism`/`impactDensity`/`erosion`/`tectonics`): a high-volcanism
// world has more vents, a high-impact world more craters, etc.; a low-everything
// world is mostly plains.
//
// The formation then sets the region's RESOURCE SIGNATURE — a per-formation
// table of FAVORED mineral ids (a multiplier on each candidate's pick weight)
// plus a slot-count distribution and a richness factor — LAYERED OVER the
// existing constraints: the candidate pool is still `mineralsForBiome(biome)`
// (so biome-specifics stay confined to their biome) and pick weights still carry
// the `rarityWeight(rarity, hazard)` savage→rare coupling. So a planet gains a
// coherent, LEARNABLE resource map ("volcanic-vent region → expect metals")
// without breaking either invariant.
// ---------------------------------------------------------------------------

/**
 * How strongly a geology-profile component is driven by its astronomical-cascade
 * input vs an independent draw (the rest). `0.5` mixes them evenly — enough to
 * give a clear positive correlation (volcanism↔eccentricity,
 * erosion↔rotationSpeed) while keeping plenty of per-planet variety.
 */
const GEOLOGY_COUPLING = 0.5;

/**
 * Per-formation resource SIGNATURE. `favored` multiplies the pick weight of the
 * listed minerals (a mineral absent from the biome pool is simply never picked,
 * so this never violates the biome-confinement invariant); `slots` is the
 * deposit-count distribution sampled by `randInt(0, 7)` (rich formations skew to
 * more deposits, plains to fewer/barren); `richness` boosts the abundance of
 * favored LOW/MID-rarity ore only (rarity ≤ 3), so it makes vents metal-RICH
 * without ever inflating rare-ore abundance — preserving the rarity→abundance
 * coupling (high-rarity veins stay lean). Tunable.
 */
interface FormationSignature {
  readonly favored: Readonly<Record<string, number>>;
  readonly slots: readonly number[];
  readonly richness: number;
}

const FORMATION_SIGNATURES: Record<RegionFormation, FormationSignature> = {
  // Vents: metal-rich and abundant — iron/copper/titanium (pyrite if volcanic).
  volcanic_vent: {
    favored: { iron: 4, copper: 4, titanium: 4, pyrite: 4 },
    slots: [2, 2, 3, 3, 3, 2, 1, 2],
    richness: 1.5,
  },
  // Craters: the rare-earth zones — iridium/xenon/cobalt. No abundance boost
  // (these are rare ⇒ lean veins, by design); the signature is WHICH ore, rare.
  impact_crater: {
    favored: { iridium: 5, xenon: 5, cobalt: 4 },
    slots: [1, 2, 2, 2, 3, 1, 1, 0],
    richness: 1.0,
  },
  // Caves: crystalline/gems — prismatic_gem (if crystalline) + silica.
  cave_system: {
    favored: { prismatic_gem: 5, silica: 4 },
    slots: [1, 2, 2, 1, 2, 1, 1, 0],
    richness: 1.2,
  },
  // Basins: common sedimentary ore — silica/iron (aquamarine if ocean).
  sedimentary_basin: {
    favored: { silica: 4, iron: 3, aquamarine: 4 },
    slots: [1, 2, 2, 1, 2, 1, 0, 0],
    richness: 1.0,
  },
  // Ridges: deep mixed ore — metals plus savage-gated voidstone where it occurs.
  tectonic_ridge: {
    favored: { iron: 3, copper: 3, titanium: 3, iridium: 2, voidstone: 3 },
    slots: [2, 2, 3, 2, 1, 2, 1, 0],
    richness: 1.2,
  },
  // Plains: sparse, low — no signature, more barren slots.
  plains: {
    favored: {},
    slots: [1, 1, 0, 1, 0, 1, 0, 0],
    richness: 1.0,
  },
};

/**
 * The base selection weight per formation (before the profile bias). `plains` is
 * the high baseline that dominates when the geology profile is all-low; the
 * others ride a profile-driven term on top. Kept positive everywhere so every
 * formation can occur on any planet (just rarely when its profile input is low).
 */
const FORMATION_BASE_WEIGHT = 1;
const FORMATION_PLAINS_BASE = 4;
/** How strongly the profile component lifts its formation's weight. */
const FORMATION_PROFILE_GAIN = 6;

/**
 * Choose a region's `RegionFormation` from the planet's geology profile, on a
 * stream the caller keys distinctly from the climate/biome draw. Each
 * formation's weight is a base plus its profile-driven term, so the realized
 * distribution tracks the planet's `volcanism`/`impactDensity`/`erosion`/
 * `tectonics` (AC#2): a high-volcanism planet yields more `volcanic_vent`
 * regions than a low-volcanism one. Pure: one `rng()` draw (the weighted pick).
 */
function formationFor(rng: Rng, planet: Planet): RegionFormation {
  const profileTerm: Record<RegionFormation, number> = {
    volcanic_vent: FORMATION_PROFILE_GAIN * planet.volcanism,
    impact_crater: FORMATION_PROFILE_GAIN * planet.impactDensity,
    // Erosion both hollows caves and lays down sediment — split between the two.
    cave_system: FORMATION_PROFILE_GAIN * 0.6 * planet.erosion,
    sedimentary_basin: FORMATION_PROFILE_GAIN * 0.6 * planet.erosion,
    tectonic_ridge: FORMATION_PROFILE_GAIN * planet.tectonics,
    plains: 0,
  };
  const weights = REGION_FORMATIONS.map(
    (f) => (f === "plains" ? FORMATION_PLAINS_BASE : FORMATION_BASE_WEIGHT) + profileTerm[f],
  );
  return REGION_FORMATIONS[weightedIndex(rng, weights)]!;
}

// ---------------------------------------------------------------------------
// Deposits — the hazard→rarity coupling (AC#5) + the formation signature (4b).
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
 * Draw the deposits for a region of the given `biome` and `formation`. Most
 * regions get 1–3 deposits; a minority are barren — the slot-count distribution
 * comes from the FORMATION's signature (rich formations skew to more, plains to
 * fewer/barren). The candidate pool is biome-aware — `mineralsForBiome(biome)` =
 * every general mineral plus the biome-specific ones for THIS biome, so a deposit
 * can never be a mineral specific to a different biome. Each slot picks a distinct
 * resource weighted by `rarityWeight(rarity, hazard) × favored`, where `favored`
 * is the formation signature's per-mineral multiplier — so vents concentrate
 * metals, craters concentrate rare/exotic ore, etc., WHILE the savage→rare
 * hazard coupling still applies over the filtered pool. Determinism is preserved
 * (biome + formation are rolled before this, so the pool + signature are a
 * deterministic function of the region coord).
 */
function depositsFor(
  rng: Rng,
  hazard: number,
  biome: Biome,
  formation: RegionFormation,
): ResourceDeposit[] {
  const sig = FORMATION_SIGNATURES[formation];
  // Formation-shaped slot count (0 = barren). Most formations carry ≥1 deposit.
  const slots = sig.slots[randInt(rng, 0, sig.slots.length - 1)]!;
  if (slots === 0) return [];

  const available = mineralsForBiome(biome);
  const deposits: ResourceDeposit[] = [];
  for (let i = 0; i < slots && available.length > 0; i++) {
    // Pick weight = hazard→rarity coupling × the formation's per-mineral favor
    // (default 1). Favoring shifts WHICH minerals concentrate, never the pool.
    const weights = available.map(
      (r) => rarityWeight(r.rarity, hazard) * (sig.favored[r.id] ?? 1),
    );
    const idx = weightedIndex(rng, weights);
    const resource = available[idx]!;
    available.splice(idx, 1); // distinct resource per slot

    // Abundance in (0, 1], biased by rarity so common ore forms richer veins
    // and rare ore forms leaner ones: the upper bound of the random draw
    // shrinks as rarity climbs (rarity 1→full range, rarity 5→a low ceiling).
    // The draw keeps a random component, so veins still vary; only the
    // expected abundance trends down (monotonically) with rarity.
    const rarityBias = 1 - 0.15 * (resource.rarity - 1); // 1.0 at r1 → 0.4 at r5
    // Formation richness boosts the abundance of FAVORED LOW/MID-rarity ore
    // (rarity ≤ 3) only — so vents read metal-RICH, while rare-ore veins stay
    // lean (the rarity→abundance coupling is never inflated for rarity ≥ 4).
    const richnessMult =
      sig.favored[resource.id] && resource.rarity <= 3 ? sig.richness : 1;
    const richness = randFloat(rng, 0.1, 1) * rarityBias * richnessMult;
    const abundance = Math.min(1, richness);
    deposits.push({ resourceId: resource.id, abundance });
  }
  return deposits;
}

// ---------------------------------------------------------------------------
// Planet & system generation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Band lines for region temperature clamping (biome-consistency). These mirror
// the landing-gate thresholds in `src/lib/game/rules.ts` (`FREEZING_C` /
// `BOILING_C`) — kept as local constants so the universe layer stays free of a
// dependency on the game layer. A planet `> BOILING_C` is "boiling", `<
// FREEZING_C` is "freezing", otherwise "moderate"; region variation must never
// flip a region into a different band than its planet.
// ---------------------------------------------------------------------------
const FREEZING_C = 0;
const BOILING_C = 100;

// ---------------------------------------------------------------------------
// Biome affinities & per-region offsets (biome-consistency).
//
// Each biome has (a) a TEMPERATURE AFFINITY used when assembling a planet's
// palette — hot worlds favor hot biomes and downweight cold ones, and vice
// versa — and (b) small per-region TEMPERATURE and HAZARD offsets that make a
// region read hotter/colder and more/less hazardous than its planet's mean.
//
// Affinity sign: +1 = hot-loving (volcanic, desert), −1 = cold-loving (tundra),
// 0 = temperature-neutral (everything else). `ocean`/`jungle` are also confined
// to moderate worlds in the palette builder (no liquid water on boiling/freezing
// worlds). `gas` is special — it never enters the weighted pool; a gas giant is
// drawn up front as the exclusive `["gas"]` palette.
// ---------------------------------------------------------------------------

/** Temperature affinity per biome: +1 hot-loving, −1 cold-loving, 0 neutral. */
const BIOME_TEMP_AFFINITY: Record<Biome, number> = {
  barren: 0,
  ocean: 0,
  jungle: 0,
  desert: 1,
  tundra: -1,
  volcanic: 1,
  toxic: 0,
  crystalline: 0,
  gas: 0,
  irradiated: 0,
};

/**
 * Per-region TEMPERATURE offset (°C) by biome, applied to the planet's mean to
 * get the region's temperature (then band-clamped). Hot biomes (`volcanic`,
 * `desert`) run warmer; `tundra` runs colder; `barren`/`gas` are neutral (0).
 * The seeded contract requires `volcanic > barren` and `tundra < barren`.
 */
const BIOME_TEMP_OFFSET: Record<Biome, number> = {
  volcanic: 15,
  desert: 8,
  irradiated: 5,
  toxic: 3,
  jungle: 2,
  barren: 0,
  gas: 0,
  crystalline: -2,
  ocean: -3,
  tundra: -15,
};

/**
 * Per-region HAZARD offset (added to the planet's hazard, then clamped to
 * [0,1]). The naturally dangerous biomes (`volcanic`, `irradiated`, `toxic`)
 * are positive; calmer ones sit at/below 0. The seeded contract requires
 * `volcanic > barren` and that volcanic/irradiated/toxic are all ≥ 0.
 */
const BIOME_HAZARD_OFFSET: Record<Biome, number> = {
  volcanic: 0.15,
  irradiated: 0.15,
  toxic: 0.12,
  desert: 0.03,
  tundra: 0.02,
  gas: 0,
  barren: 0,
  jungle: 0,
  crystalline: 0,
  ocean: -0.02,
};

/** Per-region temperature offset (°C) contributed by a region's biome. */
export function biomeTempOffset(biome: Biome): number {
  return BIOME_TEMP_OFFSET[biome];
}

/** Per-region hazard offset (added to planet hazard, then clamped to [0,1]). */
export function biomeHazardOffset(biome: Biome): number {
  return BIOME_HAZARD_OFFSET[biome];
}

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

/**
 * How temperature affinity bends palette selection. The weight multiplier for a
 * biome is `exp(AFFINITY_STRENGTH · affinity · tNorm)`, where `tNorm` is the
 * planet's temperature normalized around the comfort mid. So on a hot world
 * (tNorm > 0) `tundra` (affinity −1) is exponentially downweighted while
 * `volcanic`/`desert` (affinity +1) are upweighted, and vice-versa on a cold
 * world. Neutral biomes (affinity 0) are unaffected.
 */
const AFFINITY_STRENGTH = 2.5;

/** Comfort-window half-width (°C) within which a planet counts as fully moderate. */
const PALETTE_COMFORT = 40;
/** Temperature departure beyond the comfort window (°C) that maps to full extremity. */
const PALETTE_EXTREME_SCALE = 130;

/**
 * Temperature extremity in [0, 1]: 0 for a moderate world (within ±`PALETTE_COMFORT`
 * of the comfort mid), rising to 1 as it gets very hot or very cold. Drives
 * palette SIZE (rule 4): extreme worlds collapse toward a single coherent biome,
 * moderate worlds spread to `PALETTE_MAX`.
 */
function tempExtremity(temperature: number): number {
  const departure = Math.max(
    0,
    Math.abs(temperature - TEMP_COMFORT_MID) - PALETTE_COMFORT,
  );
  return Math.min(1, departure / PALETTE_EXTREME_SCALE);
}

/**
 * The biome palette for a ROCKY planet: a DISTINCT subset of `BIOMES` whose
 * composition and size are coupled to the planet's `temperature`
 * (biome-consistency). `gas` is NEVER a member — gas is now purely a SIZE
 * outcome (`isGas`), handled in `generatePlanet` (gas giants get the exclusive
 * `["gas"]` palette and 0 regions), so this is only ever called for rocky worlds
 * and `gas` is excluded from the candidate pool entirely:
 *  - rule 4: SIZE declines with `tempExtremity` — moderate worlds reach
 *    `PALETTE_MAX`, extreme worlds collapse toward 1.
 *  - rule 3: members are drawn weighted by `BIOME_WEIGHTS` bent by temperature
 *    affinity, so hot worlds favor hot biomes / shed cold ones (and vice-versa).
 *  - rule 5: `ocean` (and `jungle`, the other liquid/life biome) are excluded on
 *    boiling/freezing worlds — no liquid water beyond the band.
 * A region's biome is later picked uniformly from this palette, so it is the
 * only set of biomes a planet's regions can ever exhibit.
 */
function biomePaletteFor(rng: Rng, temperature: number): Biome[] {
  // Size from temperature extremity: 4 at moderate → 1 at extreme, plus a
  // small jitter so similar worlds still vary; clamped to [1, PALETTE_MAX].
  const extremity = tempExtremity(temperature);
  const sizeBase = PALETTE_MAX - (PALETTE_MAX - PALETTE_MIN) * extremity;
  const size = Math.min(
    PALETTE_MAX,
    Math.max(PALETTE_MIN, Math.round(sizeBase + randFloat(rng, -0.49, 0.49))),
  );

  // (5) Exclude `gas` always (handled above) and, on boiling/freezing worlds,
  // the liquid/life biomes that can't exist beyond the 0/100 band.
  const extremeWorld = temperature > BOILING_C || temperature < FREEZING_C;
  const available = BIOMES.filter(
    (b) => b !== "gas" && !(extremeWorld && (b === "ocean" || b === "jungle")),
  );

  // (3) Temperature-weighted selection without replacement. tNorm > 0 on hot
  // worlds, < 0 on cold; affinity bends each biome's weight exponentially.
  const tNorm = (temperature - TEMP_COMFORT_MID) / 100;
  const palette: Biome[] = [];
  for (let i = 0; i < size && available.length > 0; i++) {
    const weights = available.map(
      (b) =>
        BIOME_WEIGHTS[b] *
        Math.exp(AFFINITY_STRENGTH * BIOME_TEMP_AFFINITY[b] * tNorm),
    );
    const idx = weightedIndex(rng, weights);
    palette.push(available[idx]!);
    available.splice(idx, 1); // distinct biome per palette slot
  }
  return palette;
}

/**
 * Roll a planet's RAW region count LOG-uniformly across
 * `[REGION_COUNT_MIN, REGION_COUNT_MAX]` = `[100, 100000]`:
 * `round(10 ** randFloat(2, 5))`, then clamped to the bounds. Log-uniform (vs
 * linear) is what gives the wide spread — small ~10² planets and huge ~10⁵ ones
 * both occur with comparable frequency rather than nearly every planet maxing
 * out. The raw count is then SNAPPED to a complete lat×lon grid (`gridDimsFor`),
 * which is what a planet actually stores as its `regionCount`.
 */
function regionCountFor(rng: Rng): number {
  const raw = Math.round(10 ** randFloat(rng, 2, 5));
  return Math.min(REGION_COUNT_MAX, Math.max(REGION_COUNT_MIN, raw));
}

// ---------------------------------------------------------------------------
// Surface grid (surface-grid). A planet's surface is a lat×lon GRID: the region
// INDEX (`0 .. regionCount-1`) is reinterpreted as a cell via divmod
// (`index = lat·cols + lon`), the same index↔position bijection trick the star
// cloud uses. The index stays canonical, so every region-keyed store
// (`world_deltas`, `salvaged_sites`, `bases`, `players.region`) is unchanged —
// NO reset, NO migration; the index just gains a (lat, lon) interpretation.
//
// The grid is ~1:2 lat:lon (a real map is wider than tall): `cols = 2·rows`.
// `rows` is derived from the raw region-count roll as `round(sqrt(raw/2))` and
// CLAMPED to `[GRID_ROWS_MIN, GRID_ROWS_MAX]` so the snapped `regionCount =
// rows·cols = 2·rows²` always stays within `[REGION_COUNT_MIN, REGION_COUNT_MAX]`
// (2·8² = 128 ≥ 100, 2·223² = 99 458 ≤ 100 000). Because `regionCount` is stored
// as exactly `2·rows²`, `regionGrid` recovers `rows`/`cols` from it losslessly.
// ---------------------------------------------------------------------------

/** Fewest grid rows (keeps the snapped count ≥ `REGION_COUNT_MIN`: 2·8² = 128). */
const GRID_ROWS_MIN = 8;
/** Most grid rows (keeps the snapped count ≤ `REGION_COUNT_MAX`: 2·223² = 99 458). */
const GRID_ROWS_MAX = 223;

/** Grid dims for a RAW region-count roll: `cols = 2·rows`, `rows` clamped. */
function gridDimsFor(rawCount: number): { rows: number; cols: number } {
  const rows = Math.min(
    GRID_ROWS_MAX,
    Math.max(GRID_ROWS_MIN, Math.round(Math.sqrt(rawCount / 2))),
  );
  return { rows, cols: 2 * rows };
}

/**
 * The lat×lon grid dimensions of a planet's surface. `cols = 2·rows` (≈1:2
 * lat:lon) and `rows·cols === planet.regionCount` exactly. Recovered losslessly
 * from the stored `regionCount` (which gen snaps to `2·rows²`). A gas giant has
 * no surface (`regionCount === 0`) — `rows`/`cols` are 0 there; callers branch on
 * `planet.isGas` before gridding.
 */
export function regionGrid(planet: Planet): { rows: number; cols: number } {
  if (planet.regionCount <= 0) return { rows: 0, cols: 0 };
  const rows = Math.round(Math.sqrt(planet.regionCount / 2));
  return { rows, cols: 2 * rows };
}

/**
 * The `(lat, lon)` grid cell a region INDEX addresses, via divmod:
 * `lat = floor(index / cols)`, `lon = index % cols`. `lat ∈ [0, rows)` (row 0 and
 * `rows-1` are the two poles, the middle rows the equator); `lon ∈ [0, cols)`
 * wraps cyclically. Inverse of `regionIndex`.
 */
export function regionCoords(
  index: number,
  _rows: number,
  cols: number,
): { lat: number; lon: number } {
  // `_rows` completes the `(index, rows, cols)` calling convention but the divmod
  // only needs `cols`; `lat` is naturally bounded by `rows` for an in-range index.
  return { lat: Math.floor(index / cols), lon: index % cols };
}

/** The region INDEX of grid cell `(lat, lon)`: `lat·cols + lon`. Inverse of `regionCoords`. */
export function regionIndex(lat: number, lon: number, cols: number): number {
  return lat * cols + lon;
}

/** A compass direction for surface movement (surface-nav). */
export type Direction = "north" | "south" | "east" | "west";

/**
 * The region INDEX you reach by stepping one cell `direction` from `index` on a
 * `rows × cols` lat/lon grid — or `null` if the step runs off a POLE
 * (surface-nav). PURE arithmetic over the Phase-A bijection
 * (`regionCoords`/`regionIndex`); deterministic.
 *
 *  - `north` decreases latitude (toward row 0), `south` increases it (toward
 *    `rows-1`). Both CLAMP at the poles: stepping north off the top row or south
 *    off the bottom row returns `null` (the handler reports "you're at the pole").
 *    Pole-WRAP is a noted future option; we clamp now for clarity.
 *  - `east`/`west` change longitude and WRAP cyclically (`(lon ± 1) mod cols`) —
 *    the globe is a cycle in longitude, so E/W never returns `null`.
 */
export function moveRegion(
  index: number,
  direction: Direction,
  rows: number,
  cols: number,
): number | null {
  const { lat, lon } = regionCoords(index, rows, cols);
  switch (direction) {
    case "north":
      return lat <= 0 ? null : regionIndex(lat - 1, lon, cols);
    case "south":
      return lat >= rows - 1 ? null : regionIndex(lat + 1, lon, cols);
    case "east":
      return regionIndex(lat, (lon + 1) % cols, cols);
    case "west":
      return regionIndex(lat, (lon - 1 + cols) % cols, cols);
  }
}

// ---------------------------------------------------------------------------
// Surface climate (surface-grid). A region's temperature is the planet's mean
// (radius-derived, kept as the baseline) shaped by its GRID POSITION:
//   • a LATITUDE term — warmest at the equator, coldest at the poles, with the
//     gradient steepness scaled by the planet's `axialTilt` (higher tilt ⇒ a
//     sharper equator-pole split);
//   • a LONGITUDE term — a low-frequency cosine laying down `~rotationSpeed`
//     wet/dry continental bands around the globe (coherent: neighbors are close);
//   • a small per-region JITTER, widened by a long `dayLength` (harsher local
//     swings); and an `eccentricity`-driven global seasonal shift.
// The biome is then chosen from the planet's palette, weighted by that local
// temperature (cold cells favor cold-affinity biomes, hot cells hot-affinity),
// so biomes form latitude bands. This REPLACES the old independent palette draw
// + per-biome temperature offset; the per-region band-clamp is GONE (latitude
// may legitimately push polar cells below freezing / equatorial above boiling).
// ---------------------------------------------------------------------------

/** Planetary-characteristic ranges (documented on `Planet`). */
const AXIAL_TILT_MAX = 90; // degrees, [0, 90]
const DAY_LENGTH_MIN = 4; // hours
const DAY_LENGTH_MAX = 240; // hours
const ECCENTRICITY_MAX = 0.4; // [0, ECCENTRICITY_MAX) ⊂ [0, 1)
const ROTATION_MIN = 0.2; // relative to Earth, > 0
const ROTATION_MAX = 4;

/** Equator-vs-mean temperature amplitude (°C) even at zero axial tilt. */
const LAT_GRADIENT_BASE = 25;
/** Extra equator-vs-mean amplitude (°C) added at maximum axial tilt. */
const LAT_GRADIENT_TILT_COEF = 55;
/** Longitudinal continental swing amplitude (°C). */
const LON_VARIATION_AMP = 14;
/** Base per-region jitter half-range (°C), before the day-length widening. */
const REGION_TEMP_JITTER = 4;
/** Global seasonal shift scale (°C) driven by orbital eccentricity. */
const ECCENTRICITY_TEMP_COEF = 18;
/** How strongly local temperature bends region-biome selection (cf. `AFFINITY_STRENGTH`). */
const REGION_AFFINITY_STRENGTH = 3.5;

/**
 * The climatic temperature (°C) of grid cell `(lat, lon)` on `planet`: the
 * planet mean shaped by latitude (axial-tilt-scaled), longitude (rotation-banded),
 * eccentricity (a global shift), and a day-length-widened per-region jitter.
 * Bounded to `[TEMP_MIN, TEMP_MAX]`. Consumes exactly one `rng()` draw (the
 * jitter), so the region stream stays deterministic.
 */
function regionClimateTemp(
  planet: Planet,
  lat: number,
  lon: number,
  rows: number,
  cols: number,
  rng: Rng,
): number {
  // Latitude: 0 at the equator (middle row), 1 at the poles (rows 0 / rows-1).
  const equator = (rows - 1) / 2;
  const latNorm = equator > 0 ? Math.abs(lat - equator) / equator : 0;
  const gradientAmp =
    LAT_GRADIENT_BASE + LAT_GRADIENT_TILT_COEF * (planet.axialTilt / AXIAL_TILT_MAX);
  const latOffset = gradientAmp * (1 - 2 * latNorm); // +amp equator → −amp pole

  // Longitude: a coherent low-frequency cosine; band count rises with rotation.
  const bands = Math.max(1, Math.round(planet.rotationSpeed * 2));
  const lonAngle = (TWO_PI * bands * lon) / cols + planet.orbitalPhase;
  const lonOffset = LON_VARIATION_AMP * Math.cos(lonAngle);

  // Day length widens the per-region jitter (long days → harsher local extremes).
  const dayFactor =
    1 + (planet.dayLength - DAY_LENGTH_MIN) / (DAY_LENGTH_MAX - DAY_LENGTH_MIN);
  const jitter = (rng() - 0.5) * 2 * REGION_TEMP_JITTER * dayFactor;

  // Eccentricity: a small global seasonal shift (centered so the mean is ~0).
  const eccShift = (planet.eccentricity - ECCENTRICITY_MAX / 2) * ECCENTRICITY_TEMP_COEF;

  const t = planet.temperature + latOffset + lonOffset + eccShift + jitter;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, t));
}

/**
 * Pick a region's biome from the planet's `biomePalette`, weighted by the local
 * climate temperature: each member's `BIOME_WEIGHTS` weight is bent by
 * `exp(REGION_AFFINITY_STRENGTH · affinity · tNorm)` (the same affinity model the
 * palette builder uses), so cold cells favor cold-affinity biomes (tundra) and
 * hot cells favor hot-affinity ones (volcanic/desert), giving latitude BANDS.
 * Always returns a palette member. Consumes one `rng()` draw (the weighted pick),
 * except a single-member palette which is returned without a draw.
 */
function regionBiomeFor(palette: readonly Biome[], regionTemp: number, rng: Rng): Biome {
  if (palette.length === 1) return palette[0]!;
  const tNorm = (regionTemp - TEMP_COMFORT_MID) / 100;
  const weights = palette.map(
    (b) => BIOME_WEIGHTS[b] * Math.exp(REGION_AFFINITY_STRENGTH * BIOME_TEMP_AFFINITY[b] * tNorm),
  );
  return palette[weightedIndex(rng, weights)]!;
}

function atmosphereFor(rng: Rng): Atmosphere {
  return pick(rng, ATMOSPHERES);
}

/**
 * Relative "thickness/hostility" of each atmosphere — a physical property of the
 * atmosphere type, used by gameplay rules: `takeoffCost` (a heavier/corrosive
 * atmosphere is harder to punch out of) and `solarOutput` (a thicker atmosphere
 * lets less sunlight reach the panels). `none` is the lowest (a vacuum is the
 * cheapest to leave and the sunniest for solar); the rest climb roughly with how
 * much the air fights the ship. Non-negative for every `Atmosphere`. Pure.
 */
export function atmosphereDensity(atmosphere: Atmosphere): number {
  const DENSITY: Record<Atmosphere, number> = {
    none: 0,
    thin: 0.3,
    breathable: 1,
    toxic: 1.2,
    inert: 1.4,
    corrosive: 1.6,
    dense: 2,
  };
  return DENSITY[atmosphere] ?? 0;
}

// ---------------------------------------------------------------------------
// Orbits. Each planet orbits its sun on a deterministic ellipse-circle; the
// generator only fixes the SHAPE (radius), SPEED (period) and STARTING ANGLE
// (phase) — the actual position is a pure function of these + wall-clock time,
// computed in `rules.ts` (gen never touches `Date`). Periods are real-time
// milliseconds chosen so a planet completes its "year" over hours-to-weeks, so
// interplanetary distances (and `land` fuel costs) visibly drift between visits.
// ---------------------------------------------------------------------------

/** Orbital radius bounds (AU-ish): inner scorchers to far-flung iceballs. */
const ORBIT_RADIUS_MIN = 0.3;
const ORBIT_RADIUS_MAX = 40;
/** Orbital-period bounds in REAL milliseconds: ~6 hours to ~30 days. */
const ORBIT_PERIOD_MIN_MS = 6 * 60 * 60 * 1000; // 6h
const ORBIT_PERIOD_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const TWO_PI = Math.PI * 2;

/**
 * Generate a single planet. Pure in (seed, coord): the planet keeps its own
 * independent RNG stream keyed by its planet coord — that independence is what
 * lets `planetAt` reproduce a planet without regenerating sibling planets.
 *
 * Size is sampled first (the paper's occurrence) and decides rocky vs gas;
 * temperature is derived from the radius (orbital-distance physics dropped).
 * A GAS giant (`radius >= GAS_RADIUS_THRESHOLD`) is orbit-only — its palette is
 * exactly `["gas"]` and it has 0 surface regions; a ROCKY world gets the full
 * temperature-coupled palette + region count.
 */
function generatePlanet(seed: string, coord: PlanetCoord, sysName: string): Planet {
  const rng = makeRng(
    seed,
    "planet",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
  );

  const atmosphere = atmosphereFor(rng);
  const gravity = Number(randFloat(rng, 0.1, 2.8).toFixed(3)); // g, (0,10]
  // Orbital RADIUS — distance from the sun; no longer drives temperature, but
  // still drives interplanetary `land` fuel (P2). Time-only period/phase follow.
  const orbitalRadius = Number(randFloat(rng, ORBIT_RADIUS_MIN, ORBIT_RADIUS_MAX).toFixed(4));
  // Physical size from the paper's occurrence → size class + rocky/gas split.
  const { sizeClass, radius } = sampleSize(rng);
  const isGas = radius >= GAS_RADIUS_THRESHOLD;
  // Temperature from radius (paper-based per-size zone mix); hazard derives from
  // it (extreme temps ⇒ savage). For rocky worlds the palette's composition +
  // size derive from it too; a gas giant is orbit-only (`["gas"]`, 0 regions).
  const temperature = Number(temperatureFromRadius(radius, rng).toFixed(1));
  // Hazard is the temperature-driven hazard FLOORED by galactic radiation
  // (cascade 0b): coreward (high-radiation) clusters carry a minimum hazard
  // regardless of temperature, which (via the hazard→rarity / hazard→damage
  // couplings) makes the core lethal AND lucrative. `max`, not replace — so a
  // rim world (radiation→0) stays purely temperature-driven.
  const radFloor = radiationHazardFloor(galacticRadiation(coord.cluster));
  const hazard = Number(Math.max(hazardFor(rng, temperature), radFloor).toFixed(4));
  const biomePalette: Biome[] = isGas ? ["gas"] : biomePaletteFor(rng, temperature);
  // SNAP the raw region-count roll to a complete lat×lon grid (`surface-grid`):
  // `regionCount = rows·cols`. The `regionCountFor(rng)` draw stays in this exact
  // stream position (only its VALUE is transformed), so every field drawn after
  // it is byte-identical to before. A gas giant skips the draw (0 regions), as before.
  const regionCount = isGas
    ? 0
    : (() => {
        const { rows, cols } = gridDimsFor(regionCountFor(rng));
        return rows * cols;
      })();
  const orbitalPeriod = Math.round(randFloat(rng, ORBIT_PERIOD_MIN_MS, ORBIT_PERIOD_MAX_MS));
  const orbitalPhase = Number(randFloat(rng, 0, TWO_PI).toFixed(6));
  // Planetary characteristics (`surface-grid`) — APPENDED last so every field
  // above is byte-identical to the pre-surface-grid generator for the same coord.
  // They shape only the per-cell surface climate in `regionAt`.
  const axialTilt = Number(randFloat(rng, 0, AXIAL_TILT_MAX).toFixed(2));
  const dayLength = Number(randFloat(rng, DAY_LENGTH_MIN, DAY_LENGTH_MAX).toFixed(2));
  const eccentricity = Number(randFloat(rng, 0, ECCENTRICITY_MAX).toFixed(4));
  const rotationSpeed = Number(randFloat(rng, ROTATION_MIN, ROTATION_MAX).toFixed(3));
  // Geology profile (cascade tier 4b) — APPENDED last so every field above is
  // byte-identical to the pre-geology generator for the same coord. Each is in
  // [0,1] and biases the per-region FORMATION distribution (see `formationFor`).
  // Where natural, a component RISES with an astronomical-cascade input (tidal
  // stress → volcanism, fast rotation → erosion) mixed 50/50 with an independent
  // draw, so the coupling is real (positive correlation) but not deterministic.
  const eccNorm = eccentricity / ECCENTRICITY_MAX; // [0,1)
  const rotNorm = (rotationSpeed - ROTATION_MIN) / (ROTATION_MAX - ROTATION_MIN); // [0,1]
  const volcanism = Number(
    Math.min(1, Math.max(0, GEOLOGY_COUPLING * eccNorm + (1 - GEOLOGY_COUPLING) * rng())).toFixed(4),
  );
  const impactDensity = Number(rng().toFixed(4));
  const erosion = Number(
    Math.min(1, Math.max(0, GEOLOGY_COUPLING * rotNorm + (1 - GEOLOGY_COUPLING) * rng())).toFixed(4),
  );
  const tectonics = Number(rng().toFixed(4));

  return {
    coord,
    name: planetName(sysName, coord.planet),
    radius,
    sizeClass,
    isGas,
    biomePalette,
    regionCount,
    atmosphere,
    gravity,
    hazard,
    temperature,
    orbitalRadius,
    orbitalPeriod,
    orbitalPhase,
    axialTilt,
    dayLength,
    eccentricity,
    rotationSpeed,
    volcanism,
    impactDensity,
    erosion,
    tectonics,
  };
}

/**
 * The star system at `coord`: its name, star class, planet count, and the
 * full list of planets ORDERED BY ORBITAL DISTANCE — closest first, so
 * `planets[0]` is the innermost planet and the highest index the outermost
 * (planet-distance-order). Each planet's `coord.planet` (and its name letter)
 * equals its index in this sorted list.
 *
 * The reorder happens AFTER generation: each planet is first generated from its
 * own generation-index RNG stream (we need every planet's `orbitalRadius` before
 * we can sort by it), then the array is sorted ascending by `orbitalRadius` and
 * each planet's public index is reassigned to its sorted position. The sort is
 * STABLE — ties on `orbitalRadius` break by the original generation index — so
 * the ordering is byte-identical across runs and JS engines. Only a planet's
 * public index (its `coord.planet` and the `name` letter derived from it) changes;
 * every RNG-derived attribute (radius, temperature, biome palette, deposits,
 * orbit) still comes from its generation stream.
 */
export function systemAt(seed: string, coord: SystemCoord): StarSystem {
  const rng = makeRng(
    seed,
    "system",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
  );

  const name = systemName(rng);
  const starClass = starClassFor(rng);
  const planetCount = randInt(rng, 1, MAX_PLANETS);

  // Generate every planet from its generation-index stream first (orbitalRadius
  // must exist before we can sort by it), tracking that index for a stable tiebreak.
  const generated = [];
  for (let p = 0; p < planetCount; p++) {
    generated.push({
      planet: generatePlanet(seed, { ...coord, planet: p }, name),
      genIndex: p,
    });
  }

  // Sort closest-first by orbital radius; equal radii keep generation order
  // (deterministic, reproducible across engines). Then relabel each planet to its
  // sorted index — both its `coord.planet` and its name letter follow the new
  // position, so index 0 is the innermost world named `…b`.
  const planets: Planet[] = generated
    .sort(
      (a, b) =>
        a.planet.orbitalRadius - b.planet.orbitalRadius || a.genIndex - b.genIndex,
    )
    .map(({ planet }, i) => ({
      ...planet,
      coord: { ...planet.coord, planet: i },
      name: planetName(name, i),
    }));

  return { coord, name, starClass, position: systemPosition(seed, coord), planetCount, planets };
}

/**
 * The planet at `coord`. Because a planet's public index is its position in the
 * system's orbital-distance ordering (planet-distance-order), this can no longer
 * shortcut to a single RNG stream — the planet sitting at sorted index
 * `coord.planet` depends on the whole system's ordering. So it DELEGATES to
 * `systemAt` (regenerating the system — cheap, ≤ `MAX_PLANETS` planets — then
 * sorting + relabeling) and returns `planets[coord.planet]`, agreeing exactly
 * with `systemAt(seed, coord).planets[coord.planet]`.
 *
 * This is NO LONGER O(1) / single-stream, and NO LONGER total over the integers:
 * after the sort, an index outside `[0, planetCount)` has no planet. All
 * navigation callers (`warp`/`land`/`scan`/`map`) validate `planet < planetCount`
 * before calling, so in-range is guaranteed in normal play; an out-of-range index
 * is a caller bug and THROWS a clear error rather than returning `undefined`.
 */
export function planetAt(seed: string, coord: PlanetCoord): Planet {
  const system = systemAt(seed, coord);
  const planet = system.planets[coord.planet];
  if (!planet) {
    throw new Error(
      `planetAt: planet index ${coord.planet} out of range for ${systemKey(coord)} ` +
        `(system has ${system.planetCount}, valid 0–${system.planetCount - 1})`,
    );
  }
  return planet;
}

/**
 * The region at `regionIdx` of the planet at `planetCoord`. PURE &
 * deterministic, with its own RNG stream keyed by the full region coord — so a
 * region reproduces without generating its sibling regions (the planet may have
 * up to ~100,000 of them). The index is a CELL on the planet's lat×lon surface
 * GRID (`surface-grid`): its `biome` is the palette member the local climate at
 * that `(lat, lon)` selects, and its `deposits` use the existing hazard-coupled
 * `depositsFor`, so the savage→rare and rarity→abundance couplings carry down to
 * the region tier. `regionIdx` is NOT range-checked here (gen is total over the
 * integers); callers validate against `planet.regionCount`.
 */
export function regionAt(
  seed: string,
  planetCoord: PlanetCoord,
  regionIdx: number,
): Region {
  const planet = planetAt(seed, planetCoord);
  // Gas giants have NO surface — they carry the exclusive `["gas"]` palette and
  // 0 regions, so a region can never exist for one. Guard it: callers must
  // branch on `planet.isGas` before reaching for a region (every game-layer
  // surface path does). This makes a stray `regionAt` on a gas giant a loud bug
  // rather than a silently-bogus region.
  if (planet.isGas) {
    throw new Error(
      `regionAt: ${planetKey(planetCoord)} is a gas giant — no surface regions`,
    );
  }
  const rng = makeRng(
    seed,
    "region",
    planetCoord.galaxy,
    planetCoord.arm,
    planetCoord.cluster,
    planetCoord.system,
    planetCoord.planet,
    regionIdx,
  );

  // The region index is a CELL on the planet's lat×lon surface grid
  // (`surface-grid`). Climate flows from that position: temperature from latitude
  // (+ longitude / jitter), then the biome is the palette member that climate
  // selects — so biomes form latitude bands, all ⊆ the planet's palette (AC#2).
  const { rows, cols } = regionGrid(planet);
  const { lat, lon } = regionCoords(regionIdx, rows, cols);

  const temperature = Number(
    regionClimateTemp(planet, lat, lon, rows, cols, rng).toFixed(1),
  );
  const biome = regionBiomeFor(planet.biomePalette, temperature, rng);

  // Geological FORMATION (cascade tier 4b) — drawn on a DISTINCT RNG stream
  // (`"formation"`) so reading/assigning it never perturbs the climate/biome draw
  // above (which uses the `"region"` stream). Its distribution tracks the planet's
  // geology profile, and it sets the resource signature `depositsFor` applies.
  const formationRng = makeRng(
    seed,
    "formation",
    planetCoord.galaxy,
    planetCoord.arm,
    planetCoord.cluster,
    planetCoord.system,
    planetCoord.planet,
    regionIdx,
  );
  const formation = formationFor(formationRng, planet);

  // Hazard: the planet's hazard nudged by the biome's offset, clamped to [0,1]
  // (the landing gate stays planet-level, so a region crossing 0/100 in
  // temperature never changes landability).
  const hazard = Number(
    Math.min(1, Math.max(0, planet.hazard + biomeHazardOffset(biome))).toFixed(4),
  );

  // Deposits use the REGION's hazard (savage→rare bites per-region) AND its
  // FORMATION (which minerals concentrate + how richly), layered over the
  // biome-gated pool. So a volcanic-vent region is metal-rich, an impact crater
  // carries rarer ore, etc. — a coherent, learnable resource map.
  const deposits = depositsFor(rng, hazard, biome, formation).map((d) => ({
    resourceId: d.resourceId,
    abundance: Number(d.abundance.toFixed(4)),
  }));

  return {
    coord: { ...planetCoord, region: regionIdx },
    biome,
    formation,
    temperature,
    hazard,
    deposits,
  };
}

// ---------------------------------------------------------------------------
// Exploration sites (Keystone 3) — findable derelicts / ruins / anomalies that
// reward exploration with loot you CAN'T mine: relics, rare materials, and
// credit caches. PURE & deterministic per region coord, on their OWN RNG stream
// (`"site"` / `"site-loot"`, distinct from `regionAt`'s `"region"` stream), so
// reading a site never perturbs region generation. Sites are RARE — a small
// fraction of surface regions bear one — so finding a site is a genuine
// discovery, not a given. Gas giants have no surface regions, hence no sites
// (callers guard `isGas`; `siteAt` is only called for valid surface regions).
// ---------------------------------------------------------------------------

/**
 * Probability a given surface region bears an exploration site. Tuned LOW so
 * sites are a find, not a given (~5% of regions). The seeded universe suite
 * asserts the realized fraction stays a small-but-present slice.
 */
export const SITE_SPAWN_CHANCE = 0.05;

/**
 * The loot table per site type: the material ids it can hold (real
 * `materials.ts` ids — relics + rare minerals) and the credit-cache base. The
 * actual haul scales with the site's `lootTier` (see `siteLoot`). A `derelict`
 * yields salvageable minerals + a fat credit cache; a `ruin` yields precursor
 * relics; an `anomaly` yields the exotic void idol + dust.
 */
const SITE_LOOT_TABLE: Record<Site["type"], { materials: readonly string[]; baseCredits: number }> = {
  derelict: { materials: ["meteoric_dust", "geode_cluster"], baseCredits: 600 },
  ruin: { materials: ["precursor_relic"], baseCredits: 350 },
  anomaly: { materials: ["void_idol", "meteoric_dust"], baseCredits: 450 },
};

/** Largest loot tier a site can roll (≥ 1). Higher tier ⇒ richer loot. */
const SITE_LOOT_TIER_MAX = 3;

/**
 * Whether — and what kind of — exploration site the region at `coord` bears.
 * RARE and deterministic: a single `rng()` draw against `SITE_SPAWN_CHANCE`
 * decides presence, then the site's `type` and `lootTier` are rolled from the
 * SAME `"site"` stream. Returns `null` for the (vast) majority of regions with
 * no site. Pure — no `Date`, no `Math.random`. The `"site"` namespace is
 * distinct from `regionAt`'s `"region"` namespace, so reading a site flag never
 * changes region generation.
 *
 * Gas giants have no surface regions to bear a site; callers guard `isGas`
 * before reaching the surface, so `siteAt` is only ever called for a real
 * surface region coord.
 */
export function siteAt(seed: string, coord: RegionCoord): Site | null {
  const rng = makeRng(
    seed,
    "site",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
    coord.region,
  );
  if (rng() >= SITE_SPAWN_CHANCE) return null;
  const type = pick(rng, SITE_TYPES);
  const lootTier = randInt(rng, 1, SITE_LOOT_TIER_MAX);
  return { type, lootTier };
}

/**
 * The deterministic loot a site holds: a list of `{ id, qty }` materials (real
 * `materials.ts` ids) plus a `credits` cache (always > 0). Higher `lootTier` ⇒
 * better loot — every material's `qty` scales with the tier, as does the credit
 * cache, so a tier-3 site strictly out-rewards a tier-1 site of the same type
 * in the same region. PURE: the per-region credit jitter is keyed on the region
 * coord ONLY (not the tier), so tier-monotonicity holds exactly. The
 * `"site-loot"` stream is distinct from both `"site"` and `"region"`.
 */
export function siteLoot(
  seed: string,
  coord: RegionCoord,
  site: Site,
): { materials: { id: string; qty: number }[]; credits: number } {
  const rng = makeRng(
    seed,
    "site-loot",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
    coord.region,
  );
  const table = SITE_LOOT_TABLE[site.type];
  // Per-region credit jitter, keyed on the region coord only (drawn before any
  // tier scaling), so it's identical across tiers ⇒ credits rise strictly with
  // tier.
  const jitter = randInt(rng, 0, 200);
  const materials = table.materials.map((id) => ({ id, qty: site.lootTier }));
  const credits = table.baseCredits * site.lootTier + jitter;
  return { materials, credits };
}

// ---------------------------------------------------------------------------
// Orbital derelicts (Keystone 3c) — the orbital counterpart to the surface
// exploration sites above: a drifting wreck/hulk you find while ORBITING a
// planet, salvageable from the safety of your ship (no surface, no hazard). One
// per PLANET (unlike surface sites, which are per-region), on DISTINCT RNG
// streams (`"orbital-site"` / `"orbital-loot"`) so reading one never perturbs
// `planetAt`/`regionAt`/`siteAt`. Works for ALL planets — INCLUDING gas giants,
// which have no surface and so otherwise carry no findable content. RARE: only a
// small fraction of planets drift a derelict, so finding one is a real discovery.
// ---------------------------------------------------------------------------

/**
 * Probability a given planet drifts an orbital derelict in its orbit. Tuned LOW
 * (~6%) so an orbital find is a genuine discovery, not a given. The seeded suite
 * asserts the realized fraction stays a small-but-present slice (and that gas
 * giants get them too).
 */
export const ORBITAL_SITE_SPAWN_CHANCE = 0.06;

/**
 * The site kinds an orbital wreck can be: a `derelict` (an abandoned ship — the
 * natural orbital find) or an `anomaly` (an exotic phenomenon adrift). Ruins are
 * SURFACE-only (they sit on the ground), so they're excluded here.
 */
const ORBITAL_SITE_TYPES = ["derelict", "anomaly"] as const satisfies readonly Site["type"][];

/** Smallest/largest loot tier an orbital wreck rolls — pitched a tier above the
 * surface range (`SITE_LOOT_TIER_MAX = 3`) so orbital hulks out-reward surface
 * sites (bigger hauls; AC#1). */
const ORBITAL_LOOT_TIER_MIN = 2;
const ORBITAL_LOOT_TIER_MAX = 4;

/** Extra credit-cache multiplier for orbital wrecks over a surface site of the
 * same type/tier — orbital hulks are the richer haul. */
const ORBITAL_LOOT_CREDIT_BONUS = 1.5;

/**
 * Whether — and what kind of — orbital derelict the planet at `coord` carries.
 * RARE and deterministic: a single `rng()` draw against `ORBITAL_SITE_SPAWN_CHANCE`
 * decides presence, then the wreck's `type` and `lootTier` are rolled from the
 * SAME `"orbital-site"` stream (keyed by the PLANET coord — one slot per planet).
 * Returns `null` for the (vast) majority of planets. Works for gas giants too
 * (it's in orbit, not on a surface). Pure — no `Date`, no `Math.random`. The
 * `"orbital-site"` namespace is distinct from `planetAt`/`regionAt`/`siteAt`, so
 * reading it never changes any other generation.
 */
export function orbitalSiteAt(seed: string, coord: PlanetCoord): Site | null {
  const rng = makeRng(
    seed,
    "orbital-site",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
  );
  if (rng() >= ORBITAL_SITE_SPAWN_CHANCE) return null;
  const type = pick(rng, ORBITAL_SITE_TYPES);
  const lootTier = randInt(rng, ORBITAL_LOOT_TIER_MIN, ORBITAL_LOOT_TIER_MAX);
  return { type, lootTier };
}

/**
 * The deterministic loot an orbital derelict holds: `{ id, qty }` materials (real
 * `materials.ts` ids — relics + rare minerals, the same per-type tables surface
 * sites draw from) plus a `credits` cache (always > 0). Pitched RICHER than a
 * surface site of the same type: a bigger per-material `qty` (`lootTier + 1`) and
 * a credit cache scaled by `ORBITAL_LOOT_CREDIT_BONUS`. Higher `lootTier` ⇒
 * better loot. PURE: the per-planet jitter is keyed on the planet coord only
 * (drawn before any tier scaling), so tier-monotonicity holds. The
 * `"orbital-loot"` stream is distinct from `"orbital-site"`/`"site"`/`"region"`.
 */
export function orbitalSiteLoot(
  seed: string,
  coord: PlanetCoord,
  site: Site,
): { materials: { id: string; qty: number }[]; credits: number } {
  const rng = makeRng(
    seed,
    "orbital-loot",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
  );
  const table = SITE_LOOT_TABLE[site.type];
  const jitter = randInt(rng, 0, 400);
  const materials = table.materials.map((id) => ({ id, qty: site.lootTier + 1 }));
  const credits = Math.round(table.baseCredits * site.lootTier * ORBITAL_LOOT_CREDIT_BONUS) + jitter;
  return { materials, credits };
}

// ---------------------------------------------------------------------------
// Settlements & orbital outposts (P11) — the inhabited places of the universe.
//
// Two kinds of populated location, both PURE & deterministic (seed + coords ⇒
// identical output, nothing stored):
//
//  1. SETTLEMENTS sit on the SURFACE, in a single region. A region only bears a
//     settlement when its PLANET is temperate (mean temperature strictly inside
//     the 0–100°C band), its REGION's biome is one of `HABITABLE_BIOMES` (the
//     liveable, lusher ones), AND a density-weighted roll passes. The roll's
//     probability is the PRODUCT of a per-system and a per-planet density factor,
//     each drawn with HIGH variance — so some systems/planets are bustling and
//     others empty, and settlement frequency varies heavily across BOTH tiers.
//
//  2. ORBITAL OUTPOSTS are stations in orbit, NOT surface regions (no biome /
//     deposits / `regionAt` row). About two planets per system carry one. They
//     are reached by docking (the `region = -1` sentinel in the game layer);
//     gen only decides WHICH planet indices host one.
//
// Trade at these places is P12 — this phase is generation + navigation only.
// ---------------------------------------------------------------------------

/**
 * The biomes a settlement can occupy: the liveable, lusher ones. Deliberately
 * excludes the harsh biomes (`volcanic`/`toxic`/`irradiated`/`gas`) and the
 * lifeless `barren`. Exported so the game layer and tests can gate on it.
 */
export const HABITABLE_BIOMES: readonly Biome[] = [
  "ocean",
  "jungle",
  "desert",
] as const;

const HABITABLE_SET = new Set<Biome>(HABITABLE_BIOMES);

/**
 * A settlement-density factor in [0, 1] drawn with HIGH variance: the raw
 * uniform draw is the factor directly, so factors span the full range (near-0
 * "empty" through near-1 "bustling") with a flat distribution. Used at both the
 * system and planet tiers; multiplying two such factors gives the per-region
 * settlement probability, so a region is dense only when BOTH its system and
 * its planet are settlement-friendly.
 */
function settlementDensityRoll(rng: Rng): number {
  return rng();
}

/** Per-SYSTEM settlement-density factor in [0, 1] (its own RNG stream). */
function systemSettlementDensity(seed: string, coord: SystemCoord): number {
  return settlementDensityRoll(
    makeRng(seed, "settlement-system", coord.galaxy, coord.arm, coord.cluster, coord.system),
  );
}

/** Per-PLANET settlement-density factor in [0, 1] (its own RNG stream). */
function planetSettlementDensity(seed: string, coord: PlanetCoord): number {
  return settlementDensityRoll(
    makeRng(
      seed,
      "settlement-planet",
      coord.galaxy,
      coord.arm,
      coord.cluster,
      coord.system,
      coord.planet,
    ),
  );
}

/**
 * Whether the region at `coord` bears a settlement. True only when ALL hold:
 *  - the PLANET is temperate (mean temperature strictly within `FREEZING_C` …
 *    `BOILING_C`) — no settlements on boiling or freezing worlds;
 *  - the REGION's biome ∈ `HABITABLE_BIOMES`;
 *  - a roll against `systemDensity × planetDensity` passes (the two density
 *    factors carry the heavy per-system × per-planet frequency variance).
 * Pure & deterministic. The region's own RNG stream (`"settlement"`) is distinct
 * from the one `regionAt` uses, so reading the settlement flag never perturbs
 * region generation.
 */
export function hasSettlement(seed: string, coord: RegionCoord): boolean {
  const planet = planetAt(seed, coord);
  // Gas giants have no surface, so no surface settlement (and `regionAt` would
  // throw on one). They may still host an ORBITAL outpost (`hasOutpost`).
  if (planet.isGas) return false;
  if (!(planet.temperature > FREEZING_C && planet.temperature < BOILING_C)) {
    return false;
  }
  const region = regionAt(seed, coord, coord.region);
  if (!HABITABLE_SET.has(region.biome)) return false;

  const probability =
    systemSettlementDensity(seed, coord) * planetSettlementDensity(seed, coord);
  const rng = makeRng(
    seed,
    "settlement",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
    coord.planet,
    coord.region,
  );
  return rng() < probability;
}

/**
 * The planet indices in `coord`'s system that host an orbital outpost — about
 * two per system (1–3, capped at the system's planet count), each a valid index
 * in `[0, planetCount)`, returned sorted ascending. Pure & deterministic.
 */
export function systemOutpostPlanets(seed: string, coord: SystemCoord): number[] {
  const planetCount = systemAt(seed, coord).planetCount;
  const rng = makeRng(
    seed,
    "outposts",
    coord.galaxy,
    coord.arm,
    coord.cluster,
    coord.system,
  );
  // ~2 per system (1–3), never more outposts than the system has planets.
  const target = Math.min(planetCount, randInt(rng, 1, 3));

  // Partial Fisher–Yates: shuffle the first `target` slots to pick that many
  // DISTINCT planet indices deterministically.
  const indices = Array.from({ length: planetCount }, (_, i) => i);
  for (let i = 0; i < target; i++) {
    const j = i + Math.floor(rng() * (planetCount - i));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }
  return indices.slice(0, target).sort((a, b) => a - b);
}

/** Whether the planet at `coord` has an orbital outpost in its system. */
export function hasOutpost(seed: string, coord: PlanetCoord): boolean {
  return systemOutpostPlanets(seed, {
    galaxy: coord.galaxy,
    arm: coord.arm,
    cluster: coord.cluster,
    system: coord.system,
  }).includes(coord.planet);
}

// ---------------------------------------------------------------------------
// Safe starting world (planet-taxonomy).
//
// Since ~half of all planets are now non-landable gas giants, the old hardcoded
// `(0,0,0,0,0,0)` spawn may land a player in orbit of a gas giant with nothing
// to do. `startingWorld(seed)` deterministically finds a genuinely safe spawn —
// a ROCKY, MODERATE-temperature, low-hazard world — by scanning outward from the
// origin. Shared by BOTH the reset migration's player relocation and
// `getOrCreatePlayer`'s new-player spawn, so the two never disagree.
// ---------------------------------------------------------------------------

/** Hazard ceiling for a "safe" starting world (moderate worlds always sit below this). */
const STARTING_WORLD_MAX_HAZARD = 0.4;
/** How many systems out from the origin to scan before giving up (a match is found early). */
const STARTING_WORLD_SCAN_LIMIT = 10000;
/**
 * The cluster ring new players spawn in (cascade 0b). The CORE (cluster 0) is now
 * lethally irradiated — every cluster-0 planet carries the radiation hazard floor
 * AND demands a `radiation_shield` to land on, which a fresh player can't have, so
 * spawning there is a softlock. We spawn at the OUTERMOST rim ring instead, where
 * galactic radiation → 0: no shield needed, low hazard floor, genuinely calm
 * worlds. This also sets up the intended progression — start on the quiet rim,
 * journey inward toward the dangerous, ore-rich core.
 */
export const SPAWN_CLUSTER = MAX_CLUSTERS_PER_ARM - 1;

/**
 * The deterministic safe starting world for `seed`: the FIRST planet — scanning
 * systems outward from the rim spawn ring (galaxy 0, arm 0, `SPAWN_CLUSTER`,
 * system 0, 1, 2…), and planets in index order within each — that is ROCKY (not a
 * gas giant), MODERATE-temperature (`0 < T < 100`), and low-hazard. Pure &
 * deterministic. Moderate-temperature rocky worlds are common, so the scan
 * terminates within a handful of systems; the bounded limit + origin fallback
 * guarantee it returns.
 */
export function startingWorld(seed: string): PlanetCoord {
  for (let system = 0; system < STARTING_WORLD_SCAN_LIMIT; system++) {
    const sysCoord: SystemCoord = { galaxy: 0, arm: 0, cluster: SPAWN_CLUSTER, system };
    const sys = systemAt(seed, sysCoord);
    for (let p = 0; p < sys.planetCount; p++) {
      const planet = sys.planets[p]!;
      if (
        !planet.isGas &&
        planet.temperature > FREEZING_C &&
        planet.temperature < BOILING_C &&
        planet.hazard <= STARTING_WORLD_MAX_HAZARD
      ) {
        return { galaxy: 0, arm: 0, cluster: SPAWN_CLUSTER, system, planet: p };
      }
    }
  }
  // Unreachable in practice (moderate rocky worlds are plentiful); the rim spawn
  // ring's first system is a deterministic last resort.
  return { galaxy: 0, arm: 0, cluster: SPAWN_CLUSTER, system: 0, planet: 0 };
}

/** Max retry budget for `randomStartingWorld` before falling back to `startingWorld`. */
const RANDOM_SPAWN_MAX_TRIES = 64;

/**
 * A RANDOM habitable planet coord on the rim spawn ring (galaxy 0, arm 0,
 * `SPAWN_CLUSTER`). "Habitable" = same criteria as `startingWorld`: rocky,
 * temperate (0 < T < 100), low-hazard. Spawns at the rim (not the lethally
 * irradiated core) for the reasons documented on `SPAWN_CLUSTER`. Each attempt
 * draws a random system index via the injected `rand` (∈ [0,1)), generates that
 * system, collects its habitable planets, and if any exist picks one uniformly.
 * `rand` is INJECTED (not `Math.random` inside) so the function stays
 * pure/deterministic given a fixed `rand` sequence and is unit-testable without
 * side-effects. Falls back to `startingWorld(seed)` if the retry budget is
 * exhausted.
 */
export function randomStartingWorld(
  seed: string,
  rand: () => number,
): PlanetCoord {
  for (let i = 0; i < RANDOM_SPAWN_MAX_TRIES; i++) {
    const system = Math.floor(rand() * STARS_PER_CLUSTER);
    const sysCoord: SystemCoord = { galaxy: 0, arm: 0, cluster: SPAWN_CLUSTER, system };
    const sys = systemAt(seed, sysCoord);
    const habitable = sys.planets.filter(
      (p) =>
        !p.isGas &&
        p.temperature > FREEZING_C &&
        p.temperature < BOILING_C &&
        p.hazard <= STARTING_WORLD_MAX_HAZARD,
    );
    if (habitable.length > 0) {
      const planet = habitable[Math.floor(rand() * habitable.length)]!;
      return { galaxy: 0, arm: 0, cluster: SPAWN_CLUSTER, system, planet: planet.coord.planet };
    }
  }
  return startingWorld(seed);
}
