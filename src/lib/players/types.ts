/**
 * Player identity + ship + location.
 *
 * LOAD-BEARING: this is the canonical TS shape of a `players` row, consumed
 * by the auth bootstrap (`getOrCreatePlayer`) and — downstream — by the
 * `command-core` pipeline, which needs the current player server-side to run
 * commands. Keep it clean: camelCase TS fields mapping 1:1 to the snake_case
 * columns in `supabase/migrations/*_init.sql`. Extend additively.
 */

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
   * Active-combat state: `null` when not fighting, otherwise the creature you're
   * facing (`faunaId` indexes the `wildlife.ts` catalog) and its remaining HP.
   * Set on a fauna encounter while exploring; cleared on kill / flee / death.
   */
  encounter: PlayerEncounter | null;
  /**
   * Worlds CHARTED — the count of planets this player was the first to discover
   * (Keystone 3b). Incremented exactly once per planet inside the first-discovery
   * gate (the same gate that pays `DISCOVERY_BOUNTY`); maps purely to a
   * cartography rank/title (`cartography.ts`). Starts at 0 (no backfill).
   */
  charted: number;
  /** ISO timestamp the row was created. */
  createdAt: string;
}

/** The combat state stored in `players.encounter` (jsonb). */
export interface PlayerEncounter {
  /** Id of the creature being faced (key into the `wildlife.ts` FAUNA catalog). */
  faunaId: string;
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
  created_at: string;
}
