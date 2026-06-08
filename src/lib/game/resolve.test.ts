import { describe, it, expect } from "vitest";
import { resolveToken, resolveCommandLine } from "@/lib/game/resolve";
import type { ResolveLineSpec } from "@/lib/game/resolve";

describe("resolveToken — exact or unique prefix", () => {
  it("returns a unique prefix match", () => {
    expect(resolveToken("tit", ["titanium", "iron", "copper"])).toEqual({
      ok: true,
      value: "titanium",
    });
  });

  it("prefers an exact match even when it prefixes another candidate", () => {
    // "mine" is exact AND a prefix of "mineral" — exact wins, no ambiguity.
    expect(resolveToken("mine", ["mine", "mineral"])).toEqual({
      ok: true,
      value: "mine",
    });
  });

  it("reports ambiguity with the sorted matches", () => {
    const r = resolveToken("t", ["titanium", "tritium", "iron"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      expect([...r.matches].sort()).toEqual(["titanium", "tritium"]);
    }
  });

  it("reports no match", () => {
    expect(resolveToken("z", ["iron", "copper"])).toEqual({
      ok: false,
      reason: "none",
      matches: [],
    });
  });

  it("is case-insensitive and returns the canonical spelling", () => {
    expect(resolveToken("TI", ["titanium"])).toEqual({
      ok: true,
      value: "titanium",
    });
  });

  it("resolves a single candidate by any prefix", () => {
    expect(resolveToken("i", ["iron"])).toEqual({ ok: true, value: "iron" });
  });
});

describe("resolveCommandLine — verb + contextual args", () => {
  const VERBS = [
    "scan",
    "sell",
    "mine",
    "map",
    "warp",
    "land",
    "inventory",
    "buy",
    "who",
    "help",
  ];

  // mine here: titanium + iron. sell: from inventory (iron) + "all".
  // warp/land args are opaque (numeric) -> argDomain returns null.
  const spec: ResolveLineSpec = {
    verbs: VERBS,
    argDomain: (verb, i) => {
      if (verb === "mine" && i === 0) return ["titanium", "iron"];
      if (verb === "sell" && i === 0) return ["iron", "all"];
      return null; // opaque (warp coords, land index, etc.)
    },
  };

  it("resolves a unique-prefix verb with no args", () => {
    const r = resolveCommandLine("sc", spec);
    expect(r).toMatchObject({ ok: true, verb: "scan", args: [], canonical: "scan" });
  });

  it("resolves verb + a unique-prefix arg and reports the canonical form", () => {
    // "mi" uniquely -> mine (note: "m" alone is ambiguous with "map"); "t"
    // uniquely -> titanium among {titanium, iron}.
    const r = resolveCommandLine("mi t", spec);
    expect(r).toMatchObject({
      ok: true,
      verb: "mine",
      args: ["titanium"],
      canonical: "mine titanium",
    });
  });

  it("expands an exact full command unchanged", () => {
    const r = resolveCommandLine("mine iron", spec);
    expect(r).toMatchObject({ ok: true, verb: "mine", args: ["iron"], canonical: "mine iron" });
  });

  it("fails on an ambiguous verb and names the candidates", () => {
    const r = resolveCommandLine("s", spec); // scan vs sell
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.toLowerCase()).toContain("scan");
      expect(r.error.toLowerCase()).toContain("sell");
    }
  });

  it("fails on an ambiguous arg without picking one", () => {
    const ambig: ResolveLineSpec = {
      ...spec,
      argDomain: (verb, i) =>
        verb === "mine" && i === 0 ? ["titanium", "tritium"] : null,
    };
    const r = resolveCommandLine("mi t", ambig); // "mi" -> mine; "t" ambiguous
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.toLowerCase()).toContain("titanium");
      expect(r.error.toLowerCase()).toContain("tritium");
    }
  });

  it("passes opaque (numeric/free-form) args through verbatim", () => {
    // "wa" uniquely -> warp ("w" alone is ambiguous with "who"); coords opaque.
    const r = resolveCommandLine("wa 1 2", spec);
    expect(r).toMatchObject({
      ok: true,
      verb: "warp",
      args: ["1", "2"],
      canonical: "warp 1 2",
    });
  });

  it("resolves the 'all' keyword for sell by prefix", () => {
    const r = resolveCommandLine("sel a", spec);
    expect(r).toMatchObject({ ok: true, verb: "sell", args: ["all"], canonical: "sell all" });
  });

  it("reports a no-match arg as an error (nothing guessed)", () => {
    const r = resolveCommandLine("mine zz", spec);
    expect(r.ok).toBe(false);
  });
});
