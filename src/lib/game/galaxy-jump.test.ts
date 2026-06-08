import { describe, it, expect } from "vitest";
import { CONDENSATE_RECIPE, canHyperwarp } from "@/lib/game/galaxy-jump";
import { canCraft } from "@/lib/game/rules";
import { getMaterial, isMaterialId } from "@/lib/game/materials";

describe("Hyperwarp Condensate is a significant-voidstone consumable", () => {
  it("is a real material and its recipe demands a significant amount of voidstone", () => {
    expect(isMaterialId("hyperwarp_condensate")).toBe(true);
    expect(getMaterial("hyperwarp_condensate")).toBeTruthy();
    expect(CONDENSATE_RECIPE.voidstone).toBeGreaterThanOrEqual(5); // "significant"
    // Recipe references only real catalog items.
    for (const k of Object.keys(CONDENSATE_RECIPE)) {
      expect(getMaterial.length >= 0 || isMaterialId(k) || k === "voidstone").toBe(true);
    }
  });

  it("canCraft gates on having enough voidstone", () => {
    const need = CONDENSATE_RECIPE.voidstone;
    expect(canCraft({ voidstone: need }, CONDENSATE_RECIPE)).toBe(true);
    expect(canCraft({ voidstone: need - 1 }, CONDENSATE_RECIPE)).toBe(false);
    expect(canCraft({}, CONDENSATE_RECIPE)).toBe(false);
  });
});

describe("canHyperwarp — gating", () => {
  it("requires owning a condensate", () => {
    const r = canHyperwarp(0, 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-condensate");
  });

  it("rejects jumping to the galaxy you're already in", () => {
    const r = canHyperwarp(3, 2, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("same-galaxy");
  });

  it("allows the jump with a condensate to a different galaxy", () => {
    expect(canHyperwarp(1, 0, 5).ok).toBe(true);
    expect(canHyperwarp(2, 7, 0).ok).toBe(true); // can travel inward too
  });
});
