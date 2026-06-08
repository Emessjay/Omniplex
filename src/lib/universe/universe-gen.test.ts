import { describe, it, expect } from "vitest";
import {
  RESOURCES,
  getResource,
  BIOMES,
  ATMOSPHERES,
  systemAt,
  planetAt,
  systemKey,
  planetKey,
  parseLocationKey,
  warpDistance,
} from "@/lib/universe";
import type { SystemCoord, PlanetCoord, Planet } from "@/lib/universe";

const SEED = "omniplex-test-seed";

// Deterministic sample of systems across several sectors/systems.
function sampleSystems(seed: string): ReturnType<typeof systemAt>[] {
  const out = [];
  for (let sector = 0; sector < 4; sector++) {
    for (let system = 0; system < 30; system++) {
      out.push(systemAt(seed, { sector, system }));
    }
  }
  return out;
}

function samplePlanets(seed: string): Planet[] {
  return sampleSystems(seed).flatMap((s) => s.planets);
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
    const c: SystemCoord = { sector: 2, system: 7 };
    expect(systemAt(SEED, c)).toStrictEqual(systemAt(SEED, c));
  });

  it("planetAt is deterministic across calls", () => {
    const c: PlanetCoord = { sector: 1, system: 4, planet: 0 };
    expect(planetAt(SEED, c)).toStrictEqual(planetAt(SEED, c));
  });

  it("different seeds produce different universes for at least some coords", () => {
    let differ = 0;
    for (let system = 0; system < 20; system++) {
      const a = systemAt("seed-A", { sector: 0, system });
      const b = systemAt("seed-B", { sector: 0, system });
      if (JSON.stringify(a) !== JSON.stringify(b)) differ++;
    }
    expect(differ).toBeGreaterThan(10);
  });

  it("planetAt agrees with the system's planet list", () => {
    const c: SystemCoord = { sector: 3, system: 9 };
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
      expect(BIOMES).toContain(p.biome);
      expect(ATMOSPHERES).toContain(p.atmosphere);
      expect(p.gravity).toBeGreaterThan(0);
      expect(p.gravity).toBeLessThanOrEqual(10);
      expect(p.hazard).toBeGreaterThanOrEqual(0);
      expect(p.hazard).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p.temperature)).toBe(true);
      for (const d of p.deposits) {
        expect(RESOURCE_IDS.has(d.resourceId)).toBe(true);
        expect(d.abundance).toBeGreaterThanOrEqual(0);
        expect(d.abundance).toBeLessThanOrEqual(1);
      }
    }
  });

  it("the universe is varied, not uniform", () => {
    const biomes = new Set(planets.map((p) => p.biome));
    expect(biomes.size).toBeGreaterThan(2);
    const hazards = new Set(planets.map((p) => Math.round(p.hazard * 10)));
    expect(hazards.size).toBeGreaterThan(3);
    const mostHaveDeposits =
      planets.filter((p) => p.deposits.length > 0).length / planets.length;
    expect(mostHaveDeposits).toBeGreaterThan(0.5);
  });
});

describe("rarity coupling — savage planets carry rare resources (AC#5)", () => {
  const planets = samplePlanets(SEED);
  const savage = planets.filter((p) => p.hazard >= 0.7);
  const calm = planets.filter((p) => p.hazard <= 0.3);

  const maxRarity = (p: Planet) =>
    p.deposits.reduce((m, d) => Math.max(m, getResource(d.resourceId).rarity), 0);
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const fractionWith = (ps: Planet[], pred: (p: Planet) => boolean) =>
    ps.length ? ps.filter(pred).length / ps.length : 0;
  const hasRare = (p: Planet) =>
    p.deposits.some((d) => getResource(d.resourceId).rarity >= 4);
  const hasVoidstone = (p: Planet) =>
    p.deposits.some((d) => d.resourceId === "voidstone");

  it("the sample contains both savage and calm planets", () => {
    expect(savage.length).toBeGreaterThan(15);
    expect(calm.length).toBeGreaterThan(15);
  });

  it("savage planets have higher mean top-rarity than calm planets", () => {
    expect(mean(savage.map(maxRarity))).toBeGreaterThan(
      mean(calm.map(maxRarity)) + 0.5,
    );
  });

  it("rare resources concentrate on savage planets", () => {
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
  // Collect every deposit across a large deterministic sample, tagged with the
  // rarity of its resource, then compare mean abundance of common vs rare ore.
  const deposits = samplePlanets(SEED).flatMap((p) =>
    p.deposits.map((d) => ({
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
    const sc: SystemCoord = { sector: 5, system: 12 };
    const pc: PlanetCoord = { sector: 5, system: 12, planet: 3 };
    expect(systemKey(sc)).toBe("5:12");
    expect(planetKey(pc)).toBe("5:12:3");
    expect(parseLocationKey(systemKey(sc))).toStrictEqual(sc);
    expect(parseLocationKey(planetKey(pc))).toStrictEqual(pc);
  });
});

describe("navigation (AC#8)", () => {
  const a: SystemCoord = { sector: 0, system: 0 };
  const b: SystemCoord = { sector: 0, system: 5 };
  const c: SystemCoord = { sector: 2, system: 1 };

  it("warpDistance is zero to self, symmetric, positive between distinct", () => {
    expect(warpDistance(a, a)).toBe(0);
    expect(warpDistance(a, b)).toBeGreaterThan(0);
    expect(warpDistance(a, b)).toBe(warpDistance(b, a));
    expect(warpDistance(a, c)).toBeGreaterThan(0);
  });
});
