import { NextResponse } from "next/server";
import { checkServerEnv } from "@/lib/env";

/**
 * Liveness / readiness probe, wired into `railway.json` as `healthcheckPath`.
 *
 * Contract: ALWAYS returns HTTP 200 with a small JSON body — it must never
 * 500 (a throwing health check would make Railway tear the deploy down even
 * when the process is otherwise healthy). It reports configuration status
 * instead of failing on it, and never echoes any secret VALUE — only whether
 * the required server env vars are present.
 */

// Always evaluate at request time; env presence is a runtime fact, not a
// build-time constant we want baked into a static response.
export const dynamic = "force-dynamic";

// The Supabase-specific subset of the required server env (drives the
// `supabase` summary field; `WORLD_SEED` is required but not a Supabase var).
const SUPABASE_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export function GET() {
  const { missing } = checkServerEnv();
  const supabaseConfigured = !SUPABASE_ENV.some((v) => missing.includes(v));
  return NextResponse.json({
    status: "ok",
    supabase: supabaseConfigured ? "configured" : "unconfigured",
    // Names only — safe to surface; helps diagnose a misconfigured deploy.
    missingEnv: missing,
  });
}
