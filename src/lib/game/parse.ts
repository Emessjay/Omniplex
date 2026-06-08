/**
 * Pure command parser. Turns a raw input line (typed or from a clicked action
 * span) into `{ verb, args }`. No game knowledge — dispatch validates the verb.
 *
 * The verb is lowercased so `SCAN` and `scan` are the same command; args keep
 * their original case (resource ids are already lowercase; warp coords are
 * numbers). Whitespace is trimmed and collapsed; empty input yields an empty
 * verb, which dispatch treats as a no-op.
 */

export interface ParsedCommand {
  /** The command verb, lowercased. `""` for blank input. */
  verb: string;
  /** Remaining whitespace-delimited tokens, original case preserved. */
  args: string[];
}

export function parseCommand(input: string): ParsedCommand {
  const tokens = input.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { verb: "", args: [] };
  const [verb, ...args] = tokens;
  return { verb: verb!.toLowerCase(), args };
}
