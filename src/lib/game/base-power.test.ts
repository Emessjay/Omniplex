import { describe, it, expect } from "vitest";
import {
  thermalOutput,
  solarOutput,
  basePower,
  EXCAVATOR_POWER_DEMAND,
  PRODUCTION_LINE_POWER_DEMAND,
} from "@/lib/game/rules";
import { ATMOSPHERES, atmosphereDensity } from "@/lib/universe";

describe("power demands", () => {
  it("are positive constants", () => {
    expect(EXCAVATOR_POWER_DEMAND).toBeGreaterThan(0);
    expect(PRODUCTION_LINE_POWER_DEMAND).toBeGreaterThan(0);
  });
});

describe("thermalOutput — rises with temperature", () => {
  it("is non-negative and non-decreasing in temperature", () => {
    for (const t of [-100, 0, 50, 150, 400]) expect(thermalOutput(t)).toBeGreaterThanOrEqual(0);
    expect(thermalOutput(300)).toBeGreaterThan(thermalOutput(20));
    expect(thermalOutput(150)).toBeGreaterThanOrEqual(thermalOutput(60));
  });
});

describe("solarOutput — rises as atmosphere thins", () => {
  it("is non-negative and higher under a thinner atmosphere", () => {
    for (const a of ATMOSPHERES) expect(solarOutput(a)).toBeGreaterThanOrEqual(0);
    const sorted = [...ATMOSPHERES].sort((x, y) => atmosphereDensity(x) - atmosphereDensity(y));
    const thin = sorted[0]!;
    const thick = sorted[sorted.length - 1]!;
    expect(solarOutput(thin)).toBeGreaterThan(solarOutput(thick));
  });
});

describe("basePower — supply vs demand, powered gate", () => {
  const ATM = ATMOSPHERES[1]!;

  it("a consumer with no plant is unpowered", () => {
    const r = basePower({
      thermalPlants: 0, solarArrays: 0, excavators: 1, productionLines: 0,
      temperature: 50, atmosphere: ATM,
    });
    expect(r.demand).toBeGreaterThan(0);
    expect(r.supply).toBe(0);
    expect(r.powered).toBe(false);
  });

  it("enough plant output powers the base; supply≥demand ⇒ powered", () => {
    // Many plants on a hot world: supply should clear a single excavator's demand.
    const r = basePower({
      thermalPlants: 5, solarArrays: 0, excavators: 1, productionLines: 0,
      temperature: 300, atmosphere: ATM,
    });
    expect(r.supply).toBeGreaterThanOrEqual(r.demand);
    expect(r.powered).toBe(true);
  });

  it("more consumers raise demand; powered flips when demand exceeds supply", () => {
    const base = { thermalPlants: 1, solarArrays: 0, temperature: 120, atmosphere: ATM };
    const few = basePower({ ...base, excavators: 1, productionLines: 0 });
    const many = basePower({ ...base, excavators: 50, productionLines: 50 });
    expect(many.demand).toBeGreaterThan(few.demand);
    expect(many.powered).toBe(false); // overwhelmed
  });

  it("no buildings ⇒ trivially powered (supply 0 ≥ demand 0)", () => {
    const r = basePower({
      thermalPlants: 0, solarArrays: 0, excavators: 0, productionLines: 0,
      temperature: 20, atmosphere: ATM,
    });
    expect(r.powered).toBe(true);
  });
});
