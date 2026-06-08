/**
 * Production server-env validation.
 *
 * The Supabase clients init lazily and only throw when actually invoked
 * (`server.ts`, `config.ts`), which keeps `next build` and `vitest` working
 * with no secrets. The cost of that design is that a *misconfigured
 * production* deploy doesn't fail loudly — it fails deep inside the first
 * command that touches the DB, with a confusing stack trace.
 *
 * This helper closes that gap WITHOUT reintroducing build-time validation:
 *   - `checkServerEnv()` is a pure inspector (no throwing, no I/O) that reports
 *     which required vars are missing. The health endpoint uses it.
 *   - `assertServerEnv()` throws a single clear, actionable error listing every
 *     missing var. Call it on a real runtime/request path — NEVER at module
 *     import/top level, or you'd break secret-free builds and CI.
 *
 * Keep this module free of I/O and `import "server-only"` so its pure parts
 * stay unit-testable; callers decide where to invoke the runtime assertion.
 */

/** Server env vars the app requires to actually serve gameplay in production. */
export const REQUIRED_SERVER_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORLD_SEED",
] as const;

export type RequiredServerEnvVar = (typeof REQUIRED_SERVER_ENV)[number];

export interface ServerEnvCheck {
  ok: boolean;
  /** Names of required vars that are unset or empty. */
  missing: RequiredServerEnvVar[];
}

/**
 * Inspect an env bag (defaults to `process.env`) for the required server vars.
 * Pure: returns the result, never throws, never logs a value. A var is
 * "missing" if it is absent or an empty/whitespace-only string.
 */
export function checkServerEnv(
  env: Record<string, string | undefined> = process.env,
): ServerEnvCheck {
  const missing = REQUIRED_SERVER_ENV.filter(
    (name) => !env[name] || env[name]!.trim() === "",
  );
  return { ok: missing.length === 0, missing };
}

/**
 * Build the human-readable error message for a failed check. Lists only the
 * NAMES of missing vars — never any value — so it is safe to log/surface.
 * Exported for the test and for callers that want the message without throwing.
 */
export function serverEnvErrorMessage(missing: readonly string[]): string {
  return (
    `Missing required server environment variable(s): ${missing.join(", ")}. ` +
    `Set them in your deploy environment (see .env.example and DEPLOY.md).`
  );
}

/**
 * Assert that all required server env vars are present. Throws a single error
 * naming every missing var when they are not. Intended for the runtime request
 * path — do NOT call at import time.
 */
export function assertServerEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const { ok, missing } = checkServerEnv(env);
  if (!ok) {
    throw new Error(serverEnvErrorMessage(missing));
  }
}
