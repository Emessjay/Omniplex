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
  StatusBar,
} from "@/lib/terminal/types";
import type { PresenceHint } from "@/lib/game/presence";
import { action, actionStyle, frame, line, text } from "@/lib/terminal/helpers";
import { submitCommand } from "@/lib/terminal/pipeline";
import { completeCommand } from "@/lib/terminal/completion";
import { presenceRoster } from "@/lib/game/presence";
import { getBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
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
          `galaxy ${player.galaxy} · arm ${player.arm} · cluster ${player.cluster} · system ${player.system} · planet ${player.planet}`,
          "default",
        ),
        text("  (starting system)", "muted"),
      ]),
      line([
        text("credits: ", "muted"),
        text(String(player.credits), "success"),
        text("   fuel: ", "muted"),
        text(String(player.fuel), "success"),
        text("   warp fuel: ", "muted"),
        text(String(player.warpFuel), "success"),
        text("   cargo cap: ", "muted"),
        text(String(player.cargoCap), "default"),
      ]),
      line(text("")),
      line([
        text("New here? Type ", "muted"),
        action("guide", "guide", { title: "get your next step" }),
        text(" for your next step, or ", "muted"),
        action("help", "help", { title: "list commands" }),
        text(" for the full command list.", "muted"),
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

/**
 * A best-effort initial HUD snapshot derived purely from the `player` prop, so
 * the header is present on first paint before any command runs. The client has
 * no access to the procedural universe (the seed/gen are server-side), so the
 * location is a coordinate label and the ship is the raw id; the first response
 * frame's `status` (built server-side by `buildStatusBar`) replaces both with
 * the friendly names. Preferred over nothing — and the server-rendered page
 * passes a fully-resolved `initialStatus` when it can.
 */
function statusFromPlayer(player?: Player): StatusBar | undefined {
  if (!player) return undefined;
  return {
    credits: player.credits,
    location: `system ${player.system} · planet ${player.planet}`,
    fuel: player.fuel,
    warpFuel: player.warpFuel,
    health: player.health,
    maxHealth: 100,
    ship: player.shipId,
    condition: player.shipCondition ?? 100,
  };
}

/**
 * The persistent status header — always visible above the scrolling log,
 * surviving `clear` and scrolling (it's separate state). Color-only styling via
 * the shared palette (theme-parity rule); HP turns red when low (P9b palette).
 */
function StatusHeader({ status }: { status?: StatusBar }) {
  if (!status) return null;
  const lowHealth = status.health <= status.maxHealth * 0.3;
  // Ship hull condition (Combat-2): red when damaged below half (P9b color-only).
  const lowCondition = status.condition < 50;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-muted/30 px-3 py-1.5 text-xs"
      aria-label="status"
    >
      <span>
        <span className={STYLE_CLASS.muted}>◈ </span>
        <span className={STYLE_CLASS.success}>{status.credits.toLocaleString()}cr</span>
      </span>
      <span className={STYLE_CLASS.muted}>·</span>
      <span className={STYLE_CLASS.accent}>{status.location}</span>
      <span className={STYLE_CLASS.muted}>·</span>
      <span>
        <span className={STYLE_CLASS.muted}>HP </span>
        <span className={lowHealth ? STYLE_CLASS.danger : STYLE_CLASS.default}>
          {status.health}/{status.maxHealth}
        </span>
      </span>
      <span className={STYLE_CLASS.muted}>·</span>
      <span>
        <span className={STYLE_CLASS.muted}>fuel </span>
        <span className={STYLE_CLASS.default}>{status.fuel}</span>
        <span className={STYLE_CLASS.muted}> / warp </span>
        <span className={STYLE_CLASS.default}>{status.warpFuel}</span>
      </span>
      <span className={STYLE_CLASS.muted}>·</span>
      <span>
        <span className={STYLE_CLASS.default}>{status.ship}</span>
        <span className={STYLE_CLASS.muted}> hull </span>
        <span className={lowCondition ? STYLE_CLASS.danger : STYLE_CLASS.default}>
          {status.condition}%
        </span>
      </span>
      {status.heat ? (
        <>
          <span className={STYLE_CLASS.muted}>·</span>
          <span className={STYLE_CLASS.danger}>{status.heat}</span>
        </>
      ) : null}
    </div>
  );
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
    // A `disabled` action stays clickable (the click yields the command's
    // normal error) but is colored red (`danger`) to signal up-front that it
    // can't be performed right now — this overrides any `style`. Color-only,
    // so theme parity holds (no geometry change vs. a performable action).
    const colorClass = STYLE_CLASS[actionStyle(span)];
    return (
      <button
        type="button"
        title={span.title}
        onClick={() => onAction(span.command)}
        className={cn(
          "underline decoration-dotted underline-offset-2",
          "rounded-sm hover:bg-term-accent/20 focus:bg-term-accent/20 focus:outline-none",
          colorClass,
        )}
      >
        {span.text}
      </button>
    );
  }
  return <span className={STYLE_CLASS[span.style ?? "default"]}>{span.text}</span>;
}

export function Terminal({
  player,
  initialStatus,
}: { player?: Player; initialStatus?: StatusBar } = {}) {
  const [lines, setLines] = useState<RenderLine[]>(() => bootFrame(player).lines);
  // The persistent status header — kept SEPARATE from the scrolling log so the
  // `clear` meta-command (which empties `lines`) never wipes it. Seeded so the
  // header is present on first paint, before any command (AC#2).
  const [status, setStatus] = useState<StatusBar | undefined>(
    () => initialStatus ?? statusFromPlayer(player),
  );
  // The latest live-presence hint the server stamped on a frame (3b): which
  // Realtime channel to be on + our public-safe self to track. Kept as state so
  // a movement (which changes the channel) re-runs the subscription effect.
  const [presence, setPresence] = useState<PresenceHint | undefined>(undefined);
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

  // Live presence + local chat (foundation 3b). The server tells us which
  // Realtime channel to be on via `frame.presence`; we (re)subscribe whenever
  // the channel changes (i.e. the player moved), tearing down the old one.
  // Live arrive/leave/chat lines are appended as ordinary log lines — they
  // interleave with command output and never touch the persistent status bar.
  // SSR-safe: runs only in this client effect, guarded by config; getBrowserClient
  // is wrapped so a missing/partial config can never crash the renderer.
  useEffect(() => {
    if (!presence || !isSupabaseConfigured()) return;
    const { channel, self } = presence;

    let client;
    try {
      client = getBrowserClient();
    } catch {
      return; // unconfigured at runtime — no live presence, no crash.
    }

    const appendLine = (l: RenderLine) => setLines((prev) => [...prev, l]);

    const ch = client.channel(channel, {
      config: { presence: { key: self.handle }, broadcast: { self: false } },
    });

    ch.on("presence", { event: "sync" }, () => {
      const roster = presenceRoster(
        ch.presenceState() as Record<string, unknown>,
        self.handle,
      );
      if (roster.length > 0) {
        appendLine([
          text("Here now: ", "muted"),
          text(roster.map((r) => r.handle).join(", "), "accent"),
        ]);
      }
    });

    ch.on("presence", { event: "join" }, ({ newPresences }) => {
      for (const p of (newPresences ?? []) as Array<Record<string, unknown>>) {
        const handle = typeof p.handle === "string" ? p.handle : null;
        if (!handle || handle === self.handle) continue;
        const ship = typeof p.ship === "string" ? p.ship : "ship";
        const state = typeof p.state === "string" ? p.state : "nearby";
        appendLine([text(`→ ${handle} (${ship}, ${state}) arrived.`, "success")]);
      }
    });

    ch.on("presence", { event: "leave" }, ({ leftPresences }) => {
      for (const p of (leftPresences ?? []) as Array<Record<string, unknown>>) {
        const handle = typeof p.handle === "string" ? p.handle : null;
        if (!handle || handle === self.handle) continue;
        appendLine([text(`← ${handle} left.`, "muted")]);
      }
    });

    ch.on("broadcast", { event: "chat" }, ({ payload }) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const handle = typeof p.handle === "string" ? p.handle : null;
      const body = typeof p.body === "string" ? p.body : null;
      if (!handle || !body) return;
      appendLine([text(`${handle}: `, "accent"), text(body, "default")]);
    });

    // Live duels (Combat-3): the server pushes pre-rendered round frames over
    // this same co-location channel — opening notices, round results + "your
    // move" prompts (with clickable `engage <choice>` actions), committed/fled/
    // forfeit notices, and the final outcome. The client stays a THIN renderer:
    // it appends the server's `RenderLine`s verbatim (the action spans wire to
    // `run`, so the choice buttons submit `engage <choice>` like any other) — it
    // never resolves combat. Defensive on the (uncontrolled) payload shape.
    ch.on("broadcast", { event: "duel" }, ({ payload }) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const lines = Array.isArray(p.lines) ? (p.lines as RenderLine[]) : [];
      for (const l of lines) {
        if (Array.isArray(l)) appendLine(l);
      }
    });

    ch.subscribe((s) => {
      if (s === "SUBSCRIBED") void ch.track(self);
    });

    return () => {
      void ch.untrack();
      void client.removeChannel(ch);
    };
    // Re-subscribe only when the channel or our tracked identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence?.channel, presence?.self.handle]);

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
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    try {
      const f = await submitCommand(cmd);
      append(f);
      // Refresh the persistent header from the post-command snapshot the server
      // attached (additive — frames without `status` leave the header as-is).
      if (f.status) setStatus(f.status);
      // Update the live-presence channel (3b): additive; absent (unconfigured)
      // leaves any existing subscription as-is.
      if (f.presence) setPresence(f.presence);
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
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a, input, textarea, [role='button']"))
          inputRef.current?.focus();
      }}
    >
      {/* Persistent status header — separate state, survives `clear`. */}
      <StatusHeader status={status} />

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
