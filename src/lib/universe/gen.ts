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
  STAR_CLASSES,
  type Atmosphere,
  type Biome,
  type ClusterCoord,
  type Galaxy,
  type Planet,
  type PlanetCoord,
  type Region,
  type RegionCoord,
  type ResourceDeposit,
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

/**
 * Tier weights for `warpDistance`. `CLUSTER_SPAN = 10 * STAR_CLUSTER_SIGMA`
 * (= 100), so a single cluster hop (10σ) cleanly exceeds the cloud diameter
 * (2 * STAR_CLUSTER_MAX_RADIUS = 8σ) — clusters are spatially non-overlapping.
 * `ARM_SPAN = CLUSTER_SPAN` (same cost for now; to be revisited). `SYSTEM_SPAN`
 * is the multiplier on the intra-cluster Euclidean distance. Exported so
 * callers/tests can reason about the metric.
 */
export const CLUSTER_SPAN = 10 * STAR_CLUSTER_SIGMA; // 100 — a cluster hop exceeds the cloud diameter
export const ARM_SPAN = CLUSTER_SPAN; // same cost as a cluster hop for now
export const SYSTEM_SPAN = 1;

/**
 * Distance between two systems within the SAME galaxy (0 to self, symmetric,
 * positive between distinct same-galaxy coords). A weighted sum over the tiers
 * with arm-ring wrapping: the arm term is `min(|Δarm|, armCount − |Δarm|)`, so
 * in a 12-arm galaxy a difference of 5 and a difference of 7 are the same
 * distance (the ring is symmetric).
 *
 * The SYSTEM term is GEOMETRIC (star-coordinates): when `a` and `b` are in the
 * same galaxy, arm AND cluster, it is the EUCLIDEAN distance between their
 * `(x, y, z)` star positions × `SYSTEM_SPAN` (derived via `systemPosition` —
 * hence the seed). Across different clusters or arms the system term is `0` —
 * stars live in different clouds (positions not comparable) and the cluster/arm
 * terms fully capture inter-cluster distance. Different galaxies return
 * `Infinity` — inter-galaxy travel is NOT a warp (condensate-gated). Callers
 * supply `armCount` from `galaxyAt(coord.galaxy).armCount`.
 * PURE — positions are derived from the seed, no hidden global.
 */
export function warpDistance(
  seed: string,
  a: SystemCoord,
  b: SystemCoord,
  armCount: number,
): number {
  if (a.galaxy !== b.galaxy) return Infinity;
  const rawArm = Math.abs(a.arm - b.arm);
  const armRing = Math.min(rawArm, armCount - rawArm);
  const sameCluster = a.arm === b.arm && a.cluster === b.cluster;
  let systemTerm: number;
  if (sameCluster) {
    const pa = systemPosition(seed, a);
    const pb = systemPosition(seed, b);
    systemTerm = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) * SYSTEM_SPAN;
  } else {
    systemTerm = 0; // different clusters/arms: cluster/arm terms capture the gap
  }
  return (
    armRing * ARM_SPAN +
    Math.abs(a.cluster - b.cluster) * CLUSTER_SPAN +
    systemTerm
  );
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
 * Draw the deposits for a region of the given `biome`. Most regions get 1–3
 * deposits; a minority are barren. The candidate pool is biome-aware —
 * `mineralsForBiome(biome)` = every general mineral plus the biome-specific ones
 * for THIS biome, so a deposit can never be a mineral specific to a different
 * biome. Each slot picks a distinct resource from that pool weighted by
 * `rarityWeight(rarity, hazard)`, so the savage→rare coupling still applies over
 * the filtered pool. Determinism is preserved (the biome is rolled before this,
 * so the pool is a deterministic function of the region coord).
 */
function depositsFor(rng: Rng, hazard: number, biome: Biome): ResourceDeposit[] {
  // 0:barren  1  2  3  — most regions carry at least one deposit (>0.5).
  const slots = [1, 1, 2, 2, 2, 3, 3, 0][randInt(rng, 0, 7)]!;
  if (slots === 0) return [];

  const available = mineralsForBiome(biome);
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
/**
 * Margin (°C) a clamped region temperature is held strictly OFF the 0/100 lines,
 * so that after rounding to one decimal a boiling planet's regions still read
 * `> 100` and a freezing planet's `< 0` (and never land exactly on the line,
 * which `band()` treats as moderate).
 */
const BAND_MARGIN = 0.1;

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

/**
 * Clamp a region's temperature to the SAME band (relative to 0°C / 100°C) as its
 * planet, so region variation can never read as a different landing category.
 * Inputs are one-decimal-rounded; the `BAND_MARGIN` push keeps boiling regions
 * strictly `> 100` and freezing regions strictly `< 0` even after rounding.
 */
function clampRegionTemp(regionTemp: number, planetTemp: number): number {
  if (planetTemp > BOILING_C) return Math.max(regionTemp, BOILING_C + BAND_MARGIN);
  if (planetTemp < FREEZING_C) return Math.min(regionTemp, FREEZING_C - BAND_MARGIN);
  return Math.min(BOILING_C, Math.max(FREEZING_C, regionTemp));
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
 * Roll a planet's region count LOG-uniformly across
 * `[REGION_COUNT_MIN, REGION_COUNT_MAX]` = `[100, 100000]`:
 * `round(10 ** randFloat(2, 5))`, then clamped to the bounds. Log-uniform (vs
 * linear) is what gives the wide spread — small ~10² planets and huge ~10⁵ ones
 * both occur with comparable frequency rather than nearly every planet maxing
 * out.
 */
function regionCountFor(rng: Rng): number {
  const raw = Math.round(10 ** randFloat(rng, 2, 5));
  return Math.min(REGION_COUNT_MAX, Math.max(REGION_COUNT_MIN, raw));
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
  const hazard = Number(hazardFor(rng, temperature).toFixed(4));
  const biomePalette: Biome[] = isGas ? ["gas"] : biomePaletteFor(rng, temperature);
  const regionCount = isGas ? 0 : regionCountFor(rng);
  const orbitalPeriod = Math.round(randFloat(rng, ORBIT_PERIOD_MIN_MS, ORBIT_PERIOD_MAX_MS));
  const orbitalPhase = Number(randFloat(rng, 0, TWO_PI).toFixed(6));

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
 * The region at `regionIndex` of the planet at `planetCoord`. PURE &
 * deterministic, with its own RNG stream keyed by the full region coord — so a
 * region reproduces without generating its sibling regions (the planet may have
 * up to 100,000 of them). Its `biome` is drawn from the planet's
 * `biomePalette`, and its `deposits` use the existing hazard-coupled
 * `depositsFor`, so the savage→rare and rarity→abundance couplings carry down to
 * the region tier. `regionIndex` is NOT range-checked here (gen is total over
 * the integers); callers validate against `planet.regionCount`.
 */
export function regionAt(
  seed: string,
  planetCoord: PlanetCoord,
  regionIndex: number,
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
    regionIndex,
  );

  // Biome is always a member of the planet's palette (AC#2). It's rolled before
  // temperature/hazard/deposits so the per-region offsets and the biome-aware
  // candidate pool are deterministic functions of the region coord.
  const biome = pick(rng, planet.biomePalette);

  // Per-region temperature & hazard: the planet's mean nudged by the biome, then
  // (temperature) clamped to the planet's 0/100 band so a region never reads as
  // a different landing category, and (hazard) clamped to [0, 1].
  const temperature = Number(
    clampRegionTemp(
      Number((planet.temperature + biomeTempOffset(biome)).toFixed(1)),
      planet.temperature,
    ).toFixed(1),
  );
  const hazard = Number(
    Math.min(1, Math.max(0, planet.hazard + biomeHazardOffset(biome))).toFixed(4),
  );

  // Deposits use the REGION's hazard now, so the savage→rare coupling bites
  // per-region: a volcanic region carries rarer ore than a calm one alongside it.
  const deposits = depositsFor(rng, hazard, biome).map((d) => ({
    resourceId: d.resourceId,
    abundance: Number(d.abundance.toFixed(4)),
  }));

  return {
    coord: { ...planetCoord, region: regionIndex },
    biome,
    temperature,
    hazard,
    deposits,
  };
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
 * The deterministic safe starting world for `seed`: the FIRST planet — scanning
 * systems outward from the origin (galaxy 0, arm 0, cluster 0, system 0, 1, 2…),
 * and planets in index order within each — that is ROCKY (not a gas giant),
 * MODERATE-temperature (`0 < T < 100`), and low-hazard. Pure & deterministic.
 * Moderate-temperature rocky worlds are common, so the scan terminates within a
 * handful of systems; the bounded limit + origin fallback guarantee it returns.
 */
export function startingWorld(seed: string): PlanetCoord {
  for (let system = 0; system < STARTING_WORLD_SCAN_LIMIT; system++) {
    const sysCoord: SystemCoord = { galaxy: 0, arm: 0, cluster: 0, system };
    const sys = systemAt(seed, sysCoord);
    for (let p = 0; p < sys.planetCount; p++) {
      const planet = sys.planets[p]!;
      if (
        !planet.isGas &&
        planet.temperature > FREEZING_C &&
        planet.temperature < BOILING_C &&
        planet.hazard <= STARTING_WORLD_MAX_HAZARD
      ) {
        return { galaxy: 0, arm: 0, cluster: 0, system, planet: p };
      }
    }
  }
  // Unreachable in practice (moderate rocky worlds are plentiful); the origin is
  // a deterministic last resort.
  return { galaxy: 0, arm: 0, cluster: 0, system: 0, planet: 0 };
}

/** Max retry budget for `randomStartingWorld` before falling back to `startingWorld`. */
const RANDOM_SPAWN_MAX_TRIES = 64;

/**
 * A RANDOM habitable planet coord in cluster 0 (galaxy 0, arm 0, cluster 0).
 * "Habitable" = same criteria as `startingWorld`: rocky, temperate (0 < T < 100),
 * low-hazard. Each attempt draws a random system index via the injected `rand`
 * (∈ [0,1)), generates that system, collects its habitable planets, and if any
 * exist picks one uniformly. `rand` is INJECTED (not `Math.random` inside) so
 * the function stays pure/deterministic given a fixed `rand` sequence and is
 * unit-testable without side-effects. Falls back to `startingWorld(seed)` if
 * the retry budget is exhausted.
 */
export function randomStartingWorld(
  seed: string,
  rand: () => number,
): PlanetCoord {
  for (let i = 0; i < RANDOM_SPAWN_MAX_TRIES; i++) {
    const system = Math.floor(rand() * STARS_PER_CLUSTER);
    const sysCoord: SystemCoord = { galaxy: 0, arm: 0, cluster: 0, system };
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
      return { galaxy: 0, arm: 0, cluster: 0, system, planet: planet.coord.planet };
    }
  }
  return startingWorld(seed);
}
