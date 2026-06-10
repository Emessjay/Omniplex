import { describe, it, expect } from "vitest";
import {
  baseTierPowerBonus, basePower, MAX_BASE_TIER,
  EXCAVATOR_POWER_DEMAND,
} from "@/lib/game/rules";
import { ATMOSPHERES } from "@/lib/universe";

describe("baseTierPowerBonus", () => {
  it("is 0 at tier 1 and strictly increasing", () => {
    expect(baseTierPowerBonus(1)).toBe(0);
    for (let t = 2; t <= MAX_BASE_TIER; t++) {
      expect(baseTierPowerBonus(t)).toBeGreaterThan(baseTierPowerBonus(t - 1));
    }
  });
});

describe("basePower includes the tier bonus", () => {
  const ATM = ATMOSPHERES[1]!;
  const args = (tier: number) => ({
    thermalPlants: 0, solarArrays: 0, excavators: 1, productionLines: 0,
    blastFurnaces: 0, temperature: 50, atmosphere: ATM, tier,
  });

  it("tier-1 supply is unchanged (no plants ⇒ supply 0, unpowered)", () => {
    const r = basePower(args(1));
    expect(r.supply).toBe(0);
    expect(r.powered).toBe(false);
  });

  it("a high enough tier supplies power and flips an otherwise-unpowered base", () => {
    expect(baseTierPowerBonus(MAX_BASE_TIER)).toBeGreaterThanOrEqual(EXCAVATOR_POWER_DEMAND);
    const r = basePower(args(MAX_BASE_TIER));
    expect(r.supply).toBe(baseTierPowerBonus(MAX_BASE_TIER));
    expect(r.powered).toBe(true);              // tier bonus alone clears one excavator
  });

  it("higher tier ⇒ at-least-as-much supply (monotonic), demand unchanged", () => {
    let prev = -1;
    for (let t = 1; t <= MAX_BASE_TIER; t++) {
      const r = basePower(args(t));
      expect(r.supply).toBeGreaterThanOrEqual(prev);
      expect(r.demand).toBe(EXCAVATOR_POWER_DEMAND);   // tier doesn't change demand
      prev = r.supply;
    }
  });
});
