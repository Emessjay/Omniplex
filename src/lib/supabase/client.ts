/**
 * Browser Supabase client (anon key).
 *
 * READ-ONLY / Realtime use only. The anon client is subject to RLS, so it
 * can read the caller's own player rows and public world/leaderboard rows,
 * and subscribe to Realtime — but it must never be trusted for game math.
 * All authoritative writes go through the server (service role).
 *
 * Lazy + memoized: nothing happens at import time, so `next build` and CI
 * work without env vars. It only throws if you actually call it without
 * configuration.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase browser client is not configured. Set NEXT_PUBLIC_SUPABASE_URL " +
        "and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).",
    );
  }

  cached = createClient(url, anonKey);
  return cached;
}
