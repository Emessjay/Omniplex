import { describe, it, expect } from "vitest";
import { sameLocation, presentPlayerView } from "@/lib/game/presence"; // wherever it lives

const loc = (o: Partial<any> = {}) => ({
  galaxy: 0, arm: 0, cluster: 5, system: 100, planet: 2, region: 57, ...o,
});

describe("sameLocation — full-tuple co-location", () => {
  it("true iff the entire location tuple matches", () => {
    expect(sameLocation(loc(), loc())).toBe(true);
    expect(sameLocation(loc(), loc({ region: 58 }))).toBe(false);
    expect(sameLocation(loc(), loc({ planet: 3 }))).toBe(false);
    expect(sameLocation(loc(), loc({ system: 101 }))).toBe(false);
    expect(sameLocation(loc(), loc({ cluster: 6 }))).toBe(false);
    expect(sameLocation(loc(), loc({ arm: 1 }))).toBe(false);
    expect(sameLocation(loc(), loc({ galaxy: 1 }))).toBe(false);
  });

  it("groups same-planet orbiters (region 0) and same-outpost dockers (region -1)", () => {
    expect(sameLocation(loc({ region: 0 }), loc({ region: 0 }))).toBe(true);    // both orbiting
    expect(sameLocation(loc({ region: -1 }), loc({ region: -1 }))).toBe(true);  // both at outpost
    expect(sameLocation(loc({ region: 0 }), loc({ region: -1 }))).toBe(false);  // orbit vs outpost differ
  });
});

describe("presentPlayerView — public-safe", () => {
  it("exposes handle/ship/state only — never user_id or email", () => {
    const row: any = {
      id: "p1", user_id: "auth-xyz", email: "secret@example.com", handle: "Atlas",
      shipId: "freighter", embarked: true, landed: false,
      galaxy: 0, arm: 0, cluster: 5, system: 100, planet: 2, region: 0,
    };
    const v = presentPlayerView(row);
    expect(v.handle).toBe("Atlas");
    expect(typeof v.ship).toBe("string");
    expect(v.ship.length).toBeGreaterThan(0);
    // no leak of identity
    const json = JSON.stringify(v);
    expect(json).not.toContain("auth-xyz");
    expect(json).not.toContain("secret@example.com");
    expect((v as any).user_id).toBeUndefined();
    expect((v as any).email).toBeUndefined();
  });
});
