import { describe, it, expect } from "vitest";
import {
  sameLocation,
  presenceChannelFor,
  presenceHintFor,
  sanitizeChatBody,
  presenceRoster,
  CHAT_MAX_LEN,
} from "@/lib/game/presence";

const loc = (o: Partial<any> = {}) => ({
  galaxy: 0, arm: 0, cluster: 5, system: 100, planet: 2, region: 57, ...o,
});

describe("presenceChannelFor — channel ⇔ co-location", () => {
  it("is deterministic and stable for the same location", () => {
    expect(presenceChannelFor(loc())).toBe(presenceChannelFor(loc()));
    expect(typeof presenceChannelFor(loc())).toBe("string");
    expect(presenceChannelFor(loc()).length).toBeGreaterThan(0);
  });

  it("same channel IFF same full location tuple", () => {
    const base = loc();
    // identical → same channel
    expect(presenceChannelFor(base)).toBe(presenceChannelFor(loc()));
    // any differing coord → different channel (and matches sameLocation)
    for (const diff of [
      { region: 58 }, { planet: 3 }, { system: 101 },
      { cluster: 6 }, { arm: 1 }, { galaxy: 1 },
    ]) {
      const other = loc(diff);
      expect(sameLocation(base, other)).toBe(false);
      expect(presenceChannelFor(base)).not.toBe(presenceChannelFor(other));
    }
    // co-location cases that 3a groups → same channel
    expect(presenceChannelFor(loc({ region: 0 }))).toBe(presenceChannelFor(loc({ region: 0 })));   // orbiters
    expect(presenceChannelFor(loc({ region: -1 }))).toBe(presenceChannelFor(loc({ region: -1 }))); // dockers
    expect(presenceChannelFor(loc({ region: 0 }))).not.toBe(presenceChannelFor(loc({ region: -1 })));
  });
});

describe("presenceHintFor — public-safe self hint", () => {
  it("returns {channel, self}; self is public-safe (no identity leak)", () => {
    const player: any = {
      id: "p1", user_id: "auth-xyz", email: "secret@example.com",
      handle: "Atlas", shipId: "freighter", embarked: true, landed: false,
      galaxy: 0, arm: 0, cluster: 5, system: 100, planet: 2, region: 57,
    };
    const hint = presenceHintFor(player);
    expect(hint.channel).toBe(presenceChannelFor(player));
    expect(hint.self.handle).toBe("Atlas");
    expect(typeof hint.self.ship).toBe("string");
    expect(hint.self.ship.length).toBeGreaterThan(0);
    expect(typeof hint.self.state).toBe("string");
    const json = JSON.stringify(hint);
    expect(json).not.toContain("auth-xyz");
    expect(json).not.toContain("secret@example.com");
    expect((hint.self as any).user_id).toBeUndefined();
    expect((hint.self as any).email).toBeUndefined();
  });
});

describe("sanitizeChatBody", () => {
  it("trims, preserves normal text + case", () => {
    expect(sanitizeChatBody("  Hello There  ")).toBe("Hello There");
    expect(sanitizeChatBody("GLHF o7")).toBe("GLHF o7");
  });
  it("returns null for empty / whitespace-only", () => {
    expect(sanitizeChatBody("")).toBeNull();
    expect(sanitizeChatBody("    ")).toBeNull();
    expect(sanitizeChatBody("\n\t  ")).toBeNull();
  });
  it("strips newlines/control chars (no multi-line injection)", () => {
    const out = sanitizeChatBody("hi\nthere\tnow");
    expect(out).not.toBeNull();
    expect(out!).not.toContain("\n");
    // no raw control chars (U+0000–U+001F) survive — newlines/tabs removed or collapsed
    expect([...out!].every((c) => c.charCodeAt(0) >= 32)).toBe(true);
  });
  it("caps length at CHAT_MAX_LEN", () => {
    expect(CHAT_MAX_LEN).toBeGreaterThan(0);
    const out = sanitizeChatBody("x".repeat(CHAT_MAX_LEN + 50));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(CHAT_MAX_LEN);
  });
});

describe("presenceRoster — live roster reducer", () => {
  // Realtime presence-state shape: { [key]: Array<metadata> }
  const state = {
    k1: [{ handle: "Atlas", ship: "Freighter", state: "in orbit", key: "Atlas" }],
    k2: [{ handle: "Zorp", ship: "Hauler", state: "on the surface", key: "Zorp" }],
    kself: [{ handle: "Me", ship: "Shuttle", state: "in orbit", key: "Me" }],
  };

  it("excludes self, returns public-safe others", () => {
    const roster = presenceRoster(state as any, "Me");
    const handles = roster.map((r) => r.handle);
    expect(handles).not.toContain("Me");
    expect(handles).toContain("Atlas");
    expect(handles).toContain("Zorp");
    for (const r of roster) {
      expect(typeof r.handle).toBe("string");
      expect(typeof r.ship).toBe("string");
      expect(typeof r.state).toBe("string");
      expect((r as any).user_id).toBeUndefined();
      expect((r as any).email).toBeUndefined();
    }
  });

  it("dedupes by handle and is stably ordered", () => {
    const dup = { ...state, k3: [{ handle: "Atlas", ship: "Freighter", state: "in orbit", key: "Atlas2" }] };
    const roster = presenceRoster(dup as any, "Me");
    expect(roster.filter((r) => r.handle === "Atlas").length).toBe(1);
    const handles = roster.map((r) => r.handle);
    expect(handles).toEqual([...handles].sort());   // stable, sorted by handle
  });

  it("handles empty / malformed state defensively", () => {
    expect(presenceRoster({} as any, "Me")).toEqual([]);
    expect(Array.isArray(presenceRoster({ k: [] } as any, "Me"))).toBe(true);
    expect(() => presenceRoster({ k: [{}] } as any, "Me")).not.toThrow();
  });
});
