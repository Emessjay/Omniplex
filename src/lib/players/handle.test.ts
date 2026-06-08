import { describe, expect, it } from "vitest";
import { deriveHandleBase, uniqueHandle } from "./handle";

describe("deriveHandleBase", () => {
  it("takes the email local-part, lowercased", () => {
    expect(deriveHandleBase("Nova@example.com")).toBe("nova");
    expect(deriveHandleBase("PILOT@omniplex.gg")).toBe("pilot");
  });

  it("slugs non-alphanumeric runs to single dashes and trims them", () => {
    expect(deriveHandleBase("first.last@x.com")).toBe("first-last");
    expect(deriveHandleBase("a..b__c@x.com")).toBe("a-b-c");
    expect(deriveHandleBase("_edge_@x.com")).toBe("edge");
    expect(deriveHandleBase("plus+tag@x.com")).toBe("plus-tag");
  });

  it("falls back to 'player' when nothing usable remains", () => {
    expect(deriveHandleBase("!!!@x.com")).toBe("player");
    expect(deriveHandleBase("@x.com")).toBe("player");
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
