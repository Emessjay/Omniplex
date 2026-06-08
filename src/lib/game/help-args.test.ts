import { describe, it, expect } from "vitest";
import { VERBS, USAGE, usageLine } from "@/lib/game/usage";
import { resolveToken } from "@/lib/game/resolve";

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

  it("gives every slot a non-empty placeholder name", () => {
    for (const u of Object.values(USAGE)) {
      for (const s of u.slots) expect(s.name.length).toBeGreaterThan(0);
    }
  });

  it("renders usage strings with <required> and [optional] markers", () => {
    expect(usageLine("mine")).toBe("mine <resource>");
    expect(usageLine("buy")).toBe("buy <item> [qty]");
    expect(usageLine("warp")).toBe("warp <sector> <system>");
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
