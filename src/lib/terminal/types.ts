/**
 * Render-frame model — the wire format between the server command pipeline
 * and the <Terminal> client renderer.
 *
 * LOAD-BEARING: multiple downstream workers produce `RenderFrame`s
 * server-side (the command pipeline, universe scan output, market views,
 * etc.) and the Terminal component is the sole consumer. Treat this module
 * as a stable contract — extend it additively; do not reshape the existing
 * fields without an auditor decision.
 *
 * A frame is a list of lines. A line is a list of spans. A span is either
 * plain styled text or a clickable action token that, when clicked, submits
 * a command string back through the same pipeline that produced the frame.
 * This is what makes the terminal "hybrid": typed commands and clicked
 * actions are the same thing — a command string.
 */
import type { PresenceHint } from "@/lib/game/presence";

/**
 * Semantic style hint for a span. Maps to a COLOR class in the renderer —
 * never to geometry, so themes stay parity-safe. Add new intents here
 * rather than passing raw class names through the wire format.
 */
export type SpanStyle =
  | "default"
  | "muted"
  | "accent"
  | "link"
  | "success"
  | "warning"
  | "danger"
  | "heading";

/** A run of non-interactive styled text. */
export interface TextSpan {
  kind: "text";
  text: string;
  style?: SpanStyle;
}

/**
 * A clickable token. The visible label is `text`; clicking it submits
 * `command` through `submitCommand` exactly as if the player had typed it.
 */
export interface ActionSpan {
  kind: "action";
  /** Visible label, e.g. "warp Kepler-7". */
  text: string;
  /** Command string submitted on click, e.g. "warp 3 12 4". */
  command: string;
  style?: SpanStyle;
  /** Optional tooltip / hover hint. */
  title?: string;
  /**
   * Marks an action the player CANNOT currently perform (can't afford, out of
   * stock, wrong embark state, missing landing gear, …). The renderer styles a
   * disabled action with the `danger` (red) color instead of the usual `link`
   * (blue), overriding `style`. It stays clickable — clicking just yields the
   * command's normal "you can't do that" error frame, which is informative.
   * Set by the emitting handler using the SAME check that gates the command,
   * so red ⇔ the command would reject it. Default undefined/false = performable.
   */
  disabled?: boolean;
}

export type RenderSpan = TextSpan | ActionSpan;

/** One line of output — an ordered list of spans rendered inline. */
export type RenderLine = RenderSpan[];

/**
 * A persistent HUD snapshot — the key player vitals shown in the terminal's
 * always-visible status header (money + location so the player is never lost,
 * even after `clear`). A fixed sensible set this phase; custom "pin what you
 * want" is a noted v2. Built server-side by `buildStatusBar(player, seed)` and
 * attached to the outgoing frame; the client keeps the latest one as its own
 * state, separate from the scrolling log (so `clear` doesn't wipe it).
 */
export interface StatusBar {
  /** Credits balance. */
  credits: number;
  /** Friendly, human-readable location label (e.g. "Kepler-7 · Aris III"). */
  location: string;
  /** Regular fuel (planet-to-planet `land`/`orbit`/`launch`). */
  fuel: number;
  /** Warp fuel (system-and-larger `warp` jumps). */
  warpFuel: number;
  /** Current hit points. */
  health: number;
  /** Maximum hit points (so the client can render `n/max` and a low-HP color). */
  maxHealth: number;
  /** Current ship's display name. */
  ship: string;
}

/**
 * A unit of terminal output appended to the scrollback. The result of one
 * command (or the boot banner) is one frame.
 *
 * `status` is ADDITIVE (per the "extend RenderFrame additively" rule): frames
 * without it render unchanged. When present, it carries the post-command HUD
 * snapshot so the persistent status header can update. `submitCommand`'s
 * `(input: string) => Promise<RenderFrame>` signature is unaffected.
 *
 * `presence` is ADDITIVE in the same way (foundation 3b): when present it names
 * the Supabase Realtime channel the client should be subscribed to for the
 * player's current location (live co-located arrive/leave + `say` chat), plus
 * the player's own public-safe view to track. Absent when Supabase is
 * unconfigured; frames without it leave the live subscription unchanged. The
 * type is imported from the pure `game/presence` module (type-only — no runtime
 * dependency from the wire format into game logic).
 */
export interface RenderFrame {
  lines: RenderLine[];
  /** Optional post-command HUD snapshot for the persistent status header. */
  status?: StatusBar;
  /** Optional live-presence hint (Realtime channel + public-safe self) — 3b. */
  presence?: PresenceHint;
}
