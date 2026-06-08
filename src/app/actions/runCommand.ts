"use server";

/**
 * The command pipeline's trust boundary.
 *
 * `runCommand` is the single server action behind the terminal. The client
 * sends ONLY the raw input string — never a playerId, credits, or location.
 * This action resolves the authenticated player itself from the session
 * cookie (re-validated via `getUser()`), bootstraps/loads their row with the
 * service-role client, and dispatches to the authoritative game handlers.
 *
 * It never throws to the client: auth failures and unexpected errors come back
 * as an error `RenderFrame` so the terminal can print them inline.
 */
import { getSessionClient } from "@/lib/supabase/auth-server";
import { getOrCreatePlayer } from "@/lib/players/getOrCreatePlayer";
import { dispatch } from "@/lib/game/commands";
import { errorFrame } from "@/lib/game/render";
import type { RenderFrame } from "@/lib/terminal/types";

export async function runCommand(input: string): Promise<RenderFrame> {
  try {
    const supabase = await getSessionClient();
    if (!supabase) {
      return errorFrame("Game backend is not configured.");
    }

    // Re-validate the token with the auth server — never trust the raw cookie.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return errorFrame("Your session has expired — refresh the page and log in.");
    }

    const player = await getOrCreatePlayer(user.id, user.email ?? "");
    return await dispatch(player, input);
  } catch (err) {
    // Log server-side; surface a generic, safe message to the client.
    console.error("runCommand failed:", err);
    return errorFrame("Something went wrong running that command. Please try again.");
  }
}
