import { describe, it, expect } from "vitest";
import {
  orbitFuelCost, launchFuelCost, takeoffCost, interplanetaryDistance,
  INTERPLANETARY_FUEL_PER_DISTANCE,
} from "@/lib/game/rules";
import { isApplicable } from "@/lib/game/applicability";
import { systemAt, ATMOSPHERES } from "@/lib/universe";

const SEED = "omniplex-prod-1";
// A system with ≥2 planets for distance tests.
function twoPlanets() {
  for (let s = 0; s < 200; s++) {
    const sys = systemAt(SEED, { galaxy: 0, arm: 0, cluster: 0, system: s });
    if (sys.planets.length >= 2) return sys;
  }
  throw new Error("no multi-planet system found");
}

describe("fuel split — orbit is distance-only, launch is atmosphere-only", () => {
  const sys = twoPlanets();
  const a = sys.planets[0]!;
  const b = sys.planets[1]!;
  const T = 1_000_000;

  it("orbitFuelCost is 0 to self, positive between distinct planets, distance-based", () => {
    expect(orbitFuelCost(a, a, T)).toBe(0);
    expect(orbitFuelCost(a, b, T)).toBeGreaterThan(0);
    // tracks the interplanetary distance × coef (no atmosphere term)
    const expected = Math.ceil(INTERPLANETARY_FUEL_PER_DISTANCE * interplanetaryDistance(a, b, T));
    expect(orbitFuelCost(a, b, T)).toBe(expected);
  });

  it("launchFuelCost depends on atmosphere+gravity, not distance", () => {
    for (const atm of ATMOSPHERES) {
      expect(launchFuelCost(atm, a.gravity)).toBe(takeoffCost(atm, a.gravity));
      expect(launchFuelCost(atm, a.gravity)).toBeGreaterThan(0);
    }
    // launch cost is independent of where you'd go next (no distance input)
    expect(launchFuelCost.length).toBe(2);
  });
});

describe("applicability across orbit/landed/on-foot states", () => {
  const base = { inCombat: false, atTradeLocation: false };
  const orbiting = { ...base, embarked: true, landed: false };
  const landed = { ...base, embarked: true, landed: true };
  const onFoot = { ...base, embarked: false, landed: true };

  it("Orbiting: can orbit/land/warp/hyperwarp; cannot launch/disembark/mine", () => {
    for (const v of ["orbit", "land", "warp", "hyperwarp"]) expect(isApplicable(v, orbiting)).toBe(true);
    for (const v of ["launch", "disembark", "mine", "embark"]) expect(isApplicable(v, orbiting)).toBe(false);
  });

  it("Landed: can launch/disembark; cannot warp/land/mine/embark", () => {
    for (const v of ["launch", "disembark"]) expect(isApplicable(v, landed)).toBe(true);
    for (const v of ["warp", "land", "mine", "embark"]) expect(isApplicable(v, landed)).toBe(false);
  });

  it("On foot: can mine/embark; cannot launch/disembark/warp/land", () => {
    for (const v of ["mine", "embark", "explore", "build"]) expect(isApplicable(v, onFoot)).toBe(true);
    for (const v of ["launch", "disembark", "warp", "land", "orbit"]) expect(isApplicable(v, onFoot)).toBe(false);
  });

  it("combat still overrides every travel/surface verb", () => {
    const fighting = { ...orbiting, inCombat: true };
    for (const v of ["orbit", "land", "warp", "launch", "mine"]) expect(isApplicable(v, fighting)).toBe(false);
    for (const v of ["attack", "flee", "eat"]) expect(isApplicable(v, fighting)).toBe(true);
  });
});
