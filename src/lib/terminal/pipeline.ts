/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  COMMAND PIPELINE SEAM                                                 │
 * │                                                                       │
 * │  `submitCommand` is the single attach point between the <Terminal>    │
 * │  client and the server-authoritative game. It is a thin wrapper that  │
 * │  forwards the raw input string to the `runCommand` server action,     │
 * │  which resolves the authed player and runs the command against the    │
 * │  rules + DB. The client never sends player state — only the string.   │
 * │                                                                       │
 * │  Signature is load-bearing: keep `(input: string) =>                  │
 * │  Promise<RenderFrame>` exactly — the <Terminal> component depends on  │
 * │  it. `clear` is handled client-side in Terminal.tsx, not here.        │
 * └─────────────────────────────────────────────────────────────────────┘
 */
import type { RenderFrame } from "./types";
import { runCommand } from "@/app/actions/runCommand";

/**
 * Submit a command string (typed or from a clicked action span) and get back
 * the render frame to append to the scrollback. Delegates entirely to the
 * server action — there is no client-side game logic.
 */
export async function submitCommand(input: string): Promise<RenderFrame> {
  return runCommand(input);
}
