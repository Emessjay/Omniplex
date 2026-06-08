/**
 * Pure command-abbreviation resolver.
 *
 * Lets players type a unique *prefix* of a command verb or of an enumerable
 * argument and have it expand to the canonical form: `m t` → `mine titanium`
 * when titanium is the only minable resource whose id starts with `t`. An
 * exact match always wins; an ambiguous prefix is reported (never guessed);
 * no match is an error. This module is IO-free — the dispatcher supplies the
 * candidate sets from authoritative game state via `argDomain`, and decides
 * how to render the results. See `CLAUDE.md` §"Conventions".
 */
import { parseCommand } from "./parse";

/** Outcome of resolving one token against a candidate set. */
export type TokenResolution =
  | { ok: true; value: string }
  | { ok: false; reason: "none" | "ambiguous"; matches: string[] };

/**
 * Resolve one token against `candidates` by exact-or-unique-prefix match.
 * Case-insensitive; always returns the candidate's canonical spelling.
 * An exact match wins outright even when it also prefixes another candidate
 * (`mine` beats `mineral`). Otherwise a single prefix match resolves; >1 is
 * `ambiguous` (matches sorted); 0 is `none`.
 */
export function resolveToken(
  fragment: string,
  candidates: string[],
): TokenResolution {
  const frag = fragment.toLowerCase();
  const lower = candidates.map((c) => c.toLowerCase());

  const exactIdx = lower.indexOf(frag);
  if (exactIdx !== -1) return { ok: true, value: candidates[exactIdx]! };

  const prefixIdxs: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (lower[i]!.startsWith(frag)) prefixIdxs.push(i);
  }
  if (prefixIdxs.length === 1) {
    return { ok: true, value: candidates[prefixIdxs[0]!]! };
  }
  if (prefixIdxs.length > 1) {
    const matches = prefixIdxs.map((i) => candidates[i]!).sort();
    return { ok: false, reason: "ambiguous", matches };
  }
  return { ok: false, reason: "none", matches: [] };
}

/**
 * Per-line resolution spec. `verbs` is the command vocabulary; `argDomain`
 * returns the candidate list for a given (verb, argIndex) position, or `null`
 * if that position is opaque (free-form / numeric — pass the raw token through
 * unchanged). `priorArgs` holds the already-resolved earlier args, so a domain
 * can depend on them.
 */
export interface ResolveLineSpec {
  verbs: string[];
  argDomain: (
    verb: string,
    argIndex: number,
    priorArgs: string[],
  ) => string[] | null;
}

export type LineResolution =
  | { ok: true; verb: string; args: string[]; canonical: string }
  | { ok: false; error: string };

/**
 * Resolve a full input line: expand the verb by unique prefix, then expand each
 * argument against its contextual domain (opaque positions pass through). On
 * any ambiguity / no-match returns `{ ok: false, error }` with a human-readable
 * message that names the candidates for ambiguous cases. `canonical` is the
 * fully-expanded `verb arg1 arg2…` string. Blank input resolves to the empty
 * verb (a no-op the dispatcher already handles).
 */
export function resolveCommandLine(
  input: string,
  spec: ResolveLineSpec,
): LineResolution {
  const { verb: rawVerb, args: rawArgs } = parseCommand(input);
  if (rawVerb === "") return { ok: true, verb: "", args: [], canonical: "" };

  const vr = resolveToken(rawVerb, spec.verbs);
  if (!vr.ok) {
    if (vr.reason === "ambiguous") {
      return {
        ok: false,
        error: `ambiguous command '${rawVerb}' — did you mean: ${vr.matches.join(", ")}?`,
      };
    }
    return {
      ok: false,
      error: `Unknown command "${rawVerb}". Type help for the list.`,
    };
  }
  const verb = vr.value;

  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const raw = rawArgs[i]!;
    const domain = spec.argDomain(verb, i, args.slice());
    if (domain === null) {
      // Opaque position (warp coords, land index): never prefix-matched.
      args.push(raw);
      continue;
    }
    const ar = resolveToken(raw, domain);
    if (!ar.ok) {
      if (ar.reason === "ambiguous") {
        return {
          ok: false,
          error: `ambiguous '${raw}' — did you mean: ${ar.matches.join(", ")}?`,
        };
      }
      return { ok: false, error: `No such '${raw}' here.` };
    }
    args.push(ar.value);
  }

  const canonical = [verb, ...args].join(" ");
  return { ok: true, verb, args, canonical };
}
