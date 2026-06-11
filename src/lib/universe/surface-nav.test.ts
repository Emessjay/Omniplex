import { describe, it, expect } from "vitest";
import { moveRegion, regionCoords, regionIndex } from "@/lib/universe";

const rows = 10, cols = 20;             // a sample grid
const at = (lat: number, lon: number) => regionIndex(lat, lon, cols);

describe("moveRegion — directional movement over the lat/lon grid", () => {
  it("north decreases latitude, south increases (toward the equator/poles)", () => {
    const start = at(5, 8);
    const n = moveRegion(start, "north", rows, cols)!;
    const s = moveRegion(start, "south", rows, cols)!;
    expect(regionCoords(n, rows, cols)).toEqual({ lat: 4, lon: 8 });
    expect(regionCoords(s, rows, cols)).toEqual({ lat: 6, lon: 8 });
  });

  it("clamps at the poles: north off the top / south off the bottom returns null", () => {
    expect(moveRegion(at(0, 3), "north", rows, cols)).toBeNull();         // north pole
    expect(moveRegion(at(rows - 1, 3), "south", rows, cols)).toBeNull();  // south pole
    // moving the other way from a pole is fine
    expect(moveRegion(at(0, 3), "south", rows, cols)).not.toBeNull();
    expect(moveRegion(at(rows - 1, 3), "north", rows, cols)).not.toBeNull();
  });

  it("east/west WRAP longitude (cyclic globe), never null", () => {
    expect(regionCoords(moveRegion(at(4, cols - 1), "east", rows, cols)!, rows, cols))
      .toEqual({ lat: 4, lon: 0 });                                       // wrap to lon 0
    expect(regionCoords(moveRegion(at(4, 0), "west", rows, cols)!, rows, cols))
      .toEqual({ lat: 4, lon: cols - 1 });                               // wrap to last lon
  });

  it("round-trips: east then west returns to start; cols easts is a full loop", () => {
    const start = at(4, 7);
    const e = moveRegion(start, "east", rows, cols)!;
    expect(moveRegion(e, "west", rows, cols)).toBe(start);
    let cur = start;
    for (let i = 0; i < cols; i++) cur = moveRegion(cur, "east", rows, cols)!;
    expect(cur).toBe(start);                                              // back where we started
  });

  it("is pure/deterministic", () => {
    expect(moveRegion(at(3, 3), "east", rows, cols)).toBe(moveRegion(at(3, 3), "east", rows, cols));
  });
});
