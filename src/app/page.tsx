import { Terminal } from "@/components/Terminal";
import { LoginScreen } from "@/components/LoginScreen";
import { logout } from "@/app/auth/actions";
import { getSessionClient } from "@/lib/supabase/auth-server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getOrCreatePlayer } from "@/lib/players/getOrCreatePlayer";
import { isDevLoginEnabled } from "@/lib/devAuth";
import { buildStatusBar } from "@/lib/game/commands";
import { getWorldSeed } from "@/lib/game/seed";

/**
 * Auth-gated entry point. Resolved entirely server-side so the terminal never
 * flashes to logged-out visitors:
 *   - Supabase unconfigured → "not configured" login state.
 *   - no validated user     → magic-link login screen.
 *   - authenticated         → bootstrap the player and render the terminal.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>;
}) {
  const { auth_error } = await searchParams;

  if (!isSupabaseConfigured()) {
    return (
      <main className="crt flex min-h-screen w-full flex-col bg-term-bg p-2 sm:p-4">
        <LoginScreen configured={false} />
      </main>
    );
  }

  const supabase = await getSessionClient();
  // `getUser()` re-validates the token with the auth server (don't trust the
  // unverified cookie session for gating).
  const {
    data: { user },
  } = (await supabase!.auth.getUser());

  if (!user) {
    return (
      <main className="crt flex min-h-screen w-full flex-col bg-term-bg p-2 sm:p-4">
        <LoginScreen
          authError={auth_error === "1"}
          devLoginAvailable={isDevLoginEnabled()}
        />
      </main>
    );
  }

  const player = await getOrCreatePlayer(user.id, user.email ?? "");
  // Resolve the HUD snapshot server-side (it needs the procedural universe) so
  // the persistent header shows real names on first paint, before any command.
  const initialStatus = buildStatusBar(player, getWorldSeed());

  return (
    <main className="crt flex min-h-screen w-full flex-col bg-term-bg p-2 sm:p-4">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-1 pb-2 text-xs">
        <span className="text-term-muted">
          signed in as <span className="text-term-accent">{player.handle}</span>
        </span>
        <form action={logout}>
          <button
            type="submit"
            className="text-term-link underline decoration-dotted underline-offset-2 hover:bg-term-accent/20 focus:bg-term-accent/20 focus:outline-none"
          >
            log out
          </button>
        </form>
      </div>
      <Terminal player={player} initialStatus={initialStatus} />
    </main>
  );
}
