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
}

export type RenderSpan = TextSpan | ActionSpan;

/** One line of output — an ordered list of spans rendered inline. */
export type RenderLine = RenderSpan[];

/**
 * A unit of terminal output appended to the scrollback. The result of one
 * command (or the boot banner) is one frame.
 */
export interface RenderFrame {
  lines: RenderLine[];
}
