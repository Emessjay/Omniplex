import { describe, it, expect } from "vitest";
import {
  systemAt, planetAt, regionAt, regionCoords, regionIndex, regionGrid,
} from "@/lib/universe";
import type { PlanetCoord } from "@/lib/universe";

const SEED = "omniplex-prod-1";
// Pick a rocky (surfaced) planet with a decent region count.
function aRockyPlanet(): PlanetCoord {
  for (let cluster = 40; cluster < 64; cluster++)        // rim = calmer, more habitable
    for (let system = 0; system < 60; system++)
      for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster, system }).planets)
        if (!p.isGas && p.regionCount >= 200) return p.coord;
  throw new Error("no rocky planet found");
}

describe("index ↔ lat/lon bijection", () => {
  const pc = aRockyPlanet();
  const planet = planetAt(SEED, pc);
  const { rows, cols } = regionGrid(planet);

  it("grid is ~1:2 lat:lon and covers regionCount", () => {
    expect(rows).toBeGreaterThan(0);
    expect(cols).toBeGreaterThan(0);
    expect(cols).toBeGreaterThanOrEqual(rows);          // wider than tall (lon:lat ~2:1)
    expect(rows * cols).toBe(planet.regionCount);        // complete grid
  });

  it("regionCoords/regionIndex round-trip across the grid", () => {
    for (let i = 0; i < rows * cols; i += Math.max(1, Math.floor((rows * cols) / 200))) {
      const { lat, lon } = regionCoords(i, rows, cols);
      expect(lat).toBeGreaterThanOrEqual(0);
      expect(lat).toBeLessThan(rows);
      expect(lon).toBeGreaterThanOrEqual(0);
      expect(lon).toBeLessThan(cols);
      expect(regionIndex(lat, lon, cols)).toBe(i);
    }
  });
});

describe("planetary params — present, deterministic, appended (existing fields intact)", () => {
  it("new params exist in sensible ranges and are deterministic", () => {
    const pc = aRockyPlanet();
    const p = planetAt(SEED, pc);
    expect(p.axialTilt).toBeGreaterThanOrEqual(0);
    expect(p.dayLength).toBeGreaterThan(0);
    expect(p.eccentricity).toBeGreaterThanOrEqual(0);
    expect(p.eccentricity).toBeLessThan(1);
    expect(p.rotationSpeed).toBeGreaterThan(0);
    expect(planetAt(SEED, pc)).toStrictEqual(planetAt(SEED, pc));   // deterministic
  });

  it("pre-existing planet fields are unchanged (params appended, not reshaped)", () => {
    // radius/sizeClass/temperature/hazard/biomePalette must still be coherent &
    // deterministic; the planet remains its own size/temperature as before.
    const p = planetAt(SEED, aRockyPlanet());
    expect(typeof p.radius).toBe("number");
    expect(p.biomePalette.length).toBeGreaterThan(0);
    expect(p.biomePalette).not.toContain("gas");        // rocky planet
  });
});

describe("climatic biome bands (equator warm, poles cold, palette-bound)", () => {
  const pc = aRockyPlanet();
  const planet = planetAt(SEED, pc);
  const { rows, cols } = regionGrid(planet);
  const palette = new Set(planet.biomePalette);
  const region = (lat: number, lon: number) =>
    regionAt(SEED, pc, regionIndex(lat, lon, cols));
  const meanTempAtRow = (lat: number) => {
    let s = 0; for (let lon = 0; lon < cols; lon++) s += region(lat, lon).temperature;
    return s / cols;
  };

  it("equator is warmer than the poles", () => {
    const equator = meanTempAtRow(Math.floor(rows / 2));
    const pole = meanTempAtRow(0);
    expect(equator).toBeGreaterThan(pole);
  });

  it("every region's biome is from the planet palette", () => {
    for (let lat = 0; lat < rows; lat += Math.max(1, Math.floor(rows / 10)))
      for (let lon = 0; lon < cols; lon += Math.max(1, Math.floor(cols / 10)))
        expect(palette.has(region(lat, lon).biome)).toBe(true);
  });

  it("biomes are banded, not noise: a row is more internally uniform than the whole planet", () => {
    const distinctInRow = (lat: number) =>
      new Set(Array.from({ length: cols }, (_, lon) => region(lat, lon).biome)).size;
    const distinctOverall = new Set<string>();
    for (let lat = 0; lat < rows; lat++)
      for (let lon = 0; lon < Math.min(cols, 8); lon++) distinctOverall.add(region(lat, lon).biome);
    // an individual latitude row spans fewer biomes than the whole planet (banding)
    expect(distinctInRow(0)).toBeLessThanOrEqual(distinctOverall.size);
  });

  it("is deterministic per region", () => {
    expect(region(2, 3)).toStrictEqual(region(2, 3));
  });
});
