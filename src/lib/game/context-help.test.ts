import { describe, it, expect } from "vitest";
import { applicableVerbs, isApplicable } from "@/lib/game/applicability"; // wherever it lives

const EMBARKED = { embarked: true, inCombat: false };
const DISEMBARKED = { embarked: false, inCombat: false };
const COMBAT = { embarked: false, inCombat: true };

const ALWAYS = ["help", "scan", "inventory", "who", "map", "bases", "upgrades"];

describe("informational commands are always applicable", () => {
  it("are usable in every state", () => {
    for (const state of [EMBARKED, DISEMBARKED, COMBAT]) {
      for (const v of ALWAYS) expect(isApplicable(v, state)).toBe(true);
    }
  });
});

describe("combat overrides everything", () => {
  it("only attack/flee/eat (+ informational) in combat", () => {
    const set = new Set(applicableVerbs(COMBAT));
    expect(set.has("attack")).toBe(true);
    expect(set.has("flee")).toBe(true);
    expect(set.has("eat")).toBe(true);
    // none of these surface/economy/travel verbs in combat:
    for (const v of ["mine", "explore", "buy", "sell", "warp", "land", "hyperwarp", "build", "produce"]) {
      expect(set.has(v)).toBe(false);
    }
  });

  it("attack/flee are NOT applicable out of combat", () => {
    expect(isApplicable("attack", EMBARKED)).toBe(false);
    expect(isApplicable("attack", DISEMBARKED)).toBe(false);
    expect(isApplicable("flee", DISEMBARKED)).toBe(false);
  });
});

describe("embarked vs disembarked (out of combat)", () => {
  it("embarked: economy/travel yes, surface no", () => {
    for (const v of ["buy", "sell", "warp", "land", "hyperwarp", "disembark"]) {
      expect(isApplicable(v, EMBARKED)).toBe(true);
    }
    for (const v of ["mine", "explore", "harvest", "build", "produce", "embark"]) {
      expect(isApplicable(v, EMBARKED)).toBe(false);
    }
  });

  it("disembarked: surface/base yes, economy/travel no", () => {
    for (const v of ["mine", "explore", "harvest", "build", "produce", "embark"]) {
      expect(isApplicable(v, DISEMBARKED)).toBe(true);
    }
    for (const v of ["buy", "sell", "warp", "land", "hyperwarp", "disembark"]) {
      expect(isApplicable(v, DISEMBARKED)).toBe(false);
    }
  });
});

describe("applicableVerbs ⊆ the command vocabulary, and is the help set", () => {
  it("returns only real verbs, varying by state", () => {
    const e = applicableVerbs(EMBARKED);
    const d = applicableVerbs(DISEMBARKED);
    expect(e).not.toEqual(d); // state actually changes the set
    // self-consistency: every verb applicableVerbs returns is isApplicable
    for (const v of e) expect(isApplicable(v, EMBARKED)).toBe(true);
    for (const v of d) expect(isApplicable(v, DISEMBARKED)).toBe(true);
  });
});
