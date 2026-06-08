import "server-only";

/**
 * Server Supabase client (service-role key).
 *
 * AUTHORITATIVE. Bypasses RLS — this is how the command pipeline mutates
 * game state after validating against the rules. NEVER import this from a
 * client component, and never expose the service-role key to the browser
 * (the `server-only` import above turns an accidental client import into a
 * build error).
 *
 * Lazy + memoized: no env access at import time, so `next build` and CI
 * succeed without secrets; throws only when actually invoked unconfigured.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getServerClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase server client is not configured. Set NEXT_PUBLIC_SUPABASE_URL " +
        "and SUPABASE_SERVICE_ROLE_KEY (see .env.example).",
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
