/**
 * Ship-combat resolver (Combat-1b) — the CENTREPIECE of the Combat pillar: an
 * interactive, turn-by-turn ship-to-ship fight, proven against a PvE bounty
 * board. This module is the PURE core (no IO, no `Date`, no `Math.random`):
 * the handler boundary (`commands.ts`) injects the random rolls + the NPC's
 * choice via `Math.random()` and the bounty time bucket via `Date.now()`, the
 * same discipline as `combatRound` (wildlife) and `contractsAt` (factions).
 *
 * It consumes Combat-1a's fitted loadouts: `loadoutStats` aggregates a ship's
 * fitted module `stats` (which were defined-but-unused in 1a) into a ship-level
 * `ShipCombatStats` profile. A fight is a STATEFUL multi-command exchange —
 * one `approach` phase (sets range) then repeated `exchange` rounds until a
 * hull reaches 0 — with a legible rock-paper-scissors counter matrix:
 *   - targeting ↔ evasion   (lock beats evade)
 *   - ecm ↔ targeting        (jam degrades the opponent's lock)
 *   - shield ↔ burst         (shields blunt burst hardest)
 *   - evasion ↔ missiles     (evade dodges missiles specifically)
 * plus per-profile range multipliers (burst best close, sustained best mid,
 * missile best long) and four subsystem choices (weapons/engines/hull/alpha).
 *
 * Combat-2 (async PvP + ship destruction/insurance) and Combat-3 (live duels +
 * the combat-logging penalty) build directly on this resolver + the persisted
 * `players.combat` session.
 */
import { getModule } from "./modules";
import { shipHull } from "./ships";
import { effectiveHull, MAX_SHIP_CONDITION } from "./rules";
import type { WeaponProfile } from "./modules";
import { factionAt } from "./factions";
import { makeRng, pick, randInt } from "@/lib/universe/prng";

// ---------------------------------------------------------------------------
// Ship combat profile + loadout aggregation
// ---------------------------------------------------------------------------

/** Per-profile weapon-damage totals (the three firing profiles, all ≥ 0). */
export interface WeaponDamage {
  burst: number;
  sustained: number;
  missile: number;
}

/**
 * A ship-level combat profile — the aggregate of a hull's base integrity plus
 * its fitted modules' `stats`. All fields are ≥ 0. This is the SNAPSHOT taken
 * at engage-start (`loadoutStats`) and the shape the bounty board posts for an
 * NPC enemy (`bountiesAt`).
 */
export interface ShipCombatStats {
  /** Maximum (and starting) hull integrity. */
  hullMax: number;
  /** Total shield absorb — blunts incoming damage, burst hardest. */
  shield: number;
  /** Total evasion — dodges incoming fire (missiles especially). */
  evade: number;
  /** Total ECM jamming — degrades the opponent's effective targeting (lock). */
  jam: number;
  /** Total targeting lock — improves hit quality against an evasive target. */
  lock: number;
  /** Weapon damage bucketed by firing profile. */
  weapons: WeaponDamage;
}

/**
 * Aggregate a ship's fitted module `stats` into a `ShipCombatStats` profile.
 * `hullMax = shipHull(shipId)`; each fitted module folds into the matching
 * field (weapon damage bucketed by `profile`; shield→Σabsorb; evasion→Σevade;
 * ecm→Σjam; targeting→Σlock). An EMPTY loadout yields just the hull (no weapons
 * or defenses — you can fly into a fight unarmed and lose). Pure.
 *
 * `condition` (Combat-2 stakes primitive) scales `hullMax` via `effectiveHull`:
 * a beat-up ship enters a fight with less hull. Defaults to `MAX_SHIP_CONDITION`
 * (pristine = the bare `shipHull`), so callers that don't track condition — and
 * the NPC/bounty profiles, which are generated directly — read unchanged. Still
 * pure (no IO/Date): the condition is passed in at the engage-start boundary.
 */
export function loadoutStats(
  loadout: readonly string[],
  shipId: string,
  condition: number = MAX_SHIP_CONDITION,
): ShipCombatStats {
  const s: ShipCombatStats = {
    hullMax: effectiveHull(shipHull(shipId), condition),
    shield: 0,
    evade: 0,
    jam: 0,
    lock: 0,
    weapons: { burst: 0, sustained: 0, missile: 0 },
  };
  for (const id of loadout) {
    const stats = getModule(id).stats;
    switch (stats.slot) {
      case "weapon":
        s.weapons[stats.profile] += stats.damage;
        break;
      case "shield":
        s.shield += stats.absorb;
        break;
      case "evasion":
        s.evade += stats.evade;
        break;
      case "ecm":
        s.jam += stats.jam;
        break;
      case "targeting":
        s.lock += stats.lock;
        break;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Base defenses (Combat-2a) — a player's base, rendered as a ship-combat enemy.
//
// A raider fights the target base's installed DEFENSE buildings through the SAME
// resolver/`engage` session a bounty hunt uses: turrets supply the base's attack
// profile, shield generators its shield, and the base TIER its "hull". The
// crucial coupling: defenses are POWER-GATED — when the base is `!powered`, its
// guns and shields read NEAR-ZERO (only the inert hull remains), so an unpowered
// base is easy pickings. Pure: the building counts + `powered` are passed in
// (the handler reads them off the base + `basePower`).
// ---------------------------------------------------------------------------

/** Base "hull" (the integrity a raider must grind to 0) per base tier. */
const BASE_DEFENSE_HULL_PER_TIER = 80;
/** Per-turret weapon damage, split across the three firing profiles (a mix). */
const TURRET_WEAPONS: WeaponDamage = { burst: 4, sustained: 3, missile: 2 };
/** Shield absorb each shield generator contributes. */
const SHIELD_PER_GENERATOR = 8;
/** Targeting lock each turret contributes (so a defended base can actually hit). */
const TURRET_LOCK = 3;

/**
 * The combat profile a base presents to a raider (Combat-2a), as a
 * `ShipCombatStats` the standard resolver fights. Turrets fold into the weapon
 * mix + targeting lock; shield generators into shield absorb; the base `tier`
 * into `hullMax` (a base's integrity, monotonic in tier, always > 0). When the
 * base is **`!powered`**, the active defenses are OFFLINE — weapons and shield
 * read zero (only the inert tier-hull remains), so an unpowered base is trivially
 * raidable (this is what ties power to defense). A base never evades or jams.
 * Pure.
 */
export function baseDefenseStats(args: {
  turrets: number;
  shieldGenerators: number;
  tier: number;
  powered: boolean;
}): ShipCombatStats {
  const turrets = Math.max(0, Math.floor(args.turrets));
  const gens = Math.max(0, Math.floor(args.shieldGenerators));
  const tier = Math.max(1, Math.floor(args.tier));
  const hullMax = BASE_DEFENSE_HULL_PER_TIER * tier;
  if (!args.powered) {
    // Defenses offline: only the hull stands — near-zero, raidable.
    return { hullMax, shield: 0, evade: 0, jam: 0, lock: 0, weapons: { burst: 0, sustained: 0, missile: 0 } };
  }
  return {
    hullMax,
    shield: gens * SHIELD_PER_GENERATOR,
    evade: 0,
    jam: 0,
    lock: turrets * TURRET_LOCK,
    weapons: {
      burst: turrets * TURRET_WEAPONS.burst,
      sustained: turrets * TURRET_WEAPONS.sustained,
      missile: turrets * TURRET_WEAPONS.missile,
    },
  };
}

// ---------------------------------------------------------------------------
// Range model + the fight state
// ---------------------------------------------------------------------------

/** Combat range — modifies weapon effectiveness per profile. */
export type Range = "close" | "mid" | "long";

/** Approach maneuvers (the phase that sets range). */
export type ApproachChoice = "close" | "hold" | "evade";

/** Exchange maneuvers (the per-round subsystem targeting choice). */
export type ExchangeChoice = "weapons" | "engines" | "hull" | "alpha";

export const APPROACH_CHOICES: readonly ApproachChoice[] = ["close", "hold", "evade"];
export const EXCHANGE_CHOICES: readonly ExchangeChoice[] = ["weapons", "engines", "hull", "alpha"];

/**
 * Per-profile range multiplier (exported so the renderer/help can explain it):
 * burst is best at close, sustained at mid, missiles at long. A clear bonus on
 * the matching range and a penalty off it.
 */
export const RANGE_WEAPON_MULT: Record<Range, WeaponDamage> = {
  close: { burst: 1.5, sustained: 1.0, missile: 0.5 },
  mid: { burst: 1.0, sustained: 1.5, missile: 1.0 },
  long: { burst: 0.5, sustained: 1.0, missile: 1.5 },
};

/**
 * The mutable state of an in-progress fight. The session persisted in
 * `players.combat` (a `ShipCombat`) is a superset of this — it adds the bounty
 * identity + rewards. The pure resolver operates only on these core fields.
 * The `*Debuff` fields are PENDING modifiers applied THIS round (set by the
 * previous round's subsystem hits); they are fractions in `[0, 1)`.
 */
export interface ShipCombatState {
  player: ShipCombatStats;
  enemy: ShipCombatStats;
  playerHull: number;
  playerShield: number;
  enemyHull: number;
  enemyShield: number;
  range: Range | null;
  phase: "approach" | "exchange";
  /** Fraction the player's weapon output is reduced this round (enemy hit engines/weapons). */
  playerWeaponDebuff?: number;
  /** Fraction the player's evade is reduced this round. */
  playerEvadeDebuff?: number;
  /** Fraction the enemy's weapon output is reduced this round. */
  enemyWeaponDebuff?: number;
  /** Fraction the enemy's evade is reduced this round. */
  enemyEvadeDebuff?: number;
}

/** The terminal outcome of an exchange, if any. */
export type CombatOutcome = "victory" | "defeat";

// ---------------------------------------------------------------------------
// Tuning constants (all pure, documented inline; tune freely — the contract is
// the counter directions + monotonicity, not the exact numbers).
// ---------------------------------------------------------------------------

/** Base hit quality before lock/evade/roll adjustments. */
const HIT_BASE = 0.6;
/** Each point of effective lock adds this to hit quality. */
const HIT_LOCK_COEF = 0.02;
/** Each point of defender evade subtracts this from hit quality. */
const HIT_EVADE_COEF = 0.02;
/** Roll variance band on hit quality (roll 0→−half, 1→+half). */
const HIT_VAR = 0.2;
/** Hit-quality clamp — never a total whiff, never an absurd multiplier. */
const HIT_MIN = 0.05;
const HIT_MAX = 1.3;

/** Each point of defender evade dodges this fraction of MISSILE damage (evasion↔missiles). */
const MISSILE_EVADE_COEF = 0.02;

/** Extra shield absorb vs a burst-heavy hit, as a fraction of the burst share (shield↔burst). */
const SHIELD_BURST_BONUS = 0.75;

/** `weapons` subsystem hit: fraction the target's weapon output drops next round. */
const SUBSYSTEM_WEAPON_DEBUFF = 0.35;
/** `engines` subsystem hit: fraction the target's evade drops next round. */
const SUBSYSTEM_EVADE_DEBUFF = 0.5;
/** `alpha` strike: bonus damage this round… */
const ALPHA_DAMAGE_BONUS = 0.4;
/** …at the cost of dropping your OWN evade this round (you're easier to hit). */
const ALPHA_EVADE_PENALTY = 0.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Range-weighted raw weapon damage per profile (before hit quality / defenses). */
function rangedWeapons(weapons: WeaponDamage, range: Range, weaponDebuff: number): WeaponDamage {
  const m = RANGE_WEAPON_MULT[range];
  const k = 1 - clamp(weaponDebuff, 0, 1);
  return {
    burst: weapons.burst * m.burst * k,
    sustained: weapons.sustained * m.sustained * k,
    missile: weapons.missile * m.missile * k,
  };
}

/**
 * Hit quality in `[HIT_MIN, HIT_MAX]`: rises with the attacker's EFFECTIVE lock
 * (its `lock` minus the defender's `jam` — the ecm↔targeting counter), falls
 * with the defender's evade (targeting↔evasion), with a bounded roll variance.
 */
function hitQuality(lock: number, jamOnAttacker: number, defenderEvade: number, roll: number): number {
  const effLock = Math.max(0, lock - jamOnAttacker);
  const q = HIT_BASE + HIT_LOCK_COEF * effLock - HIT_EVADE_COEF * Math.max(0, defenderEvade) + (roll - 0.5) * HIT_VAR;
  return clamp(q, HIT_MIN, HIT_MAX);
}

/**
 * Damage one side deals to the other this round, AFTER hit quality, missile-
 * evasion, the alpha bonus, and the defender's shield absorb (burst-weighted).
 * Returns the integer damage that reaches the shield-pool/hull stack.
 */
function computeDamage(args: {
  attacker: ShipCombatStats;
  attackerWeaponDebuff: number;
  attackerChoice: ExchangeChoice;
  defender: ShipCombatStats;
  defenderEvade: number; // already reduced by debuffs / alpha for this round
  range: Range;
  roll: number;
}): number {
  const { attacker, attackerWeaponDebuff, attackerChoice, defender, defenderEvade, range, roll } = args;
  const w = rangedWeapons(attacker.weapons, range, attackerWeaponDebuff);
  // Evasion dodges missiles specifically (evasion↔missiles).
  const missile = w.missile * Math.max(0, 1 - Math.max(0, defenderEvade) * MISSILE_EVADE_COEF);
  const rawTotal = w.burst + w.sustained + missile;
  if (rawTotal <= 0) return 0;
  const hq = hitQuality(attacker.lock, defender.jam, defenderEvade, roll);
  let dmg = rawTotal * hq;
  if (attackerChoice === "alpha") dmg *= 1 + ALPHA_DAMAGE_BONUS;
  // Shield mitigation, burst-weighted: shields blunt burst hardest (shield↔burst).
  const burstShare = w.burst / rawTotal;
  const mitigation = defender.shield * (1 + SHIELD_BURST_BONUS * burstShare);
  dmg = Math.max(0, dmg - mitigation);
  return Math.round(dmg);
}

/** Apply `dmg` to a shield pool then hull; returns the new {shield, hull}. */
function applyDamage(shield: number, hull: number, dmg: number): { shield: number; hull: number } {
  const absorbed = Math.min(shield, dmg);
  const toHull = dmg - absorbed;
  return { shield: shield - absorbed, hull: hull - toHull };
}

// ---------------------------------------------------------------------------
// Phase resolvers
// ---------------------------------------------------------------------------

const APPROACH_RANK: Record<ApproachChoice, number> = { close: 0, hold: 1, evade: 2 };

/**
 * Resolve the APPROACH phase: both sides pick `close | hold | evade`; the pair
 * maps to a starting range. Mutual close → close; any evade pulls the range out
 * (mutual evade → long); holding settles to mid. Deterministic given `rolls`
 * (the roll only nudges the ambiguous middle band, never the extremes, so
 * `close`/`close` is always close and `evade`/`evade` is always long).
 */
export function resolveApproach(
  playerChoice: ApproachChoice,
  enemyChoice: ApproachChoice,
  rolls: number[],
): { range: Range; log: string[] } {
  const sum = APPROACH_RANK[playerChoice] + APPROACH_RANK[enemyChoice]; // 0..4
  let range: Range;
  if (sum <= 1) range = "close";
  else if (sum >= 4) range = "long";
  else {
    // Ambiguous middle (sum 2 or 3): default mid; a high roll on sum 3 (an evade
    // in play) can open it to long — a small evade-flavored roll influence that
    // never touches the extremes.
    const roll = rolls.length > 0 ? rolls[0]! : 0.5;
    range = sum === 3 && roll > 0.5 ? "long" : "mid";
  }
  return {
    range,
    log: [`Maneuvering settles the fight at ${range} range.`],
  };
}

/**
 * Resolve ONE exchange round: both sides fire SIMULTANEOUSLY. Each side's
 * damage runs hit/penetration (lock vs evade, − the defender's jam, × range),
 * the subsystem choice, missile-evasion, and shield absorb, then applies to the
 * target's shield pool and hull. Subsystem choices: `weapons` cuts the target's
 * weapons next round; `engines` cuts its evade next round; `hull` is straight
 * damage; `alpha` adds damage this round but drops your own evade this round.
 * Returns the new state, a readable log, and an `outcome` when a hull reaches 0
 * (both-zero → `defeat` takes precedence). Deterministic given `rolls`
 * (`rolls[0]` = player hit variance, `rolls[1]` = enemy hit variance).
 */
export function resolveExchange(
  state: ShipCombatState,
  playerChoice: ExchangeChoice,
  enemyChoice: ExchangeChoice,
  rolls: number[],
): { state: ShipCombatState; log: string[]; outcome?: CombatOutcome } {
  const range: Range = state.range ?? "mid";
  const pRoll = rolls.length > 0 ? rolls[0]! : 0.5;
  const eRoll = rolls.length > 1 ? rolls[1]! : 0.5;

  // Effective evade this round: reduced by an incoming engines-debuff and, if you
  // chose alpha, by your own alpha evade penalty. Unknown choices (the tests pass
  // an approach token for a passive enemy) fall through as "no special effect".
  const playerEvadeReduction = clamp((state.playerEvadeDebuff ?? 0) + (playerChoice === "alpha" ? ALPHA_EVADE_PENALTY : 0), 0, 1);
  const enemyEvadeReduction = clamp((state.enemyEvadeDebuff ?? 0) + (enemyChoice === "alpha" ? ALPHA_EVADE_PENALTY : 0), 0, 1);
  const playerEffEvade = state.player.evade * (1 - playerEvadeReduction);
  const enemyEffEvade = state.enemy.evade * (1 - enemyEvadeReduction);

  const playerDmg = computeDamage({
    attacker: state.player,
    attackerWeaponDebuff: state.playerWeaponDebuff ?? 0,
    attackerChoice: playerChoice,
    defender: state.enemy,
    defenderEvade: enemyEffEvade,
    range,
    roll: pRoll,
  });
  const enemyDmg = computeDamage({
    attacker: state.enemy,
    attackerWeaponDebuff: state.enemyWeaponDebuff ?? 0,
    attackerChoice: enemyChoice,
    defender: state.player,
    defenderEvade: playerEffEvade,
    range,
    roll: eRoll,
  });

  const onEnemy = applyDamage(state.enemyShield, state.enemyHull, playerDmg);
  const onPlayer = applyDamage(state.playerShield, state.playerHull, enemyDmg);

  // Outgoing pending debuffs for NEXT round, from this round's subsystem choices.
  const next: ShipCombatState = {
    ...state,
    range,
    phase: "exchange",
    enemyShield: Math.max(0, onEnemy.shield),
    enemyHull: Math.max(0, onEnemy.hull),
    playerShield: Math.max(0, onPlayer.shield),
    playerHull: Math.max(0, onPlayer.hull),
    // Consume this round's incoming debuffs; set next round's from the choices.
    enemyWeaponDebuff: playerChoice === "weapons" ? SUBSYSTEM_WEAPON_DEBUFF : 0,
    enemyEvadeDebuff: playerChoice === "engines" ? SUBSYSTEM_EVADE_DEBUFF : 0,
    playerWeaponDebuff: enemyChoice === "weapons" ? SUBSYSTEM_WEAPON_DEBUFF : 0,
    playerEvadeDebuff: enemyChoice === "engines" ? SUBSYSTEM_EVADE_DEBUFF : 0,
  };

  const log: string[] = [
    `You deal ${playerDmg} (${subsystemVerb(playerChoice)}); the enemy deals ${enemyDmg}.`,
    `Enemy hull ${next.enemyHull}/${state.enemy.hullMax}, your hull ${next.playerHull}/${state.player.hullMax}.`,
  ];

  // Outcome — both-zero → defeat precedence.
  let outcome: CombatOutcome | undefined;
  if (onPlayer.hull <= 0) outcome = "defeat";
  else if (onEnemy.hull <= 0) outcome = "victory";

  return { state: next, log, outcome };
}

/** A short verb for an exchange choice, for the combat log. */
function subsystemVerb(choice: ExchangeChoice): string {
  switch (choice) {
    case "weapons":
      return "targeting weapons";
    case "engines":
      return "targeting engines";
    case "alpha":
      return "alpha strike";
    default:
      return "hull shot";
  }
}

// ---------------------------------------------------------------------------
// NPC AI — pure + deterministic given the injected roll. A legible heuristic
// (press the advantage when ahead, disrupt/defend when behind), NOT optimal —
// the player should be able to out-think it.
// ---------------------------------------------------------------------------

/** Total raw weapon output of a profile (for the AI's power comparisons). */
function totalWeapons(s: ShipCombatStats): number {
  return s.weapons.burst + s.weapons.sustained + s.weapons.missile;
}

/**
 * The NPC's approach maneuver. Outgunned (the player out-damages it badly) → it
 * opens the range with `evade`; otherwise it closes to the range that suits its
 * dominant weapon (burst→close, missile→evade/long, sustained→hold/mid). The
 * `roll` breaks the otherwise-`hold` middle toward closing when it's aggressive.
 */
export function npcApproach(enemyStats: ShipCombatStats, playerStats: ShipCombatStats, roll: number): ApproachChoice {
  if (totalWeapons(playerStats) > totalWeapons(enemyStats) * 1.5) return "evade";
  const w = enemyStats.weapons;
  if (w.burst >= w.sustained && w.burst >= w.missile && w.burst > 0) return "close";
  if (w.missile >= w.sustained && w.missile >= w.burst && w.missile > 0) return "evade";
  // Sustained-leaning or unarmed: hold at mid, but a high roll presses to close.
  return roll > 0.7 ? "close" : "hold";
}

/**
 * The NPC's exchange maneuver. AHEAD (its hull ≥ the player's) → it presses:
 * an `alpha` strike or a straight `hull` shot. BEHIND → it disrupts: knock out
 * the player's `weapons` or `engines`. Deterministic given `roll`.
 */
export function npcExchange(state: ShipCombatState, roll: number): ExchangeChoice {
  const ahead = state.enemyHull >= state.playerHull;
  if (ahead) return roll < 0.5 ? "alpha" : "hull";
  return roll < 0.5 ? "weapons" : "engines";
}

// ---------------------------------------------------------------------------
// PvE bounty board — mirror of `contractsAt`/`completed_contracts`. A bounded,
// deterministic set of NPC "wanted" ships posted at a hub, rotating per time
// bucket, with tier-scaled enemies + premium rewards.
// ---------------------------------------------------------------------------

/** A posted PvE bounty: an NPC wanted ship to hunt for a credit + rep reward. */
export interface Bounty {
  /** Deterministic id incl. the time bucket — stable within a bucket, distinct across buckets. */
  key: string;
  /** Flavor name of the wanted ship/pilot. */
  name: string;
  /** Difficulty tier (≥ 1) — scales the enemy + the reward. */
  tier: number;
  /** The hub faction posting the bounty (rep is awarded to it on a kill). */
  factionId: string;
  /** The NPC ship's combat profile (scaled up by tier). */
  enemy: ShipCombatStats;
  rewardCredits: number;
  rewardRep: number;
}

/** Bounty board rotation period (mirrors `CONTRACT_ROTATION_MS` — three hours). */
export const BOUNTY_ROTATION_MS = 3 * 60 * 60 * 1000;

/** Min / max bounties a hub posts per time bucket. */
const BOUNTIES_MIN = 3;
const BOUNTIES_MAX = 5;
/** Highest bounty difficulty tier on the board. */
const MAX_BOUNTY_TIER = 4;
/** Base hull a tier-1 enemy carries; hull scales linearly with tier. */
const BOUNTY_BASE_HULL = 90;
/** Base credit reward per tier (a premium — these pay well). */
const BOUNTY_REWARD_PER_TIER = 1200;
/** Extra reward fraction per rank tier (rank-scaling, optional this phase). */
const BOUNTY_RANK_REWARD_PER_TIER = 0.15;

/** Flavor name fragments for wanted ships. */
const BOUNTY_PREFIX = ["Rust", "Void", "Ash", "Iron", "Crimson", "Grim", "Pale", "Black"];
const BOUNTY_SUFFIX = ["Reaver", "Corsair", "Marauder", "Wraith", "Fang", "Talon", "Drifter", "Jackal"];

/** Build a tier-scaled NPC enemy profile. Hull is purely tier-derived (so a
 * higher-tier bounty always has ≥ hull — the monotonic-in-tier contract); the
 * weapon emphasis + defenses carry small deterministic variety from the rng. */
function bountyEnemy(rng: () => number, tier: number): ShipCombatStats {
  const hullMax = BOUNTY_BASE_HULL * tier;
  const power = 6 + tier * 4; // total weapon budget, rising with tier
  // Pick a dominant firing profile for variety.
  const profile = pick(rng, ["burst", "sustained", "missile"] as const);
  const weapons: WeaponDamage = { burst: 0, sustained: 0, missile: 0 };
  weapons[profile] = power;
  // A little spillover into a second profile so fights aren't one-note.
  const second = pick(rng, ["burst", "sustained", "missile"] as const);
  weapons[second] += Math.round(power * 0.3);
  return {
    hullMax,
    shield: randInt(rng, 0, 4) * tier,
    evade: randInt(rng, 0, 5) * tier,
    jam: randInt(rng, 0, 3) * tier,
    lock: 4 + randInt(rng, 0, 4) * tier,
    weapons,
  };
}

/**
 * The PvE bounties on offer at `hubKey` for `timeBucket`, optionally scaled to
 * the player's `rankTier` with the hub faction. PURE & deterministic: a bounded
 * set keyed by `(seed, hubKey, bucket)` — the enemy mix + slots are rank-
 * independent (rank only scales the reward, monotonically), so the board's
 * identity is stable within a bucket and distinct across buckets (`key`
 * embeds the bucket). Rewards are a premium scaled to tier. Mirrors
 * `contractsAt`; no `Date` / `Math.random` (bucket + rank are passed in).
 */
export function bountiesAt(
  seed: string,
  hubKey: string,
  timeBucket: number,
  rankTier: number = 0,
): Bounty[] {
  const factionId = factionAt(seed, hubKey);
  const rng = makeRng(seed, "bounty", hubKey, timeBucket);
  const count = randInt(rng, BOUNTIES_MIN, BOUNTIES_MAX);
  const rankScale = 1 + Math.max(0, rankTier) * BOUNTY_RANK_REWARD_PER_TIER;
  const bounties: Bounty[] = [];
  for (let slot = 0; slot < count; slot++) {
    const tier = randInt(rng, 1, MAX_BOUNTY_TIER);
    const name = `${pick(rng, BOUNTY_PREFIX)} ${pick(rng, BOUNTY_SUFFIX)}`;
    const enemy = bountyEnemy(rng, tier);
    const rewardCredits = Math.round(BOUNTY_REWARD_PER_TIER * tier * rankScale);
    const rewardRep = Math.max(1, Math.round(rewardCredits / 300));
    bounties.push({
      key: `${hubKey}|${timeBucket}|${slot}`,
      name,
      tier,
      factionId,
      enemy,
      rewardCredits,
      rewardRep,
    });
  }
  return bounties;
}

// Re-export the loadout-stat helpers from their catalogs so combat-side code can
// import everything ship-combat from one module if it prefers.
export { shipHull } from "./ships";
export type { WeaponProfile };
