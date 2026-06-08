/**
 * Builders + small pure utilities for the render-frame model.
 *
 * Server-side frame producers (command pipeline, scan/market views) should
 * compose frames with these helpers rather than writing object literals, so
 * the shape stays consistent and easy to refactor. All functions here are
 * pure and unit-tested.
 */
import type {
  ActionSpan,
  RenderFrame,
  RenderLine,
  RenderSpan,
  SpanStyle,
  TextSpan,
} from "./types";

/** A plain styled-text span. */
export function text(value: string, style?: SpanStyle): TextSpan {
  return style ? { kind: "text", text: value, style } : { kind: "text", text: value };
}

/**
 * A clickable action span carrying the command submitted on click. Pass
 * `disabled: true` to mark an action the player can't currently perform — the
 * renderer colors it red (`danger`) instead of blue (`link`) while keeping it
 * clickable (the click yields the command's normal error). The flag is optional
 * and absent by default, so existing call sites are unchanged.
 */
export function action(
  label: string,
  command: string,
  opts: { style?: SpanStyle; title?: string; disabled?: boolean } = {},
): ActionSpan {
  const span: ActionSpan = { kind: "action", text: label, command };
  if (opts.style) span.style = opts.style;
  if (opts.title) span.title = opts.title;
  if (opts.disabled) span.disabled = true;
  return span;
}

/**
 * The effective SpanStyle the renderer should color an action span with. A
 * `disabled` action is forced to `danger` (red) — signalling "can't do this
 * right now" — overriding any declared `style`; otherwise the span's own style
 * applies, defaulting to `link` (blue). Pure, so the renderer's color choice is
 * unit-testable without mounting the React component.
 */
export function actionStyle(span: ActionSpan): SpanStyle {
  if (span.disabled) return "danger";
  return span.style ?? "link";
}

/** A line from spans (or a single span). */
export function line(spans: RenderSpan | RenderSpan[]): RenderLine {
  return Array.isArray(spans) ? spans : [spans];
}

/** A frame from lines. */
export function frame(lines: RenderLine[]): RenderFrame {
  return { lines };
}

/** Convenience: a frame of plain-text lines, one string per line. */
export function textFrame(lines: string[], style?: SpanStyle): RenderFrame {
  return frame(lines.map((l) => line(text(l, style))));
}

/** Flatten a line to its visible text (ignoring styling/interactivity). */
export function lineToText(l: RenderLine): string {
  return l.map((span) => span.text).join("");
}

/** Flatten a whole frame to plain text, one line per entry. */
export function frameToText(f: RenderFrame): string[] {
  return f.lines.map(lineToText);
}
