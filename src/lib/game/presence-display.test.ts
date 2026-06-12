import { describe, it, expect } from "vitest";
import {
  sameLocation,
  presenceState,
  presentPlayerView,
  type PresentPlayer,
} from "@/lib/game/presence";
import { renderPresence, presenceLines } from "@/lib/game/render";
import { frameToText } from "@/lib/terminal/helpers";

describe("presenceState — orbit/surface readout from landed", () => {
  it("landed ⇒ on the surface; not landed ⇒ in orbit", () => {
    expect(presenceState(true)).toBe("on the surface");
    expect(presenceState(false)).toBe("in orbit");
  });
});

describe("presentPlayerView — ship name resolution", () => {
  it("resolves the ship display name from its id", () => {
    const v = presentPlayerView({
      handle: "Zorp",
      shipId: "hauler",
      embarked: true,
      landed: false,
    });
    expect(v).toEqual({ handle: "Zorp", ship: "Hauler", state: "in orbit" });
  });

  it("falls back to the raw id for an unknown ship (never throws)", () => {
    const v = presentPlayerView({
      handle: "Nobody",
      shipId: "dreadnought-9000",
      embarked: false,
      landed: true,
    });
    expect(v.ship).toBe("dreadnought-9000");
    expect(v.state).toBe("on the surface");
  });
});

describe("sameLocation — region groups orbit/outpost", () => {
  const at = (region: number) => ({
    manifold: 0,
    galaxy: 1,
    arm: 2,
    cluster: 3,
    system: 4,
    planet: 5,
    region,
  });
  it("matches identical full tuples and rejects on region", () => {
    expect(sameLocation(at(0), at(0))).toBe(true);
    expect(sameLocation(at(-1), at(-1))).toBe(true);
    expect(sameLocation(at(7), at(8))).toBe(false);
  });
});

describe("presenceLines — scan splice (omit when alone)", () => {
  it("returns no lines when alone", () => {
    expect(presenceLines([])).toEqual([]);
  });
  it("returns a heading + a row per present player", () => {
    const present: PresentPlayer[] = [
      { handle: "Atlas", ship: "Freighter", state: "on the surface" },
    ];
    const lines = presenceLines(present);
    expect(lines.length).toBe(2); // heading + one row
  });
});

describe("renderPresence — the `here` readout", () => {
  it("shows an alone message when no one else is here", () => {
    const txt = frameToText(renderPresence({ location: "Vega · Kepler", present: [] })).join("\n");
    expect(txt).toContain("alone");
  });
  it("lists co-located players with handle, ship and state", () => {
    const present: PresentPlayer[] = [
      { handle: "Atlas", ship: "Freighter", state: "on the surface" },
      { handle: "Zorp", ship: "Hauler", state: "in orbit" },
    ];
    const txt = frameToText(renderPresence({ location: "Vega · Kepler", present })).join("\n");
    expect(txt).toContain("Atlas");
    expect(txt).toContain("Freighter");
    expect(txt).toContain("on the surface");
    expect(txt).toContain("Zorp");
    expect(txt).toContain("Hauler");
    expect(txt).toContain("in orbit");
  });
});
