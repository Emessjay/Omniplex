"use client";

/**
 * <LoginScreen> — the gate shown to unauthenticated visitors.
 *
 * Styled to match the terminal aesthetic (monospace, dark, term-* colors).
 * Sign-in is via Google OAuth (or the dev-login bypass when enabled).
 * Magic-link email is removed from the UI but the backend /auth/callback
 * route remains so it can be re-added later.
 */
import { useState } from "react";
import { getAuthBrowserClient } from "@/lib/supabase/auth-client";
import { cn } from "@/lib/utils";

export function LoginScreen({
  configured = true,
  authError = false,
  devLoginAvailable = false,
}: {
  configured?: boolean;
  authError?: boolean;
  /**
   * When true, render a "dev login" shortcut that bypasses the email round-trip
   * (gated server-side by `OMNIPLEX_DEV_LOGIN`; see `src/lib/devAuth.ts`). Only
   * a boolean crosses to the client — never the flag itself.
   */
  devLoginAvailable?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function onGoogle() {
    setSending(true);
    setError("");
    try {
      const supabase = getAuthBrowserClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (oauthError) throw oauthError;
      // Success kicks off a full-page redirect to Google; nothing more to do.
    } catch (err) {
      setSending(false);
      setError(err instanceof Error ? err.message : "Failed to start Google sign-in.");
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-1rem)] w-full max-w-xl flex-col items-center justify-center px-4 sm:h-[calc(100vh-2rem)]">
      <div className="w-full rounded-md border border-term-muted/30 bg-term-bg p-6 text-sm">
        <h1 className="text-term-heading font-semibold">
          OMNIPLEX // access terminal
        </h1>
        <p className="mt-1 text-term-muted">
          a procedurally-generated sci-fi universe, rendered as text
        </p>

        {!configured ? (
          <div className="mt-6 space-y-2">
            <p className="text-term-warning">authentication is not configured.</p>
            <p className="text-term-muted">
              Set <span className="text-term-fg">NEXT_PUBLIC_SUPABASE_URL</span> and{" "}
              <span className="text-term-fg">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> (see{" "}
              <span className="text-term-fg">.env.example</span>) to enable login.
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-3" aria-live="polite">
            {authError && (
              <p className="text-term-danger">
                that sign-in link was invalid or expired — try signing in again.
              </p>
            )}
            {error && (
              <p className="text-term-danger">✗ {error}</p>
            )}
            <button
              type="button"
              onClick={onGoogle}
              disabled={sending}
              className={cn(
                "w-full rounded-sm border border-term-muted/40 px-3 py-1 text-term-fg",
                "hover:bg-term-accent/20 focus:bg-term-accent/20 focus:outline-none",
                "disabled:opacity-60",
              )}
            >
              {sending ? "connecting…" : "continue with Google"}
            </button>
          </div>
        )}

        {configured && devLoginAvailable && (
          <div className="mt-6 border-t border-term-muted/20 pt-3">
            <a
              href="/auth/dev"
              className="text-term-link underline decoration-dotted underline-offset-2 hover:bg-term-accent/20 focus:bg-term-accent/20 focus:outline-none"
            >
              → dev login (skip email)
            </a>
            <p className="mt-1 text-xs text-term-warning">
              testing only — disabled in production
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
