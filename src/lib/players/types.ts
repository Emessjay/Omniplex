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
  /** Current location — galaxy coordinates. `(0,0,0,0)` is the start system. */
  sector: number;
  system: number;
  planet: number;
  /** Current region index within the planet; in `[0, planet.regionCount)`. */
  region: number;
  /** ISO timestamp the row was created. */
  createdAt: string;
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
  sector: number;
  system: number;
  planet: number;
  region: number;
  created_at: string;
}
