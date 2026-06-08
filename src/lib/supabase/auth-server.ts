import "server-only";

/**
 * Cookie-bound Supabase client for the App Router (anon key).
 *
 * This is the AUTH/session client: it reads and writes the Supabase session
 * cookies via Next's `cookies()` store, so server components, route handlers,
 * and server actions all see the same logged-in user. It is RLS-scoped (anon
 * key) — authoritative game writes still go through `getServerClient()`.
 *
 * Returns `null` when Supabase is unconfigured so callers (e.g. `page.tsx`)
 * can render an informative state instead of crashing the build.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "./config";

export async function getSessionClient(): Promise<SupabaseClient | null> {
  const config = getSupabasePublicConfig();
  if (!config) return null;

  const cookieStore = await cookies();

  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[],
      ) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` was called from a Server Component, where cookies are
          // read-only. The middleware (`updateSession`) refreshes the session
          // cookies on every request, so this is safe to ignore here.
        }
      },
    },
  });
}
