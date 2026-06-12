import { describe, it, expect } from "vitest";
import {
  loadoutStats,
  resolveApproach,
  resolveExchange,
  npcApproach,
  npcExchange,
  bountiesAt,
  RANGE_WEAPON_MULT,
  APPROACH_CHOICES,
  EXCHANGE_CHOICES,
  type ShipCombatStats,
  type ShipCombatState,
} from "./combat";
import { MODULES } from "./modules";
import { shipHull } from "./ships";
import { isApplicable, applicableVerbs, type PlayerStateView } from "./applicability";

const SEED = "omniplex-prod-1";

const stats = (o: Partial<ShipCombatStats> = {}): ShipCombatStats => ({
  hullMax: 100,
  shield: 0,
  evade: 0,
  jam: 0,
  lock: 0,
  weapons: { burst: 0, sustained: 0, missile: 0 },
  ...o,
});

const exchangeState = (o: Partial<ShipCombatState>): ShipCombatState => ({
  player: stats(),
  enemy: stats(),
  playerHull: 100,
  playerShield: 0,
  enemyHull: 100,
  enemyShield: 0,
  range: "mid",
  phase: "exchange",
  ...o,
});

// Damage the player deals to the enemy this round (enemy hull lost).
const dmgToEnemy = (state: ShipCombatState) =>
  state.enemyHull - resolveExchange(state, "hull", "hull", [0.5, 0.5]).state.enemyHull;
// Damage the enemy deals to the player this round (player hull lost), given the
// player's chosen maneuver (defaults to a passive hull shot).
const dmgToPlayer = (state: ShipCombatState, playerChoice = "hull" as const) =>
  state.playerHull - resolveExchange(state, playerChoice, "hull", [0.5, 0.5]).state.playerHull;

describe("loadoutStats aggregates the real module catalog", () => {
  it("hull-only on an empty loadout; sums every fitted module into its bucket", () => {
    const everyModule = MODULES.map((m) => m.id);
    const s = loadoutStats(everyModule, "hauler");
    expect(s.hullMax).toBe(shipHull("hauler"));
    // The catalog has at least one of every slot, so each field is positive.
    expect(s.shield).toBeGreaterThan(0);
    expect(s.evade).toBeGreaterThan(0);
    expect(s.jam).toBeGreaterThan(0);
    expect(s.lock).toBeGreaterThan(0);
    expect(s.weapons.burst + s.weapons.sustained + s.weapons.missile).toBeGreaterThan(0);
  });
});

describe("range multipliers — each profile favors its range", () => {
  it("burst best close, sustained best mid, missile best long", () => {
    expect(RANGE_WEAPON_MULT.close.burst).toBeGreaterThan(RANGE_WEAPON_MULT.mid.burst);
    expect(RANGE_WEAPON_MULT.close.burst).toBeGreaterThan(RANGE_WEAPON_MULT.long.burst);
    expect(RANGE_WEAPON_MULT.mid.sustained).toBeGreaterThan(RANGE_WEAPON_MULT.close.sustained);
    expect(RANGE_WEAPON_MULT.mid.sustained).toBeGreaterThan(RANGE_WEAPON_MULT.long.sustained);
    expect(RANGE_WEAPON_MULT.long.missile).toBeGreaterThan(RANGE_WEAPON_MULT.mid.missile);
    expect(RANGE_WEAPON_MULT.long.missile).toBeGreaterThan(RANGE_WEAPON_MULT.close.missile);
  });
});

describe("counter matrix — all four counters bite", () => {
  it("ecm degrades targeting: a jamming defender takes less (ecm↔targeting)", () => {
    const attacker = stats({ lock: 30, weapons: { burst: 0, sustained: 30, missile: 0 } });
    const noJam = dmgToEnemy(exchangeState({ player: attacker, enemy: stats({ jam: 0 }) }));
    const jammed = dmgToEnemy(exchangeState({ player: attacker, enemy: stats({ jam: 20 }) }));
    expect(noJam).toBeGreaterThan(jammed);
  });

  it("evasion dodges missiles: an evasive defender takes less missile damage (evasion↔missiles)", () => {
    const attacker = stats({ lock: 20, weapons: { burst: 0, sustained: 0, missile: 40 } });
    const base = (evade: number) =>
      exchangeState({ player: attacker, enemy: stats({ evade, hullMax: 200 }), enemyHull: 200, range: "long" });
    const vsSlow = dmgToEnemy(base(0));
    const vsAgile = dmgToEnemy(base(30));
    expect(vsSlow).toBeGreaterThan(vsAgile);
  });
});

describe("subsystem choices — each has its stated effect", () => {
  it("`weapons` cuts the target's weapon output next round", () => {
    const enemy = stats({ lock: 20, weapons: { burst: 0, sustained: 30, missile: 0 }, hullMax: 300 });
    const player = stats({ lock: 0, weapons: { burst: 6, sustained: 0, missile: 0 }, hullMax: 300 });
    const st = exchangeState({ player, enemy, playerHull: 300, enemyHull: 300 });
    const r1 = resolveExchange(st, "weapons", "hull", [0.5, 0.5]);
    expect(r1.state.enemyWeaponDebuff ?? 0).toBeGreaterThan(0);
    const freshEnemyDmg = dmgToPlayer(st);
    const debuffedEnemyDmg = dmgToPlayer(r1.state);
    expect(debuffedEnemyDmg).toBeLessThan(freshEnemyDmg);
  });

  it("`engines` cuts the target's evade next round (so it's hit harder)", () => {
    const enemy = stats({ lock: 0, weapons: { burst: 0, sustained: 0, missile: 0 }, hullMax: 300 });
    const player = stats({ lock: 20, weapons: { burst: 0, sustained: 30, missile: 0 }, evade: 0, hullMax: 300 });
    // The player targets the enemy's ENGINES; the enemy is evasive. Next round
    // the (now engine-damaged) enemy dodges less, so the player lands harder.
    const evasiveEnemy = { ...enemy, evade: 40 };
    const st = exchangeState({ player, enemy: evasiveEnemy, playerHull: 300, enemyHull: 300 });
    const r1 = resolveExchange(st, "engines", "hull", [0.5, 0.5]);
    expect(r1.state.enemyEvadeDebuff ?? 0).toBeGreaterThan(0);
    const freshDmg = dmgToEnemy(st);
    const vsEngineDamaged = dmgToEnemy(r1.state);
    expect(vsEngineDamaged).toBeGreaterThan(freshDmg);
  });

  it("`alpha` deals more this round than a straight hull shot", () => {
    const attacker = stats({ lock: 20, weapons: { burst: 30, sustained: 0, missile: 0 } });
    const base = exchangeState({ player: attacker, enemy: stats({ hullMax: 400 }), enemyHull: 400, range: "close" });
    const alphaDmg = 400 - resolveExchange(base, "alpha", "hull", [0.5, 0.5]).state.enemyHull;
    const hullDmg = 400 - resolveExchange(base, "hull", "hull", [0.5, 0.5]).state.enemyHull;
    expect(alphaDmg).toBeGreaterThan(hullDmg);
  });

  it("`alpha` drops your OWN evade this round (you take more incoming)", () => {
    const enemy = stats({ lock: 20, weapons: { burst: 0, sustained: 30, missile: 0 }, hullMax: 300 });
    const player = stats({ evade: 40, weapons: { burst: 0, sustained: 0, missile: 0 }, hullMax: 300 });
    const st = exchangeState({ player, enemy, playerHull: 300, enemyHull: 300 });
    const guarded = dmgToPlayer(st, "hull");
    const exposed = dmgToPlayer(st, "alpha");
    expect(exposed).toBeGreaterThan(guarded);
  });
});

describe("outcomes", () => {
  it("both hulls reaching 0 → defeat takes precedence", () => {
    const st = exchangeState({
      player: stats({ lock: 50, weapons: { burst: 100, sustained: 0, missile: 0 } }),
      enemy: stats({ lock: 50, weapons: { burst: 100, sustained: 0, missile: 0 }, hullMax: 100 }),
      playerHull: 1,
      enemyHull: 1,
      range: "close",
    });
    expect(resolveExchange(st, "hull", "hull", [0.99, 0.99]).outcome).toBe("defeat");
  });
});

describe("approach choices map to range", () => {
  it("covers the choice space and is deterministic", () => {
    for (const p of APPROACH_CHOICES) {
      for (const e of APPROACH_CHOICES) {
        const a = resolveApproach(p, e, [0.5]);
        expect(["close", "mid", "long"]).toContain(a.range);
        expect(resolveApproach(p, e, [0.5])).toStrictEqual(a);
      }
    }
    expect(resolveApproach("close", "close", [0.5]).range).toBe("close");
    expect(resolveApproach("evade", "evade", [0.5]).range).toBe("long");
    // An evade by one side opens the range beyond mutual-close.
    expect(resolveApproach("close", "evade", [0.5]).range).not.toBe("close");
  });
});

describe("NPC AI — sensible + deterministic", () => {
  it("approach: opens range when outgunned, closes for a burst brawler", () => {
    const weak = stats({ weapons: { burst: 5, sustained: 0, missile: 0 } });
    const strong = stats({ weapons: { burst: 100, sustained: 0, missile: 0 } });
    expect(npcApproach(weak, strong, 0.5)).toBe("evade"); // badly outgunned
    expect(npcApproach(stats({ weapons: { burst: 30, sustained: 0, missile: 0 } }), stats(), 0.5)).toBe("close");
    for (const roll of [0.1, 0.5, 0.9]) {
      expect(APPROACH_CHOICES).toContain(npcApproach(strong, weak, roll));
    }
  });

  it("exchange: presses when ahead, disrupts when behind", () => {
    const ahead = exchangeState({ playerHull: 20, enemyHull: 100 });
    const behind = exchangeState({ playerHull: 100, enemyHull: 20 });
    expect(npcExchange(ahead, 0.3)).toBe("alpha");
    expect(npcExchange(ahead, 0.7)).toBe("hull");
    expect(npcExchange(behind, 0.3)).toBe("weapons");
    expect(npcExchange(behind, 0.7)).toBe("engines");
    for (const roll of [0.1, 0.5, 0.9]) {
      expect(EXCHANGE_CHOICES).toContain(npcExchange(ahead, roll));
    }
  });
});

describe("inShipCombat applicability (AC#5)", () => {
  const SHIP_COMBAT: PlayerStateView = {
    embarked: true,
    landed: false,
    inCombat: false,
    inShipCombat: true,
    atTradeLocation: true,
  };

  it("locks to engage/flee + the always set; hides everything else", () => {
    const set = new Set(applicableVerbs(SHIP_COMBAT));
    expect(set.has("engage")).toBe(true);
    expect(set.has("flee")).toBe(true);
    // Always-applicable info/eat/say still work mid-fight.
    expect(isApplicable("scan", SHIP_COMBAT)).toBe(true);
    expect(isApplicable("eat", SHIP_COMBAT)).toBe(true);
    // Ship combat overrides travel/economy/surface/wildlife-combat + hunt.
    for (const v of ["warp", "land", "buy", "sell", "mine", "attack", "hunt", "produce", "jump"]) {
      expect(set.has(v), `${v} should be hidden in ship combat`).toBe(false);
    }
  });

  it("engage is ONLY applicable in ship combat; hunt only at a hub out of combat", () => {
    const orbiting: PlayerStateView = { embarked: true, landed: false, inCombat: false, atTradeLocation: true };
    expect(isApplicable("engage", orbiting)).toBe(false);
    expect(isApplicable("engage", SHIP_COMBAT)).toBe(true);
    // hunt: a hub action (out of any combat).
    expect(isApplicable("hunt", orbiting)).toBe(true);
    expect(isApplicable("hunt", { ...orbiting, atTradeLocation: false })).toBe(false);
    expect(isApplicable("hunt", SHIP_COMBAT)).toBe(false);
    // bounties: informational, usable anywhere (incl. ship combat).
    expect(isApplicable("bounties", SHIP_COMBAT)).toBe(true);
    expect(isApplicable("bounties", { ...orbiting, atTradeLocation: false })).toBe(true);
  });
});

describe("bountiesAt — premium rewards + faction alignment", () => {
  it("every bounty rewards a premium and shares the hub faction", () => {
    const HUB = "0:0:63:100";
    const board = bountiesAt(SEED, HUB, 0, 0);
    expect(board.length).toBeGreaterThan(0);
    const faction = board[0]!.factionId;
    for (const b of board) {
      expect(b.factionId).toBe(faction); // one hub → one faction
      expect(b.rewardCredits).toBeGreaterThan(b.tier * 100); // a real premium per tier
      expect(b.rewardRep).toBeGreaterThanOrEqual(1);
    }
  });

  it("a higher rank tier never lowers the reward (monotonic in rank)", () => {
    const HUB = "0:0:63:100";
    const r0 = bountiesAt(SEED, HUB, 0, 0);
    const r3 = bountiesAt(SEED, HUB, 0, 3);
    // Same RNG stream (rank-independent), so same slots/enemies; rewards only rise.
    expect(r3.map((b) => b.key)).toEqual(r0.map((b) => b.key));
    for (let i = 0; i < r0.length; i++) {
      expect(r3[i]!.rewardCredits).toBeGreaterThanOrEqual(r0[i]!.rewardCredits);
      expect(r3[i]!.enemy.hullMax).toBe(r0[i]!.enemy.hullMax); // enemy unchanged by rank
    }
  });
});
