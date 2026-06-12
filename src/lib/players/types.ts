/**
 * Player identity + ship + location.
 *
 * LOAD-BEARING: this is the canonical TS shape of a `players` row, consumed
 * by the auth bootstrap (`getOrCreatePlayer`) and — downstream — by the
 * `command-core` pipeline, which needs the current player server-side to run
 * commands. Keep it clean: camelCase TS fields mapping 1:1 to the snake_case
 * columns in `supabase/migrations/*_init.sql`. Extend additively.
 */

import type { Species } from "@/lib/universe";
import type { ShipCombatStats, Range } from "@/lib/game/combat";

/** A player row, mapped to camelCase. Mirrors `public.players`. */
export interface Player {
  /** Primary key (uuid). */
  id: string;
  /** Owning auth user (uuid → auth.users.id). Unique: one player per user. */
  userId: string;
  /** Unique display handle, derived from the email local-part on bootstrap. */
  handle: string;
  /** Credits balance (DB `bigint`; safe-integer range in practice). */
  credits: number;
  /** Regular ship fuel — burned moving between planets within a system (`land`). */
  fuel: number;
  /** Warp fuel — burned on system-and-larger `warp` jumps (scales with distance). */
  warpFuel: number;
  /** Cargo capacity. DERIVED from the current ship (`getShip(shipId).cargoCap`);
   * buying a ship sets this from its catalog cargoCap, so this stays the single
   * value every cargo-space check reads. */
  cargoCap: number;
  /**
   * The ship the player currently flies — a `ships.ts` catalog id (defaults to
   * the starter `STARTER_SHIP_ID`). The SOURCE of `cargoCap`: a ship swap
   * (`buyship`) sets both this and `cargoCap` together.
   */
  shipId: string;
  /**
   * Manifold — the top coordinate tier (a PURE DATA PARTITION above `galaxy`).
   * 0 = prime universe (prod); −1 = the isolated test universe. Set at spawn from
   * `OMNIPLEX_SPAWN_MANIFOLD` and NEVER changed by travel — a player is confined
   * to their manifold, which is the test-isolation guarantee. See
   * `SystemCoord.manifold`.
   */
  manifold: number;
  /**
   * Current location — the six-tier coordinate
   * (`galaxy → arm → cluster → system → planet → region`). `(0,0,0,0,0,0)` is
   * the start location. `galaxy` is unbounded; `arm` is canonical in
   * `[0, galaxyAt(galaxy).armCount)`.
   */
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  planet: number;
  /** Current region index within the planet; in `[0, planet.regionCount)`. */
  region: number;
  /**
   * Current hit points, in `[0, MAX_HEALTH]` (100). Reaching 0 triggers the
   * death sequence (see `commands.ts`), which restores it to full.
   */
  health: number;
  /**
   * Survival state: `true` = aboard ship, `false` = on foot in the current
   * region. Combines with `landed` into the three-state per-planet machine:
   * Orbiting (`embarked && !landed`), Landed (`embarked && landed`), On-foot
   * (`!embarked`, which always implies `landed`). See `applicability.ts`.
   */
  embarked: boolean;
  /**
   * Surface state (orbit-land): `true` = on the planet's surface (landed aboard,
   * or disembarked on foot), `false` = up in orbit. Orbiting burns DISTANCE fuel
   * (`orbit`); descent (`land`) is free; the atmosphere climb is billed on
   * `launch`. INVARIANT: `!embarked ⇒ landed` (you can't be on foot in orbit).
   * New players spawn Orbiting (landed=false); warp/hyperwarp arrive Orbiting.
   */
  landed: boolean;
  /**
   * Active-combat state: `null` when not fighting, otherwise the generated
   * creature you're facing (its `Species` genome blob) and its remaining HP. Set
   * on a fauna encounter while exploring; cleared on kill / flee / death.
   */
  encounter: PlayerEncounter | null;
  /**
   * Worlds CHARTED — the count of planets this player was the first to discover
   * (Keystone 3b). Incremented exactly once per planet inside the first-discovery
   * gate (the same gate that pays `DISCOVERY_BOUNTY`); maps purely to a
   * cartography rank/title (`cartography.ts`). Starts at 0 (no backfill).
   */
  charted: number;
  /**
   * The FITTED ship modules (Combat-1a) — an ordered list of `modules.ts` catalog
   * ids in slot order. Length ≤ the current ship's slot count
   * (`shipSlots(shipId)`); an id may repeat if the player owns + fits duplicates.
   * Modules are OWNED in `player_modules`; this is the subset currently fitted.
   * Trimmed on a ship change to a smaller hull (the extras stay owned). Defaults
   * to `[]` (nothing fitted).
   */
  loadout: string[];
  /**
   * Active SHIP-combat session (Combat-1b): `null` when not in a ship fight,
   * otherwise the full `ShipCombat` snapshot (the engaged bounty + both ships'
   * profiles + live hull/shield + phase). Distinct from `encounter` (the on-foot
   * wildlife fight). Persists across reconnects so a fight resumes where it left
   * off; cleared on victory / defeat / a successful `flee`.
   */
  combat: ShipCombat | null;
  /**
   * Notoriety / heat — the SHARED Combat ⇄ Trade axis (pillars §iv + §ii). 0 =
   * clean. Raised by illicit acts (piracy, attacking the unwanted, base raids —
   * Combat-2; smuggling/illicit trade — a later Trade phase) and DECAYS toward 0
   * over time (realized on read off `notorietyUpdatedAt`, see
   * `world.getNotoriety`). Maps purely to a tier/title (`rules.notorietyTier`)
   * that drives the law's response. NOT public (not on the `leaderboard` view).
   */
  notoriety: number;
  /**
   * The decay clock for `notoriety` (ISO timestamp). Heat cools from this
   * timestamp on read; any change re-stamps it (`add_notoriety`). Mirror of
   * `markets.updated_at` — the apply-on-read / stamp-on-write discipline.
   */
  notorietyUpdatedAt: string;
  /** ISO timestamp the row was created. */
  createdAt: string;
}

/**
 * The persisted ship-combat session (`players.combat` jsonb). A superset of the
 * pure resolver's `ShipCombatState` (the core hull/shield/phase fields) plus the
 * bounty identity + pending rewards, so a fight survives a reload and an outcome
 * knows what to pay. Both ships' `ShipCombatStats` are SNAPSHOTTED at engage-
 * start, so a mid-fight refit/ship-change can't drift the stats. No persistent
 * hull damage BETWEEN fights — each engagement starts both sides at full
 * `hullMax`/`shield`.
 */
export interface ShipCombat {
  /** The bounty being hunted — the `completed_bounties` key (no double-collect). */
  bountyKey: string;
  /** Flavor name of the enemy ship/pilot, for the combat log. */
  enemyName: string;
  /** Hub faction that posted the bounty — rep is awarded to it on victory. */
  factionId?: string;
  /** Player ship profile, snapshotted from `loadoutStats` at engage-start. */
  player: ShipCombatStats;
  /** Enemy ship profile (the bounty's tier-scaled NPC). */
  enemy: ShipCombatStats;
  playerHull: number;
  playerShield: number;
  enemyHull: number;
  enemyShield: number;
  /** Current range — `null` until the approach phase resolves. */
  range: Range | null;
  phase: "approach" | "exchange";
  /** Pending next-round subsystem debuffs (fractions in `[0, 1)`). */
  playerWeaponDebuff?: number;
  playerEvadeDebuff?: number;
  enemyWeaponDebuff?: number;
  enemyEvadeDebuff?: number;
  rewardCredits: number;
  rewardRep: number;
}

/**
 * The combat state stored in `players.encounter` (jsonb). Holds the full
 * generated `Species` blob (cascade tier 5b) so the fight survives without
 * re-deriving it from the region, plus the creature's current HP. Reshaped from
 * the old `{ faunaId, hp }` — combat is transient, so no migration is needed
 * (any stale in-flight row simply reads as "the creature is gone").
 */
export interface PlayerEncounter {
  /** The generated creature being faced (its genome species). */
  species: Species;
  /** The creature's current hit points. */
  hp: number;
}

/**
 * Raw `public.players` row as returned by the Supabase client (snake_case).
 * Used internally by the row→Player mapper; not part of the public surface.
 */
export interface PlayerRow {
  id: string;
  user_id: string;
  handle: string;
  credits: number;
  fuel: number;
  warp_fuel: number;
  cargo_cap: number;
  ship_id: string;
  manifold: number;
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  planet: number;
  region: number;
  health: number;
  embarked: boolean;
  landed: boolean;
  encounter: PlayerEncounter | null;
  charted: number;
  /** Fitted module-id list (jsonb array). Defaults to `[]`. */
  loadout: string[] | null;
  /** Active ship-combat session (jsonb). `null` when not in a ship fight. */
  combat: ShipCombat | null;
  /** Heat/notoriety (the shared Combat ⇄ Trade axis); 0 = clean. */
  notoriety: number;
  /** Decay clock for notoriety (timestamptz). */
  notoriety_updated_at: string;
  created_at: string;
}
