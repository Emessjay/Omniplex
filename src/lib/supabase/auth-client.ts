/**
 * Browser auth client (anon key, cookie-synced via `@supabase/ssr`).
 *
 * Used only by the login screen to send a magic link. It writes session
 * cookies in a format the server (`auth-server.ts`) can read, so a successful
 * login is visible to server components. Like the other clients it is lazy +
 * memoized and never touches env at import time; it throws only if called
 * while Supabase is unconfigured.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "./config";

let cached: SupabaseClient | null = null;

export function getAuthBrowserClient(): SupabaseClient {
  if (cached) return cached;

  const config = getSupabasePublicConfig();
  if (!config) {
    throw new Error(
      "Supabase auth client is not configured. Set NEXT_PUBLIC_SUPABASE_URL " +
        "and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).",
    );
  }

  cached = createBrowserClient(config.url, config.anonKey);
  return cached;
}
