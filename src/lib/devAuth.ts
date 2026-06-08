/**
 * Dev-login feature flag (server-only, OFF by default).
 *
 * ⚠️  SECURITY: dev login bypasses magic-link email verification and signs the
 * developer straight in as a fixed dev user. It exists only to make solo
 * testing bearable (no SMTP / email round-trip) and MUST stay disabled in any
 * real or public deployment. See DEPLOY.md §"Dev login (testing only)".
 *
 * The gate is a SERVER-only env var (`OMNIPLEX_DEV_LOGIN`) — never a
 * `NEXT_PUBLIC_*` — so it cannot be probed or toggled from the browser, and the
 * dev route is fully inert (404) when it is unset. The only thing that ever
 * crosses to the client is a single boolean ("dev login available").
 *
 * Pure: reads from an injected env bag (defaults to `process.env`) and never
 * throws or does I/O, so the flag logic stays unit-testable.
 */

/** Email of the fixed dev user when `OMNIPLEX_DEV_LOGIN_EMAIL` is unset. */
export const DEFAULT_DEV_LOGIN_EMAIL = "dev@omniplex.local";

/** Values that count as "explicitly off" even when the var is present. */
const FALSY = new Set(["", "0", "false", "off", "no"]);

/**
 * True when dev login is enabled. A present var is truthy unless it is one of
 * the explicit falsy strings (so `OMNIPLEX_DEV_LOGIN=0` / `=false` disable it,
 * matching the principle of least surprise). Unset ⇒ disabled.
 */
export function isDevLoginEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.OMNIPLEX_DEV_LOGIN;
  if (raw == null) return false;
  return !FALSY.has(raw.trim().toLowerCase());
}

/**
 * The dev user's email — `OMNIPLEX_DEV_LOGIN_EMAIL` if set (and non-empty),
 * otherwise {@link DEFAULT_DEV_LOGIN_EMAIL}.
 */
export function devLoginEmail(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.OMNIPLEX_DEV_LOGIN_EMAIL?.trim();
  return raw ? raw : DEFAULT_DEV_LOGIN_EMAIL;
}
