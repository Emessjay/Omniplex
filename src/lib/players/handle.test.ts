import { describe, expect, it } from "vitest";
import {
  CALLSIGN_WORDS,
  generateCallsign,
  uniqueHandle,
  validateHandle,
} from "./handle";

describe("generateCallsign", () => {
  it("is a word from the pool plus a short slug suffix", () => {
    // Deterministic rng: 0 ⇒ first word + first suffix char each draw.
    expect(generateCallsign(() => 0)).toBe(`${CALLSIGN_WORDS[0]}-aaa`);
  });

  it("never leaks the email: no '@' and never the email local-part", () => {
    // The local-part of these emails ('john.smith', 'jane') would have been
    // the OLD handle. A generated callsign must not equal or contain it.
    const emails = [
      "john.smith@gmail.com",
      "jane@example.com",
      "first.last@omniplex.gg",
    ];
    for (const email of emails) {
      const local = email.split("@")[0];
      // Sample the whole rng range so every word/suffix combination is hit.
      for (let i = 0; i < 200; i += 1) {
        const callsign = generateCallsign(() => i / 200);
        expect(callsign).not.toContain("@");
        expect(callsign).not.toContain(email);
        expect(callsign).not.toBe(local);
        expect(callsign).not.toContain(local);
      }
    }
  });

  it("draws only from the built-in callsign word pool", () => {
    for (let i = 0; i < 200; i += 1) {
      const callsign = generateCallsign(() => i / 200);
      const word = callsign.split("-")[0];
      expect(CALLSIGN_WORDS).toContain(word);
    }
  });
});

describe("uniqueHandle", () => {
  it("returns the desired handle when it is free", () => {
    expect(uniqueHandle("nova", [])).toBe("nova");
    expect(uniqueHandle("nova", ["other", "names"])).toBe("nova");
  });

  it("suffixes -2, -3, … past collisions (the collision path)", () => {
    expect(uniqueHandle("nova", ["nova"])).toBe("nova-2");
    expect(uniqueHandle("nova", ["nova", "nova-2"])).toBe("nova-3");
    expect(uniqueHandle("nova", ["nova", "nova-2", "nova-3"])).toBe("nova-4");
  });

  it("fills the lowest free slot rather than appending at the end", () => {
    // nova and nova-3 taken, nova-2 free → choose nova-2.
    expect(uniqueHandle("nova", ["nova", "nova-3"])).toBe("nova-2");
  });

  it("accepts a Set as well as an array, deterministically", () => {
    const taken = new Set(["nova", "nova-2"]);
    expect(uniqueHandle("nova", taken)).toBe("nova-3");
  });
});

describe("validateHandle", () => {
  it("accepts a plain alphanumeric handle, lowercasing it", () => {
    expect(validateHandle("Nova")).toEqual({ ok: true, value: "nova" });
    expect(validateHandle("cool_pilot-7")).toEqual({
      ok: true,
      value: "cool_pilot-7",
    });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateHandle("  Drifter  ")).toEqual({ ok: true, value: "drifter" });
  });

  it("normalizes case so casing can't side-step uniqueness", () => {
    // Different inputs, same canonical stored value.
    const a = validateHandle("NOVA");
    const b = validateHandle("nova");
    expect(a).toEqual({ ok: true, value: "nova" });
    expect(b).toEqual({ ok: true, value: "nova" });
  });

  it("rejects empty / whitespace-only input", () => {
    expect(validateHandle("").ok).toBe(false);
    expect(validateHandle("   ").ok).toBe(false);
  });

  it("rejects an '@' (never let an email through) and spaces", () => {
    expect(validateHandle("me@example.com").ok).toBe(false);
    expect(validateHandle("two words").ok).toBe(false);
  });

  it("rejects disallowed punctuation", () => {
    expect(validateHandle("no.dots").ok).toBe(false);
    expect(validateHandle("bang!").ok).toBe(false);
    expect(validateHandle("sl/ash").ok).toBe(false);
  });

  it("rejects leading/trailing dashes", () => {
    expect(validateHandle("-nova").ok).toBe(false);
    expect(validateHandle("nova-").ok).toBe(false);
    // An interior dash is fine.
    expect(validateHandle("no-va")).toEqual({ ok: true, value: "no-va" });
  });

  it("enforces the 3–20 length band (after trimming)", () => {
    expect(validateHandle("ab").ok).toBe(false); // too short
    expect(validateHandle("abc")).toEqual({ ok: true, value: "abc" });
    expect(validateHandle("a".repeat(20))).toEqual({
      ok: true,
      value: "a".repeat(20),
    });
    expect(validateHandle("a".repeat(21)).ok).toBe(false); // too long
  });

  it("rejects reserved/role-looking names (case-insensitively)", () => {
    expect(validateHandle("admin").ok).toBe(false);
    expect(validateHandle("Admin").ok).toBe(false);
    expect(validateHandle("system").ok).toBe(false);
    expect(validateHandle("unknown").ok).toBe(false);
  });

  it("returns a human-readable reason on failure", () => {
    const r = validateHandle("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});
