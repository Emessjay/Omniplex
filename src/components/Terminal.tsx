"use client";

/**
 * <Terminal> — a custom DOM-based terminal renderer (intentionally NOT
 * xterm.js, so output spans can be real clickable elements).
 *
 * Responsibilities:
 *   - Maintain a scrollback of RenderLines and append new frames.
 *   - Render text spans styled by intent and action spans as clickable
 *     buttons that submit their command string.
 *   - Provide a command input with history (↑/↓) and tab-completion (Tab).
 *
 * It is deliberately thin: it knows nothing about game rules. All output
 * comes from `submitCommand` (the pipeline seam) and all completion from
 * `completeCommand`. Swap those out to attach the real server pipeline; the
 * component does not change.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RenderFrame,
  RenderLine,
  RenderSpan,
  SpanStyle,
} from "@/lib/terminal/types";
import { action, frame, line, text } from "@/lib/terminal/helpers";
import { submitCommand } from "@/lib/terminal/pipeline";
import { completeCommand } from "@/lib/terminal/completion";
import type { Player } from "@/lib/players/types";
import { cn } from "@/lib/utils";

/** Intent → color class. COLOR ONLY (theme-parity rule); no geometry here. */
const STYLE_CLASS: Record<SpanStyle, string> = {
  default: "text-term-fg",
  muted: "text-term-muted",
  accent: "text-term-accent",
  link: "text-term-link",
  success: "text-term-success",
  warning: "text-term-warning",
  danger: "text-term-danger",
  heading: "text-term-heading font-semibold",
};

/**
 * The boot banner shown before any command runs. When a `player` is provided
 * (the authenticated case) it greets them by handle and reports their
 * starting location and credits/fuel; otherwise it falls back to the generic
 * scaffold banner.
 */
function bootFrame(player?: Player): RenderFrame {
  if (player) {
    return frame([
      line(text("OMNIPLEX // terminal interface", "heading")),
      line(text("a procedurally-generated sci-fi universe, rendered as text", "muted")),
      line(text("")),
      line([
        text("welcome aboard, ", "muted"),
        text(player.handle, "accent"),
        text(".", "muted"),
      ]),
      line([
        text("location: ", "muted"),
        text(
          `sector ${player.sector} · system ${player.system} · planet ${player.planet}`,
          "default",
        ),
        text("  (starting system)", "muted"),
      ]),
      line([
        text("credits: ", "muted"),
        text(String(player.credits), "success"),
        text("   fuel: ", "muted"),
        text(String(player.fuel), "success"),
        text("   cargo cap: ", "muted"),
        text(String(player.cargoCap), "default"),
      ]),
      line(text("")),
      line([
        text("gameplay not wired yet. Type ", "muted"),
        action("help", "help", { title: "list commands" }),
        text(" or click it to begin.", "muted"),
      ]),
      line(text("")),
    ]);
  }

  return frame([
    line(text("OMNIPLEX // terminal interface", "heading")),
    line(text("a procedurally-generated sci-fi universe, rendered as text", "muted")),
    line(text("")),
    line([
      text("scaffold build — gameplay not wired yet. Type ", "muted"),
      action("help", "help", { title: "list commands" }),
      text(" or click it to begin.", "muted"),
    ]),
    line(text("")),
  ]);
}

/** Render one span: plain text, or a clickable action button. */
function Span({
  span,
  onAction,
}: {
  span: RenderSpan;
  onAction: (command: string) => void;
}) {
  if (span.kind === "action") {
    return (
      <button
        type="button"
        title={span.title}
        onClick={() => onAction(span.command)}
        className={cn(
          "underline decoration-dotted underline-offset-2",
          "rounded-sm hover:bg-term-accent/20 focus:bg-term-accent/20 focus:outline-none",
          STYLE_CLASS[span.style ?? "link"],
        )}
      >
        {span.text}
      </button>
    );
  }
  return <span className={STYLE_CLASS[span.style ?? "default"]}>{span.text}</span>;
}

export function Terminal({ player }: { player?: Player } = {}) {
  const [lines, setLines] = useState<RenderLine[]>(() => bootFrame(player).lines);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  // null = "editing a fresh line"; otherwise an index into `history`.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const append = (f: RenderFrame) => setLines((prev) => [...prev, ...f.lines]);

  // Keep the newest output in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function run(raw: string) {
    const cmd = raw.trim();
    if (!cmd) return;

    setHistory((prev) => [...prev, cmd]);
    setHistoryIndex(null);

    // `clear` is a client-side meta-command (it manipulates the scrollback,
    // which the server pipeline has no concept of). Everything else flows
    // through the seam.
    if (cmd.toLowerCase() === "clear") {
      setLines([]);
      return;
    }

    setBusy(true);
    try {
      const f = await submitCommand(cmd);
      append(f);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function navHistory(direction: -1 | 1) {
    if (history.length === 0) return;
    // Treat the "fresh line" as index === history.length.
    const current = historyIndex ?? history.length;
    let next = current + direction;
    if (next < 0) next = 0;
    if (next >= history.length) {
      setHistoryIndex(null);
      setInput("");
      return;
    }
    setHistoryIndex(next);
    setInput(history[next] ?? "");
  }

  function complete() {
    const matches = completeCommand(input);
    if (matches.length === 1) {
      // Unambiguous: fill it in and add a trailing space for arguments.
      setInput(`${matches[0]} `);
    } else if (matches.length > 1) {
      // Ambiguous: list the candidates as clickable tokens.
      append(
        frame([
          line([
            text("completions: ", "muted"),
            ...matches.flatMap((m, i) => [
              action(m, m, { title: `run "${m}"` }),
              text(i === matches.length - 1 ? "" : "  ", "muted"),
            ]),
          ]),
        ]),
      );
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        navHistory(-1);
        break;
      case "ArrowDown":
        e.preventDefault();
        navHistory(1);
        break;
      case "Tab":
        e.preventDefault();
        complete();
        break;
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = input;
    setInput("");
    void run(value);
  }

  const rendered = useMemo(
    () =>
      lines.map((l, i) => (
        // Lines are append-only and never reordered, so index keys are safe.
        <div key={i} className="min-h-[1.25rem] whitespace-pre-wrap break-words leading-snug">
          {l.length === 0 ? (
            " "
          ) : (
            l.map((span, j) => <Span key={j} span={span} onAction={(c) => void run(c)} />)
          )}
        </div>
      )),
    // `run` is stable enough for this scaffold; recompute on new lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines],
  );

  return (
    <div
      className="mx-auto flex h-[calc(100vh-1rem)] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-term-muted/30 bg-term-bg text-sm sm:h-[calc(100vh-2rem)]"
      onClick={() => inputRef.current?.focus()}
    >
      {/* Scrollback */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2" aria-live="polite">
        {rendered}
      </div>

      {/* Input line */}
      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-term-muted/30 px-3 py-2"
      >
        <span className="select-none text-term-accent" aria-hidden>
          &gt;
        </span>
        <input
          ref={inputRef}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="command input"
          disabled={busy}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 bg-transparent text-term-fg caret-term-accent placeholder:text-term-muted focus:outline-none disabled:opacity-60"
          placeholder={busy ? "…" : "type a command — try 'help'"}
        />
      </form>
    </div>
  );
}
