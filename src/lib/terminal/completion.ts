/**
 * Tab-completion source.
 *
 * SEAM: today this is a static list of the planned MVP commands. The real
 * implementation will likely become context-aware (complete destinations
 * after `warp`, resources after `mine`/`sell`, etc.) and may move
 * server-side. Keep `completeCommand(partial) => string[]` stable — the
 * Terminal component calls exactly this.
 */

/** Planned MVP command verbs (see DESIGN.md §"Terminal client"). */
export const COMMANDS: readonly string[] = [
  "help",
  "look",
  "scan",
  "map",
  "warp",
  "mine",
  "inventory",
  "sell",
  "buy",
  "who",
  "clear",
];

/**
 * Return the commands that complete `partial`. Matches against the first
 * whitespace-delimited token only (verb completion); returns the full list
 * for empty input.
 */
export function completeCommand(partial: string): string[] {
  const verb = partial.trimStart().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (verb === "") return [...COMMANDS];
  return COMMANDS.filter((c) => c.startsWith(verb));
}
