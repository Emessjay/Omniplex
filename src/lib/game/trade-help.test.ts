import { describe, it, expect } from "vitest";
import {
  tradeCategoryOf,
  groupTradeCandidates,
  creditLabel,
} from "@/lib/game/trade-help";

/**
 * The pure grouping/labeling helpers behind `help buy` / `help sell`. The
 * candidate SET still comes from the live `argDomain` (integration); here we
 * lock the categorization and ordering that turn that flat set into labeled
 * groups.
 */
describe("tradeCategoryOf", () => {
  it("classifies by id per the spec rule", () => {
    expect(tradeCategoryOf("fuel")).toBe("fuel");
    expect(tradeCategoryOf("all")).toBe("everything");
    expect(tradeCategoryOf("ablative_shields")).toBe("upgrades");
    expect(tradeCategoryOf("antifreeze_tanks")).toBe("upgrades");
    expect(tradeCategoryOf("iron")).toBe("minerals");
    expect(tradeCategoryOf("voidstone")).toBe("minerals");
  });
});

describe("groupTradeCandidates", () => {
  it("groups the buy domain into fuel, minerals, upgrades in fixed order", () => {
    const groups = groupTradeCandidates([
      "fuel",
      "iron",
      "silica",
      "ablative_shields",
      "antifreeze_tanks",
    ]);
    expect(groups.map((g) => g.category)).toEqual(["fuel", "minerals", "upgrades"]);
    expect(groups[0]!.ids).toEqual(["fuel"]);
    expect(groups[1]!.ids).toEqual(["iron", "silica"]);
    expect(groups[2]!.ids).toEqual(["ablative_shields", "antifreeze_tanks"]);
  });

  it("groups the sell domain into minerals, upgrades, then everything", () => {
    const groups = groupTradeCandidates([
      "iron",
      "all",
      "ablative_shields",
    ]);
    expect(groups.map((g) => g.category)).toEqual([
      "minerals",
      "upgrades",
      "everything",
    ]);
    expect(groups.find((g) => g.category === "everything")!.ids).toEqual(["all"]);
  });

  it("preserves input order within a group and drops empty groups", () => {
    const groups = groupTradeCandidates(["voidstone", "iron", "copper"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBe("minerals");
    expect(groups[0]!.ids).toEqual(["voidstone", "iron", "copper"]);
  });

  it("returns no groups for an empty candidate set", () => {
    expect(groupTradeCandidates([])).toEqual([]);
  });
});

describe("creditLabel", () => {
  it("formats credits as <n>cr", () => {
    expect(creditLabel(8)).toBe("8cr");
    expect(creditLabel(750)).toBe("750cr");
    expect(creditLabel(0)).toBe("0cr");
  });
});
