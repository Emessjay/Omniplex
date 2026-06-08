/**
 * Shared Supabase public-config reader.
 *
 * Auth runs through `@supabase/ssr` with the PUBLIC url + anon key (cookie
 * sessions are RLS-scoped; the service-role client stays reserved for
 * authoritative game writes — see `server.ts`). Reading env lazily here keeps
 * the build/CI working with no secrets: callers decide what to do when this
 * returns `null` (the auth UI renders a "not configured" state).
 */

export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

/** The public Supabase config, or `null` if either var is unset. */
export function getSupabasePublicConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** True when both public Supabase vars are present. */
export function isSupabaseConfigured(): boolean {
  return getSupabasePublicConfig() !== null;
}
