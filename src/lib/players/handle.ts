/**
 * Handle generation + uniqueness — pure, unit-tested helpers.
 *
 * A new player's handle is a NON-IDENTIFYING generated callsign: a space-y
 * word from a built-in list plus a short random suffix (e.g. `nomad-7f3`).
 * Handles are PUBLIC (leaderboard / `who` / bases), so they must never be
 * derived from the player's email — doing that would leak real names. If a
 * generated callsign is already taken, `uniqueHandle` suffixes it
 * (`name`, `name-2`, …) and the bootstrap loop also regenerates on collision.
 */

/**
 * Built-in pool of evocative, non-identifying callsign words. Kept lowercase
 * and alphanumeric so the result is already a terminal-friendly slug.
 */
export const CALLSIGN_WORDS: readonly string[] = [
  "nomad",
  "drifter",
  "ranger",
  "comet",
  "vega",
  "orion",
  "nova",
  "pulsar",
  "quasar",
  "rover",
  "voyager",
  "falcon",
  "specter",
  "horizon",
  "zenith",
  "aurora",
  "corsair",
  "wanderer",
  "phantom",
  "nebula",
];

/** Characters used in the random callsign suffix (lowercase alphanumeric). */
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Length of the random suffix appended to a callsign word. */
const SUFFIX_LENGTH = 3;

/**
 * Generate a non-identifying callsign handle: a random word from
 * `CALLSIGN_WORDS` plus a short random suffix, joined by a dash
 * (e.g. `"comet-7f3"`). The result is a terminal-friendly slug and is
 * derived ONLY from `rng` — never from any player-identifying input.
 *
 * `rng` defaults to `Math.random` (fine here — this runs in a request
 * handler, not the deterministic universe gen); it is injectable so tests
 * can drive it deterministically.
 */
export function generateCallsign(rng: () => number = Math.random): string {
  const word = CALLSIGN_WORDS[Math.floor(rng() * CALLSIGN_WORDS.length)];
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    suffix += SUFFIX_ALPHABET[Math.floor(rng() * SUFFIX_ALPHABET.length)];
  }
  return `${word}-${suffix}`;
}

/**
 * Return a handle that is not present in `taken`. If `desired` is free it's
 * returned as-is; otherwise the lowest free `desired-N` (N starting at 2) is
 * chosen. Deterministic: same `desired` + same `taken` set ⇒ same result.
 */
export function uniqueHandle(desired: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(desired)) return desired;
  let n = 2;
  while (set.has(`${desired}-${n}`)) n += 1;
  return `${desired}-${n}`;
}
