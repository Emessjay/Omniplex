/**
 * Deterministic creature-blurb assembly (creature-blurbs).
 *
 * Turns the genome's procedural creatures into Omniplex-voice prose, assembled
 * DETERMINISTICALLY at runtime from a STATIC, pre-written component library with
 * ZERO model/API calls. The library is authored offline (the Nimbus
 * `compose-batch` tool) and committed as `creature-library.json`; this module is
 * the runtime ASSEMBLER + grammar + fallback. It replaces the placeholder
 * `speciesLabel` ("a large armored grazer") with assembled prose, and falls back
 * to that label for any fragment the library doesn't yet have — so it ships and
 * works against a partial/empty library, lighting up fragment-by-fragment as the
 * library fills.
 *
 * PURE: `assembleBlurb` takes the library as an argument and uses `makeRng` for
 * variant selection — no `Date`, no `Math.random`, no IO. `blurbOf` only adds the
 * committed-library import + the `speciesLabel` fallback.
 *
 * Component-key scheme (FIXED — the library is keyed by it):
 *   - `archetype.<archetypeId>#<n>` — present-tense main clause, subject "it" (the
 *     SPINE; without it there is no blurb → `null`).
 *   - `trait.<dimensionId>.<value>#<n>` — short trailing clause for a trait value.
 *   - `biome.<biome>#<n>` — scene-setting opening phrase for a biome.
 * Three variants each (`#1`/`#2`/`#3`); fragments are lowercase, no trailing
 * punctuation.
 *
 * This assembler pattern is REUSED for future blurb targets (exploration sites,
 * sapient species, planets) — same library + grammar + fallback shape, new key
 * namespaces.
 */

import { makeRng } from "@/lib/universe/prng";
import { speciesLabel, type Species } from "@/lib/universe";
import LIBRARY from "./creature-library.json";

/** The committed static component library: flat `key → lowercase fragment`. */
export type BlurbLibrary = Readonly<Record<string, string>>;

/** How many variants (`#1`..`#N`) the key scheme defines per slot. */
const VARIANT_COUNT = 3;

/**
 * Trait dimensions chosen for a blurb, in fixed PRIORITY order — the most
 * characterful axes first. We voice at most `MAX_TRAIT_CLAUSES` of them (skipping
 * "none"-type values and any the library doesn't cover), so a blurb reads as 2–3
 * clauses, not all 7 dimensions. Order is fixed (not seed-shuffled) so a species
 * always foregrounds the same facts; only the variant WORDING varies by seed.
 */
const TRAIT_PRIORITY: readonly string[] = [
  "defense",
  "size",
  "temperament",
  "locomotion",
  "integument",
  "adaptation",
  "reproduction",
];

/** Upper bound on trait clauses appended to the archetype spine. */
const MAX_TRAIT_CLAUSES = 2;

/** Trait values that describe an ABSENCE — never voiced as a clause. */
const NONE_VALUES: ReadonlySet<string> = new Set(["none"]);

/**
 * Pick one present variant of `baseKey` (`baseKey#1`..`#N`) deterministically, or
 * `null` when the library has none of them. Choosing only among the variants that
 * actually EXIST guarantees we never emit a `…#n` key or `undefined` for a missing
 * variant — the partial-library tolerance is enforced here. The `slotKey` salts
 * the RNG so different slots of one blurb pick independently.
 */
function pickFragment(
  library: BlurbLibrary,
  baseKey: string,
  slotKey: string,
  seedParts: readonly (string | number)[],
): string | null {
  const available: string[] = [];
  for (let n = 1; n <= VARIANT_COUNT; n++) {
    const v = library[`${baseKey}#${n}`];
    if (typeof v === "string" && v.length > 0) available.push(v);
  }
  if (available.length === 0) return null;
  const rng = makeRng("creature-blurb", ...seedParts, slotKey);
  return available[Math.floor(rng() * available.length)]!;
}

/** Capitalize the first letter of `s`, leaving the rest untouched. */
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Stitch the archetype spine + trailing trait clauses into one clause-list,
 * comma-joined with a final "and" before the last clause (an opener, if present,
 * is prepended separately with a comma by the caller).
 */
function joinClauses(clauses: readonly string[]): string {
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return clauses[0]!;
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

/**
 * Assemble a deterministic Omniplex-voice blurb for `species` in `biome` from the
 * static `library`, or `null` when the library lacks the archetype SPINE.
 *
 * Grammar: `[biome opener, ]` + archetype clause + up to {@link MAX_TRAIT_CLAUSES}
 * trait clauses, stitched into ONE sentence (capitalized, comma-joined with a
 * final "and", period-terminated). Deterministic: identical (species, biome,
 * seedParts) ⇒ byte-identical output. Partial-library tolerant: a missing biome
 * opener or trait clause is OMITTED; only a missing archetype core yields `null`.
 * Never throws on a missing/unknown key, biome, or archetype.
 */
export function assembleBlurb(
  library: BlurbLibrary,
  species: Species,
  biome: string,
  seedParts: readonly (string | number)[],
): string | null {
  // The variant RNG is keyed by (species identity, biome, slotKey) on top of the
  // caller's seedParts, so a given species in a given biome always reads the same
  // while different species/biomes vary — and each slot picks independently.
  const parts: (string | number)[] = [...seedParts, biome, species.archetype];

  // The archetype clause is the SPINE — no spine, no blurb.
  const spine = pickFragment(library, `archetype.${species.archetype}`, "archetype", parts);
  if (spine === null) return null;

  // Trailing trait clauses: walk the fixed priority order, skip "none"-type
  // values and anything the library doesn't cover, take at most MAX_TRAIT_CLAUSES.
  const traitClauses: string[] = [];
  for (const dim of TRAIT_PRIORITY) {
    if (traitClauses.length >= MAX_TRAIT_CLAUSES) break;
    const value = species.traits?.[dim];
    if (!value || NONE_VALUES.has(value)) continue;
    const clause = pickFragment(library, `trait.${dim}.${value}`, `trait.${dim}`, parts);
    if (clause !== null) traitClauses.push(clause);
  }

  const body = joinClauses([spine, ...traitClauses]);

  // The biome opener is a scene-setter: prepended with a comma (optional).
  const opener = pickFragment(library, `biome.${biome}`, "biome", parts);
  const sentence = opener ? `${opener}, ${body}` : body;

  return `${capitalize(sentence)}.`;
}

/**
 * The runtime wrapper: assemble a blurb for `species` in `biome` from the
 * committed `LIBRARY`, falling back to the terse `speciesLabel` for any species
 * the library can't yet voice. `seedParts` should be STABLE for a given creature
 * occurrence (e.g. the region coord + species identity) so re-rendering the same
 * encounter reads identically.
 */
export function blurbOf(
  species: Species,
  biome: string,
  ...seedParts: (string | number)[]
): string {
  return assembleBlurb(LIBRARY as BlurbLibrary, species, biome, seedParts) ?? speciesLabel(species);
}
