import { describe, it, expect } from "vitest";
import { VERBS, USAGE, usageLine } from "@/lib/game/usage";
import { resolveToken } from "@/lib/game/resolve";
import { renderHelp } from "@/lib/game/render";

/** The verbs `help` should SKIP (aliases of another capability, e.g. `look`). */
const ALIASES = VERBS.filter((v) => USAGE[v]?.alias);

/** The set of verbs the no-arg `help` list links to (one action token per command). */
function helpListedVerbs(): string[] {
  const out: string[] = [];
  for (const ln of renderHelp().lines) {
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
 * The no-arg `help` list is GENERATED from the registry (`VERBS`/`USAGE`), so it
 * can never drift from what the dispatcher accepts. This locks that in BOTH
 * directions: every non-alias registry command is listed, and `help` lists
 * nothing outside the registry. Adding a command to the registry without it
 * appearing in `help` (or vice-versa) fails here. Regression guard for the
 * `jump`/`regions` drift that motivated this change.
 */
describe("no-arg help is in parity with the command registry", () => {
  it("lists exactly the dispatchable (non-alias) commands", () => {
    const listed = helpListedVerbs();
    const expected = VERBS.filter((v) => !ALIASES.includes(v));
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  it("lists nothing outside the registry", () => {
    for (const verb of helpListedVerbs()) {
      expect(VERBS, `help lists "${verb}" which is not a registered verb`).toContain(verb);
    }
  });

  it("includes jump and regions (the commands that previously drifted)", () => {
    const listed = helpListedVerbs();
    expect(listed).toContain("jump");
    expect(listed).toContain("regions");
  });

  it("does not list aliases (look is folded into scan)", () => {
    expect(helpListedVerbs()).not.toContain("look");
  });
});
