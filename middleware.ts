import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Refresh the Supabase session on every page/route request so server
 * components see a fresh, validated user. See `lib/supabase/middleware.ts`.
 */
export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Run on everything except Next internals and static assets. The auth
  // callback is intentionally included so the exchanged session cookie is
  // refreshed on the redirect.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
