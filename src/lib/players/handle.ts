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

/** Minimum / maximum handle length (inclusive), measured after trimming. */
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

/**
 * Handles that read as system/role identities — refused so a player can't
 * impersonate the game itself or the "unknown" fallback used when a handle can't
 * be resolved (see `world.ts`). Compared against the lowercased candidate.
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "system",
  "omniplex",
  "moderator",
  "mod",
  "root",
  "null",
  "undefined",
  "anonymous",
  "unknown",
]);

/** Result of {@link validateHandle}: the normalized value, or a human reason. */
export type HandleValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Validate a player-chosen public handle. PURE — no IO — so the `rename` handler
 * and unit tests share one rule set.
 *
 * Rules: trim surrounding whitespace; allow only letters, digits, dash (`-`) and
 * underscore (`_`); length {@link HANDLE_MIN_LENGTH}–{@link HANDLE_MAX_LENGTH}
 * after trimming; no `@`, no spaces, no leading/trailing dash; reject empty or a
 * reserved/role-looking name.
 *
 * Case is normalized to LOWERCASE — generated callsigns are already lowercase
 * slugs, handles are matched/displayed case-insensitively in practice, and a
 * single canonical case keeps uniqueness from being side-stepped by casing
 * (`Nova` vs `nova`). The returned `value` is the lowercased, trimmed handle to
 * persist.
 */
export function validateHandle(name: string): HandleValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "a username can't be empty" };
  }
  // Charset check on the trimmed (pre-lowercase) value: only a–z/A–Z, 0–9, '-'
  // and '_'. This rejects '@' and spaces with one rule, matching the message.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return {
      ok: false,
      reason: "a username may use only letters, digits, dashes and underscores",
    };
  }
  if (trimmed.startsWith("-") || trimmed.endsWith("-")) {
    return { ok: false, reason: "a username can't start or end with a dash" };
  }
  if (trimmed.length < HANDLE_MIN_LENGTH || trimmed.length > HANDLE_MAX_LENGTH) {
    return {
      ok: false,
      reason: `a username must be ${HANDLE_MIN_LENGTH}–${HANDLE_MAX_LENGTH} characters`,
    };
  }
  const value = trimmed.toLowerCase();
  if (RESERVED_HANDLES.has(value)) {
    return { ok: false, reason: `"${trimmed}" is a reserved username` };
  }
  return { ok: true, value };
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
