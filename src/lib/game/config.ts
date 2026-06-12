/**
 * Pure, lazily-read game configuration helpers.
 *
 * These parse server-only env vars but NEVER at import/top level — a caller
 * invokes them on a real request path, so secret-free `next build` / `vitest`
 * stay green (the same discipline as `src/lib/env.ts`). Pure given an explicit
 * env bag, so they're unit-testable without touching `process.env`.
 */

/** Env var that decides which MANIFOLD a new player spawns into (manifolds phase). */
export const SPAWN_MANIFOLD_ENV = "OMNIPLEX_SPAWN_MANIFOLD";

/** The prime universe (prod) manifold — the default when the env var is unset. */
export const DEFAULT_SPAWN_MANIFOLD = 0;

/**
 * The manifold a new player should spawn into, parsed from
 * `OMNIPLEX_SPAWN_MANIFOLD` (server-only; NOT in `REQUIRED_SERVER_ENV`):
 *  - unset / blank → `DEFAULT_SPAWN_MANIFOLD` (0 = the prime universe / prod);
 *  - a valid integer (e.g. `-1` for the isolated test universe) → that integer;
 *  - a non-integer / unparseable value → falls back to 0 (never throws).
 *
 * Prod leaves the var unset (→ 0); the staging env sets it to `-1` so every test
 * account is born in the airtight test manifold (`−1`), disjoint from prod data.
 * Pure: reads only the supplied `env` bag (defaults to `process.env`).
 */
export function spawnManifold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[SPAWN_MANIFOLD_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SPAWN_MANIFOLD;
  const n = Number(raw.trim());
  return Number.isInteger(n) ? n : DEFAULT_SPAWN_MANIFOLD;
}
