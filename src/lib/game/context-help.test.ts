import { describe, it, expect } from "vitest";
import { applicableVerbs, isApplicable } from "@/lib/game/applicability"; // wherever it lives

// P12a: economy (buy/sell) is gated by being at a TRADE LOCATION (a settlement
// region or the orbital outpost), not by embark state. orbit-land: the state
// slice gained `landed` — aboard splits into ORBITING (embarked && !landed:
// travel/orbit) and LANDED (embarked && landed: launch/disembark); on foot is
// always landed. "Embarked" states below are ORBITING (the travel state) unless
// noted. Travel needs orbit; surface/base needs being on foot.
const EMBARKED_TRADE = { embarked: true, landed: false, inCombat: false, atTradeLocation: true };
const EMBARKED_DEEP = { embarked: true, landed: false, inCombat: false, atTradeLocation: false };
const DISEMBARKED_TRADE = { embarked: false, landed: true, inCombat: false, atTradeLocation: true };
const DISEMBARKED_DEEP = { embarked: false, landed: true, inCombat: false, atTradeLocation: false };
const COMBAT = { embarked: false, landed: true, inCombat: true, atTradeLocation: true };

const ALL_STATES = [
  EMBARKED_TRADE,
  EMBARKED_DEEP,
  DISEMBARKED_TRADE,
  DISEMBARKED_DEEP,
  COMBAT,
];

const ALWAYS = ["help", "scan", "inventory", "who", "map", "bases", "upgrades"];

describe("informational commands are always applicable", () => {
  it("are usable in every state", () => {
    for (const state of ALL_STATES) {
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
    // none of these surface/economy/travel verbs in combat — even at a trade
    // location, combat hides buy/sell:
    for (const v of ["mine", "explore", "buy", "sell", "warp", "land", "hyperwarp", "build", "produce"]) {
      expect(set.has(v)).toBe(false);
    }
  });

  it("attack/flee are NOT applicable out of combat", () => {
    expect(isApplicable("attack", EMBARKED_TRADE)).toBe(false);
    expect(isApplicable("attack", DISEMBARKED_TRADE)).toBe(false);
    expect(isApplicable("flee", DISEMBARKED_DEEP)).toBe(false);
  });
});

describe("economy (buy/sell) is gated by LOCATION, not embark (P12a)", () => {
  it("is usable at a trade location whether embarked or on foot", () => {
    for (const v of ["buy", "sell"]) {
      expect(isApplicable(v, EMBARKED_TRADE)).toBe(true);
      expect(isApplicable(v, DISEMBARKED_TRADE)).toBe(true);
    }
  });

  it("is NOT usable away from a settlement/outpost, even embarked", () => {
    for (const v of ["buy", "sell"]) {
      expect(isApplicable(v, EMBARKED_DEEP)).toBe(false);
      expect(isApplicable(v, DISEMBARKED_DEEP)).toBe(false);
    }
  });

  it("being at a trade location does NOT enable travel or surface work", () => {
    // Trade location only unlocks the economy; travel still needs orbit, and
    // surface work still needs being on foot.
    for (const v of ["warp", "land", "hyperwarp", "orbit"]) {
      expect(isApplicable(v, DISEMBARKED_TRADE)).toBe(false); // travel needs orbit
    }
    for (const v of ["mine", "explore", "build"]) {
      expect(isApplicable(v, EMBARKED_TRADE)).toBe(false); // surface needs on-foot
    }
  });
});

describe("travel + surface split by orbit/landed/on-foot (out of combat)", () => {
  it("orbiting (embarked && !landed): travel/orbit yes, launch/disembark/surface no", () => {
    for (const v of ["warp", "land", "hyperwarp", "orbit"]) {
      expect(isApplicable(v, EMBARKED_TRADE)).toBe(true);
    }
    for (const v of ["launch", "disembark", "mine", "explore", "harvest", "build", "produce", "embark"]) {
      expect(isApplicable(v, EMBARKED_TRADE)).toBe(false);
    }
  });

  it("landed aboard (embarked && landed): launch/disembark + orbit/land (they chain launch) yes; warp/hyperwarp/surface no", () => {
    const LANDED = { embarked: true, landed: true, inCombat: false, atTradeLocation: true };
    // `orbit`/`land` work from the surface too — they chain an implicit launch.
    for (const v of ["launch", "disembark", "orbit", "land"]) {
      expect(isApplicable(v, LANDED)).toBe(true);
    }
    // The long jumps require an explicit launch first; surface work needs on-foot.
    for (const v of ["warp", "hyperwarp", "mine", "build", "embark"]) {
      expect(isApplicable(v, LANDED)).toBe(false);
    }
  });

  it("on foot (!embarked): surface/base yes, travel/launch/disembark no", () => {
    for (const v of ["mine", "explore", "harvest", "build", "produce", "embark"]) {
      expect(isApplicable(v, DISEMBARKED_TRADE)).toBe(true);
    }
    for (const v of ["warp", "land", "hyperwarp", "orbit", "launch", "disembark"]) {
      expect(isApplicable(v, DISEMBARKED_TRADE)).toBe(false);
    }
  });
});

describe("craft works regardless of embark/location (anti-softlock biofuel)", () => {
  it("is applicable in every out-of-combat state", () => {
    for (const state of [EMBARKED_TRADE, EMBARKED_DEEP, DISEMBARKED_TRADE, DISEMBARKED_DEEP]) {
      expect(isApplicable("craft", state)).toBe(true);
    }
    // ...but not mid-fight.
    expect(isApplicable("craft", COMBAT)).toBe(false);
  });
});

describe("applicableVerbs ⊆ the command vocabulary, and is the help set", () => {
  it("returns only real verbs, varying by state", () => {
    const e = applicableVerbs(EMBARKED_TRADE);
    const d = applicableVerbs(DISEMBARKED_TRADE);
    expect(e).not.toEqual(d); // state actually changes the set
    // self-consistency: every verb applicableVerbs returns is isApplicable
    for (const v of e) expect(isApplicable(v, EMBARKED_TRADE)).toBe(true);
    for (const v of d) expect(isApplicable(v, DISEMBARKED_TRADE)).toBe(true);
  });

  it("location changes the set (economy appears at a trade location)", () => {
    const tradeSet = new Set(applicableVerbs(EMBARKED_TRADE));
    const deepSet = new Set(applicableVerbs(EMBARKED_DEEP));
    expect(tradeSet.has("buy")).toBe(true);
    expect(tradeSet.has("sell")).toBe(true);
    expect(deepSet.has("buy")).toBe(false);
    expect(deepSet.has("sell")).toBe(false);
  });
});
