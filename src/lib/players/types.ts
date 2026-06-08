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
  /** Ship fuel. */
  fuel: number;
  /** Cargo capacity. */
  cargoCap: number;
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
   * Survival state: `true` = aboard ship (trading & ship travel enabled),
   * `false` = on foot in the current region (mining enabled, hazard can wound).
   */
  embarked: boolean;
  /**
   * Active-combat state: `null` when not fighting, otherwise the creature you're
   * facing (`faunaId` indexes the `wildlife.ts` catalog) and its remaining HP.
   * Set on a fauna encounter while exploring; cleared on kill / flee / death.
   */
  encounter: PlayerEncounter | null;
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
  cargo_cap: number;
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  planet: number;
  region: number;
  health: number;
  embarked: boolean;
  encounter: PlayerEncounter | null;
  created_at: string;
}
