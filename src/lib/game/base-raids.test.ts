import { describe, it, expect } from "vitest";
import {
  baseDefenseStats,
} from "@/lib/game/combat"; // (or wherever baseDefenseStats lives)
import {
  raidLoot, raidOnCooldown, RAID_LOOT_FRACTION, RAID_COOLDOWN_MS,
} from "@/lib/game/rules";

describe("baseDefenseStats — defense profile from buildings", () => {
  it("scales up with turrets/shields/tier and is a valid combat profile", () => {
    const weak = baseDefenseStats({ turrets: 1, shieldGenerators: 0, tier: 1, powered: true });
    const strong = baseDefenseStats({ turrets: 4, shieldGenerators: 3, tier: 3, powered: true });
    expect(strong.hullMax).toBeGreaterThanOrEqual(weak.hullMax);
    expect(strong.shield).toBeGreaterThan(weak.shield);
    const wsum = (s: any) => s.weapons.burst + s.weapons.sustained + s.weapons.missile;
    expect(wsum(strong)).toBeGreaterThan(wsum(weak));
    expect(strong.hullMax).toBeGreaterThan(0);
  });

  it("an UNPOWERED base has near-zero defenses (raidable)", () => {
    const on = baseDefenseStats({ turrets: 4, shieldGenerators: 3, tier: 3, powered: true });
    const off = baseDefenseStats({ turrets: 4, shieldGenerators: 3, tier: 3, powered: false });
    const wsum = (s: any) => s.weapons.burst + s.weapons.sustained + s.weapons.missile;
    expect(wsum(off)).toBeLessThan(wsum(on));
    expect(off.shield).toBeLessThan(on.shield);
    // defenses are effectively down when unpowered
    expect(wsum(off)).toBe(0);
  });
});

describe("raidLoot — capped share of the silo", () => {
  it("takes a per-stack floor(qty × fraction), bounded below the stack", () => {
    const silo = [{ itemId: "iron", qty: 100 }, { itemId: "copper", qty: 9 }];
    const loot = raidLoot(silo, RAID_LOOT_FRACTION);
    const iron = loot.find((s) => s.itemId === "iron");
    expect(iron!.qty).toBe(Math.floor(100 * RAID_LOOT_FRACTION));
    expect(iron!.qty).toBeLessThan(100);                       // never the whole stack
    expect(RAID_LOOT_FRACTION).toBeGreaterThan(0);
    expect(RAID_LOOT_FRACTION).toBeLessThan(1);
  });
  it("empty silo ⇒ nothing looted", () => {
    expect(raidLoot([], RAID_LOOT_FRACTION)).toEqual([]);
  });
});

describe("raidOnCooldown — offline-owner protection", () => {
  it("true within the cooldown window, false after / when never raided", () => {
    const now = 1_000_000_000;
    expect(raidOnCooldown(now - RAID_COOLDOWN_MS / 2, now, RAID_COOLDOWN_MS)).toBe(true);
    expect(raidOnCooldown(now - RAID_COOLDOWN_MS * 2, now, RAID_COOLDOWN_MS)).toBe(false);
    expect(raidOnCooldown(null as any, now, RAID_COOLDOWN_MS)).toBe(false);  // never raided
    expect(RAID_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
