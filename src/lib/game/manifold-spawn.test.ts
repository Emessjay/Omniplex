import { describe, it, expect } from "vitest";
import { spawnManifold } from "@/lib/game/config"; // or wherever the parsed config helper lives

describe("OMNIPLEX_SPAWN_MANIFOLD config", () => {
  it("defaults to 0 (prime universe) when unset/blank", () => {
    expect(spawnManifold({})).toBe(0);
    expect(spawnManifold({ OMNIPLEX_SPAWN_MANIFOLD: "" })).toBe(0);
  });
  it("parses an integer manifold (e.g. the test universe -1)", () => {
    expect(spawnManifold({ OMNIPLEX_SPAWN_MANIFOLD: "-1" })).toBe(-1);
    expect(spawnManifold({ OMNIPLEX_SPAWN_MANIFOLD: "0" })).toBe(0);
  });
  it("falls back to 0 on a non-integer value (never throws)", () => {
    expect(spawnManifold({ OMNIPLEX_SPAWN_MANIFOLD: "abc" })).toBe(0);
  });
});
