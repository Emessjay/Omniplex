import { describe, it, expect } from "vitest";
import { renderSurfaceMap, type SurfaceMapView, type SurfaceMapCell } from "./render";
import type { RenderSpan } from "@/lib/terminal/types";

/**
 * Game-layer guard for the surface-nav local map (AC#3). The pure `renderSurfaceMap`
 * lays out the player's lat/lon, a biome neighborhood, and clickable `move <dir>`
 * actions — pole-blocked north/south read RED via the P9b `disabled` convention,
 * east/west always wrap. (The pure movement arithmetic is locked in
 * `src/lib/universe/surface-nav.test.ts`.)
 */

/** All action spans in a frame, flattened. */
function actions(frameLines: RenderSpan[][]): Extract<RenderSpan, { kind: "action" }>[] {
  const out: Extract<RenderSpan, { kind: "action" }>[] = [];
  for (const ln of frameLines) {
    for (const span of ln) if (span.kind === "action") out.push(span);
  }
  return out;
}

/** Concatenate all span text in a frame for substring assertions. */
function plain(frameLines: RenderSpan[][]): string {
  return frameLines.map((ln) => ln.map((s) => s.text).join("")).join("\n");
}

const cell = (biome: string, current = false): SurfaceMapCell =>
  ({ biome: biome as SurfaceMapCell["biome"], current });

/** A mid-latitude view (both poles reachable). */
const MIDDLE: SurfaceMapView = {
  planetName: "KEPLER-1b",
  lat: 4,
  lon: 7,
  rows: 10,
  cols: 20,
  cells: [
    [cell("tundra"), cell("tundra"), cell("barren")],
    [cell("desert"), cell("jungle", true), cell("ocean")],
    [cell("volcanic"), cell("desert"), cell("desert")],
  ],
  canNorth: true,
  canSouth: true,
};

describe("renderSurfaceMap — local surface map (surface-nav)", () => {
  it("shows the player's lat/lon position and the current biome (bracketed)", () => {
    const f = renderSurfaceMap(MIDDLE);
    const txt = plain(f.lines);
    expect(txt).toContain("lat 4");
    expect(txt).toContain("lon 7");
    expect(txt).toContain("[jungle]"); // the current cell is bracketed
  });

  it("offers all four move directions as clickable actions", () => {
    const cmds = actions(renderSurfaceMap(MIDDLE).lines).map((a) => a.command);
    expect(cmds).toContain("move north");
    expect(cmds).toContain("move south");
    expect(cmds).toContain("move east");
    expect(cmds).toContain("move west");
  });

  it("east/west are never disabled (longitude wraps), N/S enabled mid-latitude", () => {
    const acts = actions(renderSurfaceMap(MIDDLE).lines);
    const by = (c: string) => acts.find((a) => a.command === c)!;
    expect(by("move east").disabled).toBeFalsy();
    expect(by("move west").disabled).toBeFalsy();
    expect(by("move north").disabled).toBeFalsy();
    expect(by("move south").disabled).toBeFalsy();
  });

  it("at the NORTH pole, `move north` reads red (disabled) but stays a clickable action", () => {
    const atNorthPole: SurfaceMapView = {
      ...MIDDLE,
      lat: 0,
      // top row is off the pole (null); E/W still present
      cells: [
        [null, null, null],
        [cell("tundra"), cell("tundra", true), cell("tundra")],
        [cell("tundra"), cell("barren"), cell("tundra")],
      ],
      canNorth: false,
      canSouth: true,
    };
    const acts = actions(renderSurfaceMap(atNorthPole).lines);
    const north = acts.find((a) => a.command === "move north")!;
    expect(north).toBeDefined(); // still clickable (returns the helpful pole error)
    expect(north.disabled).toBe(true); // P9b red
    expect(acts.find((a) => a.command === "move south")!.disabled).toBeFalsy();
  });

  it("at the SOUTH pole, `move south` reads red (disabled)", () => {
    const atSouthPole: SurfaceMapView = { ...MIDDLE, lat: 9, canNorth: true, canSouth: false };
    const acts = actions(renderSurfaceMap(atSouthPole).lines);
    expect(acts.find((a) => a.command === "move south")!.disabled).toBe(true);
    expect(acts.find((a) => a.command === "move north")!.disabled).toBeFalsy();
  });

  it("hints fast-travel (regions/jump) and launch-to-leave", () => {
    const txt = plain(renderSurfaceMap(MIDDLE).lines);
    expect(txt.toLowerCase()).toContain("jump");
    const cmds = actions(renderSurfaceMap(MIDDLE).lines).map((a) => a.command);
    expect(cmds).toContain("regions");
    expect(cmds).toContain("launch");
  });
});
