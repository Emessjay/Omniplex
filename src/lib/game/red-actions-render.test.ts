import { describe, expect, it } from "vitest";
import { renderMap, renderUpgrades, renderStorage } from "./render";
import type { RenderFrame } from "@/lib/terminal/types";
import type { ActionSpan } from "@/lib/terminal/types";

/**
 * P9b render mapping: handlers mark action tokens the player can't currently
 * perform `disabled` (the renderer paints them red). These cover the headline
 * cases — unaffordable warp, out-of-stock / unaffordable upgrade buys, and
 * build/produce hints gated by cost or missing siloed inputs — asserting the
 * flag tracks the same condition that would gate the command.
 */
function actions(frame: RenderFrame): ActionSpan[] {
  return frame.lines.flat().filter((s): s is ActionSpan => s.kind === "action");
}
function actionFor(frame: RenderFrame, command: string): ActionSpan {
  const found = actions(frame).find((a) => a.command === command);
  if (!found) throw new Error(`no action for "${command}"`);
  return found;
}

describe("renderMap — warp affordability", () => {
  const loc = {
    galaxyName: "Test",
    armCount: 8,
    galaxy: 0,
    arm: 0,
    cluster: 0,
    system: 0,
    planet: 0,
    region: 0,
  };

  it("marks an unaffordable warp red and leaves an affordable one blue", () => {
    const neighbors = [
      { arm: 0, cluster: 0, system: 1, name: "Near", distance: 1, discovered: false },
      { arm: 1, cluster: 5, system: 9, name: "Far", distance: 999, discovered: false },
    ];
    const frame = renderMap(neighbors, 10, loc); // 10 fuel: near affordable, far not
    expect(actionFor(frame, "warp 0 0 1").disabled).toBeFalsy();
    expect(actionFor(frame, "warp 1 5 9").disabled).toBe(true);
  });
});

describe("renderUpgrades — buy supply + affordability", () => {
  it("disables out-of-stock and unaffordable buys, keeps in-stock+affordable enabled", () => {
    const frame = renderUpgrades({
      owned: [],
      market: [
        { upgradeId: "ablative_shields", supply: 3, price: 100 }, // in stock, affordable
        { upgradeId: "antifreeze_tanks", supply: 0, price: 100 }, // out of stock
      ],
      credits: 150,
    });
    expect(actionFor(frame, "buy ablative_shields").disabled).toBeFalsy();
    expect(actionFor(frame, "buy antifreeze_tanks").disabled).toBe(true);
  });

  it("disables an in-stock buy the player can't afford", () => {
    const frame = renderUpgrades({
      owned: [],
      market: [{ upgradeId: "ablative_shields", supply: 3, price: 100 }],
      credits: 50, // < price
    });
    expect(actionFor(frame, "buy ablative_shields").disabled).toBe(true);
  });
});

describe("renderStorage — build cost + producible inputs", () => {
  const base = {
    name: "HQ",
    location: "somewhere",
    silos: 1,
    excavators: 0,
    productionLines: 1,
    used: 0,
    capacity: 1000,
    items: [],
  };

  it("disables unaffordable build hints and not-yet-siloed parts", () => {
    const frame = renderStorage({
      ...base,
      producible: [
        { id: "hull_plating", name: "Hull Plating", recipe: "2 Iron", disabled: false },
        { id: "alloy_beam", name: "Alloy Beam", recipe: "3 Titanium", disabled: true },
      ],
      buildable: { silo: true, excavator: false, production_line: false },
    });
    expect(actionFor(frame, "build silo").disabled).toBeFalsy();
    expect(actionFor(frame, "build excavator").disabled).toBe(true);
    expect(actionFor(frame, "build production_line").disabled).toBe(true);
    expect(actionFor(frame, "produce hull_plating").disabled).toBeFalsy();
    expect(actionFor(frame, "produce alloy_beam").disabled).toBe(true);
  });

  it("leaves build hints enabled when `buildable` is absent (back-compatible)", () => {
    const frame = renderStorage({ ...base, producible: [] });
    expect(actionFor(frame, "build silo").disabled).toBeFalsy();
  });
});
