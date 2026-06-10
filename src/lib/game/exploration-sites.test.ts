import { describe, it, expect } from "vitest";
import { DISCOVERY_BOUNTY } from "@/lib/game/rules";

describe("discovery bounty", () => {
  it("is a positive credit reward", () => {
    expect(DISCOVERY_BOUNTY).toBeGreaterThan(0);
  });
});
