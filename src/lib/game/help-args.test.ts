import { describe, it, expect } from "vitest";
import { VERBS, USAGE, usageLine } from "@/lib/game/usage";
import { resolveToken } from "@/lib/game/resolve";
import { renderHelp } from "@/lib/game/render";
import { applicableVerbs, isApplicable, type PlayerStateView } from "@/lib/game/applicability";

/** The verbs `help` should SKIP (aliases of another capability, e.g. `look`). */
const ALIASES = VERBS.filter((v) => USAGE[v]?.alias);

// Representative states. `atTradeLocation: true` so the economy commands
// (buy/sell) are exercised in the parity checks (P12a gates them by location,
// not embark state). orbit-land: `landed` splits aboard into ORBITING
// (embarked && !landed — the travel state, used here as EMBARKED) and LANDED
// (embarked && landed). On foot is always landed.
const EMBARKED: PlayerStateView = { embarked: true, landed: false, inCombat: false, atTradeLocation: true };
const LANDED: PlayerStateView = { embarked: true, landed: true, inCombat: false, atTradeLocation: true };
const DISEMBARKED: PlayerStateView = { embarked: false, landed: true, inCombat: false, atTradeLocation: true };
const COMBAT: PlayerStateView = { embarked: false, landed: true, inCombat: true, atTradeLocation: true };

/** The verbs the no-arg `help` list links to in `state` (one token per command). */
function helpListedVerbs(state: PlayerStateView): string[] {
  const out: string[] = [];
  for (const ln of renderHelp(state).lines) {
    for (const span of ln) {
      if (span.kind === "action") out.push(span.command);
    }
  }
  return out;
}

/**
 * Pure guardrails for `help <command>`. The CONTEXTUAL argument enumerations
 * (minable here, hold contents, …) come from the live `argDomain` against world
 * state and are exercised by integration; here we lock the static contract:
 * every command has a usage descriptor, and the command argument resolves by
 * the same unique-prefix abbreviation the rest of the parser uses.
 */
describe("help usage descriptors (AC#6)", () => {
  it("every command in the vocabulary has a usage descriptor entry", () => {
    for (const verb of VERBS) {
      expect(USAGE[verb], `missing USAGE entry for "${verb}"`).toBeDefined();
    }
  });

  it("has no stray descriptors for verbs outside the vocabulary", () => {
    for (const verb of Object.keys(USAGE)) {
      expect(VERBS, `USAGE has stray verb "${verb}"`).toContain(verb);
    }
  });

  it("USAGE keys and VERBS are the same set, both ways (registry can't drift)", () => {
    expect([...Object.keys(USAGE)].sort()).toEqual([...VERBS].sort());
  });

  it("gives every slot a non-empty placeholder name", () => {
    for (const u of Object.values(USAGE)) {
      for (const s of u.slots) expect(s.name.length).toBeGreaterThan(0);
    }
  });

  it("renders usage strings with <required> and [optional] markers", () => {
    expect(usageLine("mine")).toBe("mine <resource>");
    expect(usageLine("buy")).toBe("buy <item> [qty]");
    expect(usageLine("warp")).toBe("warp <arm> <cluster> <system>");
    expect(usageLine("scan")).toBe("scan");
  });
});

describe("help command-arg resolves abbreviations (AC#6)", () => {
  it("expands a unique prefix to the canonical command", () => {
    expect(resolveToken("mi", VERBS)).toEqual({ ok: true, value: "mine" });
    expect(resolveToken("cr", VERBS)).toEqual({ ok: true, value: "craft" });
    expect(resolveToken("up", VERBS)).toEqual({ ok: true, value: "upgrades" });
  });

  it("reports an ambiguous prefix without guessing", () => {
    const r = resolveToken("s", VERBS); // scan vs sell
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      expect(r.matches).toContain("scan");
      expect(r.matches).toContain("sell");
    }
  });

  it("reports an unknown command", () => {
    expect(resolveToken("zzz", VERBS)).toEqual({
      ok: false,
      reason: "none",
      matches: [],
    });
  });
});

/**
 * The no-arg `help` list is now CONTEXT-AWARE and shares ONE applicability
 * predicate with the dispatch gate (`applicableVerbs`/`isApplicable`), so
 * "shown in `help`" ⇔ "usable right now" can never drift. This locks the
 * invariant in BOTH directions, for representative states: the listed set equals
 * exactly the applicable, non-alias verbs for that state — and every listed verb
 * is itself applicable (the same predicate dispatch consults to accept/reject).
 * Still a regression guard for the `jump`/`regions` drift that first motivated
 * generating the list from the registry.
 */
describe("no-arg help is in parity with the applicability model (per state)", () => {
  for (const [label, state] of [
    ["orbiting / out of combat", EMBARKED],
    ["landed aboard / out of combat", LANDED],
    ["on foot / out of combat", DISEMBARKED],
    ["in combat", COMBAT],
  ] as const) {
    describe(label, () => {
      it("lists exactly the applicable (non-alias) commands for this state", () => {
        const listed = helpListedVerbs(state);
        const expected = applicableVerbs(state).filter((v) => !ALIASES.includes(v));
        expect([...listed].sort()).toEqual([...expected].sort());
      });

      it("lists only real, currently-applicable verbs (shown ⇒ usable)", () => {
        for (const verb of helpListedVerbs(state)) {
          expect(VERBS, `help lists "${verb}" which is not a registered verb`).toContain(verb);
          expect(isApplicable(verb, state), `help lists inapplicable "${verb}"`).toBe(true);
        }
      });

      it("lists every applicable non-alias verb (usable ⇒ shown)", () => {
        const listed = new Set(helpListedVerbs(state));
        for (const verb of VERBS) {
          if (ALIASES.includes(verb)) continue;
          if (isApplicable(verb, state)) {
            expect(listed.has(verb), `applicable "${verb}" missing from help`).toBe(true);
          } else {
            expect(listed.has(verb), `inapplicable "${verb}" shown in help`).toBe(false);
          }
        }
      });

      it("never lists aliases (look/base are folded into scan/storage)", () => {
        for (const alias of ALIASES) {
          expect(helpListedVerbs(state)).not.toContain(alias);
        }
      });
    });
  }

  it("includes jump and regions when applicable (the commands that previously drifted)", () => {
    const listed = helpListedVerbs(EMBARKED);
    expect(listed).toContain("jump"); // free navigation, usable out of combat
    expect(listed).toContain("regions"); // informational, always usable
  });

  it("narrows by state: combat hides surface/economy, surfaces attack/flee", () => {
    const combat = new Set(helpListedVerbs(COMBAT));
    expect(combat.has("attack")).toBe(true);
    expect(combat.has("flee")).toBe(true);
    expect(combat.has("eat")).toBe(true);
    for (const v of ["mine", "buy", "warp", "build", "produce"]) {
      expect(combat.has(v)).toBe(false);
    }
    // attack/flee disappear once out of combat.
    expect(helpListedVerbs(EMBARKED)).not.toContain("attack");
    expect(helpListedVerbs(DISEMBARKED)).not.toContain("flee");
  });
});
