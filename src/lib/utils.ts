/**
 * Tiny class-name joiner. Filters out falsy values so callers can write
 * `cn("base", cond && "extra")`. Kept dependency-free on purpose; swap for
 * clsx/tailwind-merge later only if a real need appears.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
