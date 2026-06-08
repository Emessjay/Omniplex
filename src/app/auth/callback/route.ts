import { NextResponse, type NextRequest } from "next/server";
import { getSessionClient } from "@/lib/supabase/auth-server";
import { publicOrigin } from "@/lib/url";

/**
 * Magic-link callback. Supabase redirects here with a one-time `code`; we
 * exchange it for a session (which `getSessionClient` persists to cookies via
 * the route handler's writable cookie store) and send the player to the app.
 * On any failure we bounce back to the login screen with an error flag.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin = publicOrigin(request);
  const code = searchParams.get("code");
  // Only honor same-origin relative redirects to avoid an open redirect.
  const nextParam = searchParams.get("next");
  const next = nextParam && nextParam.startsWith("/") ? nextParam : "/";

  if (code) {
    const supabase = await getSessionClient();
    if (supabase) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(`${origin}${next}`);
      }
    }
  }

  return NextResponse.redirect(`${origin}/?auth_error=1`);
}
