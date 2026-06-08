/**
 * Handle derivation + uniqueness — pure, unit-tested helpers.
 *
 * A new player's handle starts from the email local-part (the bit before the
 * `@`), sanitized to a terminal-friendly slug. If that handle is already
 * taken, it's suffixed deterministically (`name`, `name-2`, `name-3`, …) so
 * the result is stable given the same inputs and never collides with an
 * existing handle.
 */

/**
 * Derive a base handle slug from an email address. Lowercases the local-part
 * and collapses any run of non-alphanumeric characters into a single dash,
 * trimming leading/trailing dashes. Falls back to `"player"` if nothing
 * usable remains (e.g. an all-symbol local-part).
 */
export function deriveHandleBase(email: string): string {
  const local = email.split("@")[0] ?? "";
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "player";
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
