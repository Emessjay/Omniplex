import "server-only";

/**
 * One-player-per-user bootstrap.
 *
 * `getOrCreatePlayer(userId, email)` returns the caller's `players` row,
 * creating it on first login. AUTHORITATIVE — it writes via the service-role
 * client (`getServerClient()`), per the server-authoritative principle; the
 * browser anon client is never used to mutate game state.
 *
 * Idempotent: the `players.user_id` unique constraint guarantees a second
 * call for the same user can never create a second row. If two requests race
 * the bootstrap, the loser's insert hits the unique violation and we re-read
 * the winner's row instead of erroring.
 */
import { getServerClient } from "@/lib/supabase/server";
import { rowToPlayer } from "./mapping";
import { deriveHandleBase, uniqueHandle } from "./handle";
import type { Player, PlayerRow } from "./types";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";
/** Bound on handle-collision retries before giving up. */
const MAX_HANDLE_ATTEMPTS = 25;

export async function getOrCreatePlayer(
  userId: string,
  email: string,
): Promise<Player> {
  const db = getServerClient();

  // Fast path: the player already exists.
  const existing = await findByUserId(userId);
  if (existing) return existing;

  const base = deriveHandleBase(email);

  // Insert, retrying on handle collisions. New players take the DB column
  // defaults (1000 credits, 100 fuel, 50 cargo_cap, location 0/0/0).
  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
    const taken = await fetchTakenHandles();
    const handle = uniqueHandle(base, taken);

    const { data, error } = await db
      .from("players")
      .insert({ user_id: userId, handle })
      .select("*")
      .single();

    if (!error && data) return rowToPlayer(data as PlayerRow);

    if (error?.code === UNIQUE_VIOLATION) {
      // Either another request created this user's row (user_id unique) or
      // someone grabbed the handle between our read and write. Re-checking
      // user_id first means a concurrent bootstrap resolves to one row.
      const raced = await findByUserId(userId);
      if (raced) return raced;
      // Otherwise it was a handle race — loop and pick the next free handle.
      continue;
    }

    if (error) throw error;
  }

  throw new Error(
    `Could not allocate a unique handle for "${base}" after ${MAX_HANDLE_ATTEMPTS} attempts.`,
  );

  async function findByUserId(uid: string): Promise<Player | null> {
    const { data, error } = await db
      .from("players")
      .select("*")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToPlayer(data as PlayerRow) : null;
  }

  async function fetchTakenHandles(): Promise<string[]> {
    const { data, error } = await db.from("players").select("handle");
    if (error) throw error;
    return (data ?? []).map((r) => (r as { handle: string }).handle);
  }
}
