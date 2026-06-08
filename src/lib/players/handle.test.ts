import { describe, expect, it } from "vitest";
import { CALLSIGN_WORDS, generateCallsign, uniqueHandle } from "./handle";

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
