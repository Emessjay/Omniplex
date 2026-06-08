/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  COMMAND PIPELINE SEAM                                                 │
 * │                                                                       │
 * │  This is the single attach point where the real server-authoritative │
 * │  command pipeline plugs in. Today it is a CLIENT-SIDE STUB that just  │
 * │  echoes input — there is no gameplay yet.                             │
 * │                                                                       │
 * │  When the `command-core` / auth workers land, replace the body of    │
 * │  `submitCommand` with a call to a server action / route, e.g.        │
 * │                                                                       │
 * │      'use server'                                                     │
 * │      export async function runCommand(playerId, input): RenderFrame  │
 * │                                                                       │
 * │  …and have this function POST `input` (plus the authed player) to it. │
 * │  Keep the signature `(input: string) => Promise<RenderFrame>` stable: │
 * │  the <Terminal> component depends on exactly this shape.             │
 * └─────────────────────────────────────────────────────────────────────┘
 */
import type { RenderFrame } from "./types";
import { action, frame, line, text } from "./helpers";
import { COMMANDS } from "./completion";

/**
 * Submit a command string and get back a render frame to append to the
 * scrollback. STUB IMPLEMENTATION — echoes input and special-cases `help`
 * so the clickable-action mechanism is demonstrable. No game state.
 */
export async function submitCommand(input: string): Promise<RenderFrame> {
  const cmd = input.trim();

  if (cmd.toLowerCase() === "help") {
    return frame([
      line(text("Available commands (scaffold stub — no gameplay yet):", "heading")),
      // Each command is a clickable action token; clicking submits it.
      line([
        text("  ", "muted"),
        ...COMMANDS.flatMap((c, i) => [
          action(c, c, { title: `run "${c}"` }),
          text(i === COMMANDS.length - 1 ? "" : "  ", "muted"),
        ]),
      ]),
      line(text("Type a command and press Enter, or click one above.", "muted")),
    ]);
  }

  // Default: echo the input back, prefixed like a shell.
  return frame([line([text("> ", "muted"), text(cmd, "default")])]);
}
