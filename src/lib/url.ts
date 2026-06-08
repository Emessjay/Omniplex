import type { NextRequest } from "next/server";

/**
 * Derive the public-facing origin from forwarded headers so redirects work
 * correctly behind Railway's reverse proxy, which binds internally on
 * http://localhost:8080 while the public URL is https://<host>.
 */
export function publicOrigin(request: NextRequest): string {
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    new URL(request.url).protocol.replace(/:$/, "");
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    new URL(request.url).host;
  return `${proto}://${host}`;
}
