import { describe, it, expect } from "vitest";
import {
  radiationHazardFloor, radiationShieldRequired,
  RAD_HAZARD_FLOOR_MAX, RADIATION_SHIELD_THRESHOLD,
} from "@/lib/game/rules";
import { UPGRADES, getUpgrade, recipeCost, upgradeValue, isUpgradeId } from "@/lib/game/upgrades";
import { isPartId } from "@/lib/game/parts";
import { planetAt, systemAt, galacticRadiation, RADIATION_MAX, MAX_CLUSTERS_PER_ARM } from "@/lib/universe";

const SEED = "omniplex-prod-1";

describe("radiationHazardFloor", () => {
  it("is 0 at no radiation, monotonic, capped", () => {
    expect(radiationHazardFloor(0)).toBe(0);
    let prev = -1;
    for (let r = 0; r <= RADIATION_MAX; r += RADIATION_MAX / 20) {
      const f = radiationHazardFloor(r);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeLessThanOrEqual(RAD_HAZARD_FLOOR_MAX);
      prev = f;
    }
    expect(radiationHazardFloor(RADIATION_MAX)).toBeGreaterThan(radiationHazardFloor(0));
  });
});

describe("radiation_shield upgrade", () => {
  it("exists, recipe is real parts, value > input cost", () => {
    expect(isUpgradeId("radiation_shield")).toBe(true);
    const u = getUpgrade("radiation_shield");
    for (const k of Object.keys(u.recipe)) {
      expect(isPartId(k)).toBe(true);
      expect(u.recipe[k]!).toBeGreaterThan(0);
    }
    expect(upgradeValue("radiation_shield")).toBeGreaterThan(recipeCost("radiation_shield"));
  });
});

describe("radiationShieldRequired", () => {
  it("kicks in above the threshold (inner clusters), not at the rim", () => {
    expect(RADIATION_SHIELD_THRESHOLD).toBeGreaterThan(0);
    expect(RADIATION_SHIELD_THRESHOLD).toBeLessThan(RADIATION_MAX);
    expect(radiationShieldRequired(RADIATION_MAX)).toBe(true);            // core
    expect(radiationShieldRequired(0)).toBe(false);                      // rim
    expect(radiationShieldRequired(RADIATION_SHIELD_THRESHOLD + 1)).toBe(true);
    expect(radiationShieldRequired(RADIATION_SHIELD_THRESHOLD - 1)).toBe(false);
    // the core requires shielding; the rim does not
    expect(radiationShieldRequired(galacticRadiation(0))).toBe(true);
    expect(radiationShieldRequired(galacticRadiation(MAX_CLUSTERS_PER_ARM - 1))).toBe(false);
  });
});

describe("spatial hazard gradient (core hazardous, rim calm)", () => {
  function meanHazard(cluster: number) {
    let sum = 0, n = 0;
    for (let system = 0; system < 40; system++) {
      for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster, system }).planets) {
        sum += p.hazard; n++;
      }
    }
    return sum / n;
  }
  it("core planets are hazardier on average than rim planets", () => {
    const core = meanHazard(0);
    const rim = meanHazard(MAX_CLUSTERS_PER_ARM - 1);
    expect(core).toBeGreaterThan(rim);
    // every core planet clears the radiation floor for the core
    const floor = radiationHazardFloor(galacticRadiation(0));
    for (let system = 0; system < 10; system++)
      for (const p of systemAt(SEED, { galaxy: 0, arm: 0, cluster: 0, system }).planets)
        expect(p.hazard).toBeGreaterThanOrEqual(floor - 1e-9);
  });
});
