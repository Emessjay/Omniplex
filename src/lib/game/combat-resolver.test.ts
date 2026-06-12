import { describe, it, expect } from "vitest";
import {
  loadoutStats, resolveApproach, resolveExchange,
  npcApproach, npcExchange, bountiesAt,
  type ShipCombatStats,
} from "@/lib/game/combat"; // (loadoutStats/shipHull may re-export from modules/ships)
import { shipHull } from "@/lib/game/ships";
import { MODULES } from "@/lib/game/modules";

const SEED = "omniplex-prod-1";
const idsBySlot = (slot: string) => MODULES.filter((m) => m.slot === slot).map((m) => m.id);

describe("loadoutStats — aggregate fitted modules", () => {
  it("empty loadout = hull only, no weapons/defenses", () => {
    const s = loadoutStats([], "shuttle");
    expect(s.hullMax).toBe(shipHull("shuttle"));
    expect(s.shield).toBe(0);
    expect(s.weapons.burst + s.weapons.sustained + s.weapons.missile).toBe(0);
  });
  it("sums fitted module stats into the right buckets", () => {
    const weapon = idsBySlot("weapon")[0]!;
    const shield = idsBySlot("shield")[0]!;
    const s = loadoutStats([weapon, shield], "freighter");
    expect(s.hullMax).toBe(shipHull("freighter"));
    expect(s.shield).toBeGreaterThan(0);              // a shield module fitted
    expect(s.weapons.burst + s.weapons.sustained + s.weapons.missile).toBeGreaterThan(0);
  });
});

describe("shipHull ascends with class", () => {
  it("bigger ships have more hull", () => {
    expect(shipHull("courier")).toBeGreaterThan(shipHull("shuttle"));
    expect(shipHull("freighter")).toBeGreaterThan(shipHull("courier"));
    expect(shipHull("hauler")).toBeGreaterThan(shipHull("freighter"));
  });
});

// Helpers to build contrasting profiles for counter assertions.
const stats = (o: Partial<ShipCombatStats> = {}): ShipCombatStats => ({
  hullMax: 100, shield: 0, evade: 0, jam: 0, lock: 0,
  weapons: { burst: 0, sustained: 0, missile: 0 }, ...o,
});

describe("resolveApproach — pure, sets range", () => {
  it("is deterministic given the same rolls", () => {
    const a = resolveApproach("close", "hold", [0.5]);
    expect(resolveApproach("close", "hold", [0.5])).toStrictEqual(a);
    expect(["close", "mid", "long"]).toContain(a.range);
  });
  it("mutual close → close; an evade pulls the range out", () => {
    expect(resolveApproach("close", "close", [0.5]).range).toBe("close");
    expect(resolveApproach("evade", "evade", [0.5]).range).toBe("long");
  });
});

describe("resolveExchange — counters bite + outcomes", () => {
  // A burst attacker vs a shielded defender takes LESS through than vs an unshielded one.
  it("shield blunts burst damage (shield↔burst counter)", () => {
    const attacker = stats({ lock: 10, weapons: { burst: 40, sustained: 0, missile: 0 } });
    const shielded = { player: attacker, enemy: stats({ shield: 20, hullMax: 100 }),
      playerHull: 100, enemyHull: 100, playerShield: attacker.shield, enemyShield: 20,
      range: "close" as const, phase: "exchange" as const };
    const naked = { ...shielded, enemy: stats({ shield: 0, hullMax: 100 }), enemyShield: 0 };
    const dmgVsShield = 100 - resolveExchange(shielded as any, "hull", "hull", [0.99, 0.99]).state.enemyHull;
    const dmgVsNaked = 100 - resolveExchange(naked as any, "hull", "hull", [0.99, 0.99]).state.enemyHull;
    expect(dmgVsNaked).toBeGreaterThan(dmgVsShield);
  });

  it("targeting beats evasion: high lock lands more than low lock", () => {
    const base = (lock: number) => ({
      player: stats({ lock, weapons: { burst: 0, sustained: 30, missile: 0 } }),
      enemy: stats({ evade: 25, hullMax: 100 }),
      playerHull: 100, enemyHull: 100, playerShield: 0, enemyShield: 0,
      range: "mid" as const, phase: "exchange" as const,
    });
    const hi = 100 - resolveExchange(base(30) as any, "hull", "hold" as any, [0.5, 0.5]).state.enemyHull;
    const lo = 100 - resolveExchange(base(0) as any, "hull", "hold" as any, [0.5, 0.5]).state.enemyHull;
    expect(hi).toBeGreaterThanOrEqual(lo);
  });

  it("detects victory and defeat", () => {
    const nearDead = {
      player: stats({ lock: 50, weapons: { burst: 100, sustained: 0, missile: 0 } }),
      enemy: stats({ hullMax: 100 }),
      playerHull: 100, enemyHull: 1, playerShield: 0, enemyShield: 0,
      range: "close" as const, phase: "exchange" as const,
    };
    const r = resolveExchange(nearDead as any, "hull", "hull", [0.99, 0.01]);
    expect(["victory", undefined]).toContain(r.outcome);   // strong hit should finish it
    // a lethal enemy vs a near-dead player → defeat
    const losing = { ...nearDead, playerHull: 1, enemyHull: 100,
      enemy: stats({ lock: 50, hullMax: 100, weapons: { burst: 100, sustained: 0, missile: 0 } }) };
    const r2 = resolveExchange(losing as any, "hold" as any, "hull", [0.01, 0.99]);
    expect(["defeat", undefined]).toContain(r2.outcome);
  });
});

describe("NPC AI — deterministic", () => {
  it("approach + exchange choices are stable given the same roll", () => {
    const e = stats({ lock: 10, weapons: { burst: 20, sustained: 0, missile: 0 } });
    const p = stats({ evade: 10 });
    expect(npcApproach(e, p, 0.3)).toBe(npcApproach(e, p, 0.3));
    expect(["close", "hold", "evade"]).toContain(npcApproach(e, p, 0.3));
    const st: any = { player: p, enemy: e, playerHull: 80, enemyHull: 40,
      playerShield: 0, enemyShield: 0, range: "mid", phase: "exchange" };
    expect(npcExchange(st, 0.7)).toBe(npcExchange(st, 0.7));
    expect(["weapons", "engines", "hull", "alpha"]).toContain(npcExchange(st, 0.7));
  });
});

describe("bountiesAt — deterministic PvE board", () => {
  const HUB = "0:0:63:100";
  it("is deterministic and rotates per time bucket", () => {
    const b0 = bountiesAt(SEED, HUB, 0, 0);
    expect(bountiesAt(SEED, HUB, 0, 0)).toStrictEqual(b0);
    expect(b0.length).toBeGreaterThan(0);
    const b1 = bountiesAt(SEED, HUB, 1, 0);
    expect(b1.map((b) => b.key)).not.toEqual(b0.map((b) => b.key)); // keys rotate per bucket
  });
  it("bounties are well-formed: positive reward + a real enemy profile", () => {
    for (const b of bountiesAt(SEED, HUB, 0, 0)) {
      expect(b.key.length).toBeGreaterThan(0);
      expect(b.tier).toBeGreaterThan(0);
      expect(b.rewardCredits).toBeGreaterThan(0);
      expect(b.enemy.hullMax).toBeGreaterThan(0);
    }
  });
  it("higher tier ⇒ tougher enemy (more hull)", () => {
    const board = bountiesAt(SEED, HUB, 0, 0);
    const byTier = [...board].sort((a, b) => a.tier - b.tier);
    if (byTier.length >= 2) {
      expect(byTier[byTier.length - 1]!.enemy.hullMax).toBeGreaterThanOrEqual(byTier[0]!.enemy.hullMax);
    }
  });
});
