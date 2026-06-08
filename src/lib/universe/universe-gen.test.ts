import { describe, it, expect } from "vitest";
import {
  RESOURCES,
  getResource,
  BIOMES,
  ATMOSPHERES,
  PALETTE_MIN,
  PALETTE_MAX,
  REGION_COUNT_MIN,
  REGION_COUNT_MAX,
  systemAt,
  planetAt,
  regionAt,
  systemKey,
  planetKey,
  parseLocationKey,
  warpDistance,
} from "@/lib/universe";
import type { SystemCoord, PlanetCoord, Planet, Region } from "@/lib/universe";

const SEED = "omniplex-test-seed";

// Deterministic sample of systems across several clusters/systems.
function sampleSystems(seed: string): ReturnType<typeof systemAt>[] {
  const out = [];
  for (let cluster = 0; cluster < 4; cluster++) {
    for (let system = 0; system < 30; system++) {
      out.push(systemAt(seed, { galaxy: 0, arm: 0, cluster, system }));
    }
  }
  return out;
}

function samplePlanets(seed: string): Planet[] {
  return sampleSystems(seed).flatMap((s) => s.planets);
}

// Deterministic sample of regions: the first `perPlanet` regions of every
// sampled planet. Biome + deposit coverage that used to live on the planet now
// lives here, so the variety / rarity-coupling / abundance assertions sample
// these regions instead of `planet.deposits` / `planet.biome`.
function sampleRegions(seed: string, perPlanet = 8): Region[] {
  const out: Region[] = [];
  for (const p of samplePlanets(seed)) {
    for (let i = 0; i < perPlanet; i++) {
      out.push(regionAt(seed, p.coord, i % p.regionCount));
    }
  }
  return out;
}

const RESOURCE_IDS = new Set(RESOURCES.map((r) => r.id));

describe("resource catalog (AC#6)", () => {
  it("mirrors the DB-seeded catalog: 7 ids with matching rarity", () => {
    const byId = Object.fromEntries(RESOURCES.map((r) => [r.id, r.rarity]));
    expect(byId).toMatchObject({
      iron: 1,
      silica: 1,
      copper: 2,
      titanium: 3,
      iridium: 4,
      xenon: 4,
      voidstone: 5,
    });
    expect(RESOURCES).toHaveLength(7);
  });

  it("getResource returns the catalog entry", () => {
    expect(getResource("voidstone").rarity).toBe(5);
    expect(getResource("iron").rarity).toBe(1);
  });
});

describe("determinism & purity (AC#1)", () => {
  it("systemAt is deterministic across calls", () => {
    const c: SystemCoord = { galaxy: 0, arm: 0, cluster: 2, system: 7 };
    expect(systemAt(SEED, c)).toStrictEqual(systemAt(SEED, c));
  });

  it("planetAt is deterministic across calls", () => {
    const c: PlanetCoord = { galaxy: 0, arm: 0, cluster: 1, system: 4, planet: 0 };
    expect(planetAt(SEED, c)).toStrictEqual(planetAt(SEED, c));
  });

  it("different seeds produce different universes for at least some coords", () => {
    let differ = 0;
    for (let system = 0; system < 20; system++) {
      const a = systemAt("seed-A", { galaxy: 0, arm: 0, cluster: 0, system });
      const b = systemAt("seed-B", { galaxy: 0, arm: 0, cluster: 0, system });
      if (JSON.stringify(a) !== JSON.stringify(b)) differ++;
    }
    expect(differ).toBeGreaterThan(10);
  });

  it("planetAt agrees with the system's planet list", () => {
    const c: SystemCoord = { galaxy: 0, arm: 0, cluster: 3, system: 9 };
    const sys = systemAt(SEED, c);
    for (let p = 0; p < sys.planetCount; p++) {
      expect(planetAt(SEED, { ...c, planet: p })).toStrictEqual(sys.planets[p]);
    }
  });
});

describe("structural validity (AC#3, AC#4)", () => {
  const systems = sampleSystems(SEED);
  const planets = samplePlanets(SEED);

  it("systems are well-formed", () => {
    for (const s of systems) {
      expect(s.planetCount).toBeGreaterThanOrEqual(1);
      expect(s.planetCount).toBeLessThanOrEqual(8);
      expect(s.planets).toHaveLength(s.planetCount);
      expect("OBAFGKM").toContain(s.starClass);
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      s.planets.forEach((p, i) => expect(p.coord.planet).toBe(i));
    }
  });

  it("planets have valid fields in range", () => {
    expect(planets.length).toBeGreaterThan(100);
    for (const p of planets) {
      // Biome moved to the region tier: a planet now carries a distinct, valid
      // palette of size PALETTE_MIN..MAX (the only biomes its regions can be).
      expect(p.biomePalette.length).toBeGreaterThanOrEqual(PALETTE_MIN);
      expect(p.biomePalette.length).toBeLessThanOrEqual(PALETTE_MAX);
      expect(new Set(p.biomePalette).size).toBe(p.biomePalette.length);
      for (const b of p.biomePalette) expect(BIOMES).toContain(b);
      // Region count is an integer in the documented bounds.
      expect(Number.isInteger(p.regionCount)).toBe(true);
      expect(p.regionCount).toBeGreaterThanOrEqual(REGION_COUNT_MIN);
      expect(p.regionCount).toBeLessThanOrEqual(REGION_COUNT_MAX);
      expect(ATMOSPHERES).toContain(p.atmosphere);
      expect(p.gravity).toBeGreaterThan(0);
      expect(p.gravity).toBeLessThanOrEqual(10);
      expect(p.hazard).toBeGreaterThanOrEqual(0);
      expect(p.hazard).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p.temperature)).toBe(true);
    }
  });

  it("region deposits and biomes are valid", () => {
    const regions = sampleRegions(SEED);
    for (const r of regions) {
      expect(BIOMES).toContain(r.biome);
      for (const d of r.deposits) {
        expect(RESOURCE_IDS.has(d.resourceId)).toBe(true);
        expect(d.abundance).toBeGreaterThanOrEqual(0);
        expect(d.abundance).toBeLessThanOrEqual(1);
      }
    }
  });

  it("the universe is varied, not uniform", () => {
    // Biome variety is now measured over regions (each planet's palette is a
    // subset, but across the galaxy regions span many biomes).
    const regions = sampleRegions(SEED);
    const biomes = new Set(regions.map((r) => r.biome));
    expect(biomes.size).toBeGreaterThan(2);
    const hazards = new Set(planets.map((p) => Math.round(p.hazard * 10)));
    expect(hazards.size).toBeGreaterThan(3);
    const mostHaveDeposits =
      regions.filter((r) => r.deposits.length > 0).length / regions.length;
    expect(mostHaveDeposits).toBeGreaterThan(0.5);
  });
});

describe("rarity coupling — savage planets carry rare resources (AC#5)", () => {
  const planets = samplePlanets(SEED);
  const savage = planets.filter((p) => p.hazard >= 0.7);
  const calm = planets.filter((p) => p.hazard <= 0.3);

  // The coupling now lives on the region tier (`regionAt` rolls deposits with
  // the planet's hazard), so we sample a fixed window of each planet's regions
  // and reduce over them. `REGION_SAMPLE` regions per planet is plenty to make
  // the savage/calm trend statistically clear.
  const REGION_SAMPLE = 12;
  const regionsOf = (p: Planet): Region[] => {
    const out: Region[] = [];
    for (let i = 0; i < REGION_SAMPLE; i++) {
      out.push(regionAt(SEED, p.coord, i % p.regionCount));
    }
    return out;
  };

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  // Mean of the per-region top-rarity across a planet's sampled regions.
  const meanTopRarity = (p: Planet) =>
    mean(
      regionsOf(p).map((r) =>
        r.deposits.reduce((m, d) => Math.max(m, getResource(d.resourceId).rarity), 0),
      ),
    );
  const fractionWith = (ps: Planet[], pred: (p: Planet) => boolean) =>
    ps.length ? ps.filter(pred).length / ps.length : 0;
  const hasRare = (p: Planet) =>
    regionsOf(p).some((r) =>
      r.deposits.some((d) => getResource(d.resourceId).rarity >= 4),
    );
  const hasVoidstone = (p: Planet) =>
    regionsOf(p).some((r) => r.deposits.some((d) => d.resourceId === "voidstone"));

  it("the sample contains both savage and calm planets", () => {
    expect(savage.length).toBeGreaterThan(15);
    expect(calm.length).toBeGreaterThan(15);
  });

  it("savage planets have higher mean region top-rarity than calm planets", () => {
    expect(mean(savage.map(meanTopRarity))).toBeGreaterThan(
      mean(calm.map(meanTopRarity)) + 0.5,
    );
  });

  it("rare resources concentrate on savage planets' regions", () => {
    expect(fractionWith(savage, hasRare)).toBeGreaterThan(
      fractionWith(calm, hasRare),
    );
  });

  it("legendary voidstone is essentially exclusive to savage worlds", () => {
    expect(fractionWith(savage, hasVoidstone)).toBeGreaterThan(0);
    expect(fractionWith(calm, hasVoidstone)).toBeLessThan(
      fractionWith(savage, hasVoidstone),
    );
  });
});

describe("abundance is biased by rarity — common ore forms richer veins", () => {
  // Collect every region deposit across a large deterministic sample, tagged
  // with the rarity of its resource, then compare mean abundance of common vs
  // rare ore.
  const deposits = sampleRegions(SEED).flatMap((r) =>
    r.deposits.map((d) => ({
      abundance: d.abundance,
      rarity: getResource(d.resourceId).rarity,
    })),
  );
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  const lowRarity = deposits.filter((d) => d.rarity <= 2).map((d) => d.abundance);
  const highRarity = deposits.filter((d) => d.rarity >= 4).map((d) => d.abundance);

  it("the sample has enough low- and high-rarity deposits to compare", () => {
    expect(lowRarity.length).toBeGreaterThan(30);
    expect(highRarity.length).toBeGreaterThan(30);
  });

  it("low-rarity deposits are meaningfully richer than high-rarity ones", () => {
    // Directional with a margin, robust to RNG — not an exact value.
    expect(mean(lowRarity)).toBeGreaterThan(mean(highRarity) + 0.1);
  });
});

describe("hazard scales with temperature extremity", () => {
  // Over a large deterministic sample, planets with extreme temperatures (very
  // hot OR very cold) should be markedly more hazardous on average than
  // temperate worlds. Directional with a margin — robust to RNG, not exact.
  const planets = samplePlanets(SEED);
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  // "Extreme" = far outside a comfortable band around ~15°C; "temperate" =
  // comfortably inside it. The thresholds are deliberately well clear of the
  // generator's comfort band so the two populations don't overlap.
  const extreme = planets.filter(
    (p) => p.temperature <= -120 || p.temperature >= 250,
  );
  const temperate = planets.filter(
    (p) => p.temperature >= -30 && p.temperature <= 60,
  );

  it("the sample has enough extreme and temperate planets to compare", () => {
    expect(extreme.length).toBeGreaterThan(15);
    expect(temperate.length).toBeGreaterThan(15);
  });

  it("extreme-temperature planets are much more hazardous on average", () => {
    expect(mean(extreme.map((p) => p.hazard))).toBeGreaterThan(
      mean(temperate.map((p) => p.hazard)) + 0.3,
    );
  });
});

describe("location keys round-trip (AC#7)", () => {
  it("systemKey/planetKey parse back to the coord", () => {
    const sc: SystemCoord = { galaxy: 0, arm: 1, cluster: 5, system: 12 };
    const pc: PlanetCoord = { galaxy: 0, arm: 1, cluster: 5, system: 12, planet: 3 };
    expect(systemKey(sc)).toBe("0:1:5:12");
    expect(planetKey(pc)).toBe("0:1:5:12:3");
    expect(parseLocationKey(systemKey(sc))).toStrictEqual(sc);
    expect(parseLocationKey(planetKey(pc))).toStrictEqual(pc);
  });
});

describe("navigation (AC#8)", () => {
  const ARM_COUNT = 12;
  const a: SystemCoord = { galaxy: 0, arm: 0, cluster: 0, system: 0 };
  const b: SystemCoord = { galaxy: 0, arm: 0, cluster: 0, system: 5 };
  const c: SystemCoord = { galaxy: 0, arm: 2, cluster: 2, system: 1 };

  it("warpDistance is zero to self, symmetric, positive between distinct", () => {
    expect(warpDistance(a, a, ARM_COUNT)).toBe(0);
    expect(warpDistance(a, b, ARM_COUNT)).toBeGreaterThan(0);
    expect(warpDistance(a, b, ARM_COUNT)).toBe(warpDistance(b, a, ARM_COUNT));
    expect(warpDistance(a, c, ARM_COUNT)).toBeGreaterThan(0);
  });
});
