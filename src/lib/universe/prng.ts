/**
 * Seeded, deterministic PRNG primitives for the procedural universe.
 *
 * The whole universe is recomputed from `hash(WORLD_SEED, coords)` and never
 * stored, so the generator must be byte-identical across processes and JS
 * engines, with NO dependence on `Math.random`, `Date`, locale, or float
 * formatting. We use two well-known, public-domain algorithms:
 *
 *   - `cyrb128`  — hashes an arbitrary string into four 32-bit seed words.
 *   - `sfc32`    — Simple Fast Counter; a fast 32-bit PRNG with good
 *                  statistical quality, fed those four words.
 *
 * Both are pure integer math (`>>> 0`, `Math.imul`) and therefore identical
 * everywhere V8/JSC/SpiderMonkey run. No runtime dependency is added.
 */

/**
 * cyrb128 string hash → four 32-bit unsigned seed words.
 * Public-domain reference implementation (bryc, "Hash and PRNG" gist).
 */
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** A pure random source: each call returns a float in [0, 1). */
export type Rng = () => number;

/**
 * sfc32 PRNG seeded from four 32-bit words. Returns a function yielding
 * floats in [0, 1). Public-domain reference implementation.
 */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;
  return function next(): number {
    s0 >>>= 0;
    s1 >>>= 0;
    s2 >>>= 0;
    s3 >>>= 0;
    let t = (s0 + s1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) | 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s3 = (s3 + 1) | 0;
    t = (t + s3) | 0;
    s2 = (s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Build a deterministic RNG stream from a world seed and any number of
 * namespace parts (coords, salts). The parts are joined with a separator so
 * that, e.g., (1, 23) and (12, 3) can never collide into the same string.
 */
export function makeRng(seed: string, ...parts: (string | number)[]): Rng {
  const namespaced = `${seed}|${parts.join("/")}`;
  const [a, b, c, d] = cyrb128(namespaced);
  const rng = sfc32(a, b, c, d);
  // Discard the first few outputs to wash out any seed-correlation in the
  // very first values (a common, cheap robustness step for counter PRNGs).
  rng();
  rng();
  rng();
  return rng;
}

// ---------------------------------------------------------------------------
// Small pure helpers built on top of an Rng. These keep gen.ts readable and
// make the sampling logic individually testable.
// ---------------------------------------------------------------------------

/** Uniform float in [min, max). */
export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniform integer in [min, max] (inclusive). */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Pick one element of `items` uniformly. `items` must be non-empty. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/**
 * Weighted pick: choose an index of `weights` proportional to its value.
 * Weights must be non-negative and sum to a positive number.
 */
export function weightedIndex(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1; // float-rounding fallback
}
