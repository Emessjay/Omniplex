import { NextResponse, type NextRequest } from "next/server";
import { isDevLoginEnabled, devLoginEmail } from "@/lib/devAuth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getServerClient } from "@/lib/supabase/server";
import { getSessionClient } from "@/lib/supabase/auth-server";

/**
 * Env-gated DEV LOGIN — bypasses the magic-link email round-trip for solo
 * testing only. See `src/lib/devAuth.ts` and DEPLOY.md for the security model.
 *
 * ⚠️  Inert unless `OMNIPLEX_DEV_LOGIN` is truthy. With the flag off this route
 * returns 404 and performs NO auth — hitting the URL directly does nothing.
 * The flag is read server-side only, so the client can neither probe nor flip
 * it. This MUST be left OFF for any real/public launch.
 *
 * When enabled it produces a GENUINE Supabase session (not a faked cookie):
 *   1. ensure the fixed dev user exists + is email-confirmed (service role,
 *      idempotent);
 *   2. mint a magic-link token for it (service role `auth.admin`);
 *   3. redeem that token through the SAME `@supabase/ssr` cookie path the real
 *      magic-link callback uses (`verifyOtp`), so `getUser()`, RLS and
 *      `getOrCreatePlayer` all behave identically to a real login;
 *   4. redirect to `/`, where the existing bootstrap takes over.
 */

// Read env per-request; never prerender. (Mirrors the magic-link callback.)
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { origin } = new URL(request.url);

  // Hard gate: when the flag is off, this route does not exist.
  if (!isDevLoginEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Dev login still needs Supabase to be configured (it mints a real session).
  if (!isSupabaseConfigured()) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  const email = devLoginEmail();
  const admin = getServerClient();

  // 1. Ensure the dev user exists and is confirmed. Idempotent: a repeat call
  //    hits "already registered", which we treat as success.
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (
    created.error &&
    !/already|registered|exists/i.test(created.error.message)
  ) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  // 2. Mint a magic-link token for the dev user (service role). `generateLink`
  //    does NOT send an email; it returns the token we redeem ourselves.
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  // 3. Redeem it through the cookie-bound session client so `@supabase/ssr`
  //    writes the session cookies exactly as the real flow does.
  const supabase = await getSessionClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (verifyError) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  // 4. Land in the terminal — `page.tsx` re-validates and bootstraps the player.
  return NextResponse.redirect(`${origin}/`);
}
