"use client";

/**
 * <LoginScreen> — the gate shown to unauthenticated visitors.
 *
 * Styled to match the terminal aesthetic (monospace, dark, term-* colors).
 * Takes an email, sends a Supabase magic link via the browser auth client,
 * and shows a "check your email" confirmation. When Supabase is unconfigured
 * (`configured={false}`) it renders an informative state instead of a form,
 * so the app still boots with no secrets set.
 */
import { useState } from "react";
import { getAuthBrowserClient } from "@/lib/supabase/auth-client";
import { cn } from "@/lib/utils";

type Status = "idle" | "sending" | "sent" | "error";

export function LoginScreen({
  configured = true,
  authError = false,
}: {
  configured?: boolean;
  authError?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;

    setStatus("sending");
    setMessage("");
    try {
      const supabase = getAuthBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: addr,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to send link.");
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
              <span className="text-term-fg">.env.example</span>) to enable
              magic-link login.
            </p>
          </div>
        ) : status === "sent" ? (
          <div className="mt-6 space-y-2" aria-live="polite">
            <p className="text-term-success">→ transmission sent.</p>
            <p className="text-term-muted">
              Check <span className="text-term-fg">{email.trim()}</span> for a magic
              link to board your ship. You can close this tab.
            </p>
            <button
              type="button"
              onClick={() => {
                setStatus("idle");
                setMessage("");
              }}
              className="text-term-link underline decoration-dotted underline-offset-2 hover:bg-term-accent/20 focus:outline-none"
            >
              use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-3" aria-live="polite">
            {authError && (
              <p className="text-term-danger">
                that sign-in link was invalid or expired — request a new one.
              </p>
            )}
            <label
              htmlFor="email"
              className="block select-none text-term-muted"
            >
              identify yourself — enter your email:
            </label>
            <div className="flex items-center gap-2 border-b border-term-muted/30 pb-1">
              <span className="select-none text-term-accent" aria-hidden>
                &gt;
              </span>
              <input
                id="email"
                type="email"
                required
                autoFocus
                spellCheck={false}
                autoComplete="email"
                autoCapitalize="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={status === "sending"}
                placeholder="pilot@example.com"
                className="flex-1 bg-transparent text-term-fg caret-term-accent placeholder:text-term-muted focus:outline-none disabled:opacity-60"
              />
            </div>
            {status === "error" && (
              <p className="text-term-danger">✗ {message}</p>
            )}
            <button
              type="submit"
              disabled={status === "sending"}
              className={cn(
                "rounded-sm border border-term-accent/40 px-3 py-1 text-term-accent",
                "hover:bg-term-accent/20 focus:bg-term-accent/20 focus:outline-none",
                "disabled:opacity-60",
              )}
            >
              {status === "sending" ? "sending…" : "send magic link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
