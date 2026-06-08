/**
 * Session refresh for the App Router middleware.
 *
 * Supabase access tokens are short-lived; `updateSession` runs on every
 * matched request, calls `getUser()` to refresh the session when needed, and
 * writes any rotated cookies onto the outgoing response so server components
 * downstream read a fresh, validated session. When Supabase is unconfigured
 * it is a no-op pass-through (keeps the app booting without secrets).
 *
 * IMPORTANT (per Supabase SSR guidance): do not run logic between creating
 * the client and `getUser()`, and always return the `supabaseResponse` object
 * as-is so the refreshed cookies survive.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicConfig } from "./config";

export async function updateSession(
  request: NextRequest,
): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const config = getSupabasePublicConfig();
  if (!config) return supabaseResponse;

  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[],
      ) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();

  return supabaseResponse;
}
