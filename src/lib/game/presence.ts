/**
 * Shared-world presence (foundation 3a) — co-location + the public-safe view of
 * another player you can SEE because you're in the same place.
 *
 * PURE — no IO, no `server-only` — so the resolver, the renderer, and unit tests
 * can all share it. The impure, service-role co-located QUERY (`playersHere`)
 * lives in `world.ts`; it builds its results through `presentPlayerView` here so
 * the privacy projection is defined in exactly one place.
 *
 * PRIVACY (load-bearing): a presence view exposes ONLY public-safe fields —
 * `handle`, the ship NAME, and the orbit/surface state. It NEVER carries
 * `user_id` or email (the same rule the public `leaderboard` view enforces for
 * `who`/`bases`). This is a phase-3a VISIBILITY layer only: polled (refreshed
 * each command). Foundation 3b layers LIVE push + local chat on top via Supabase
 * Realtime — the pure helpers for that (`presenceChannelFor`/`presenceHintFor`/
 * `sanitizeChatBody`/`presenceRoster`) live here too, keeping all the
 * presence/privacy logic in one pure module. The IMPURE bits (the service-role
 * `broadcastChat` publisher; the client Realtime subscription) live in `world.ts`
 * and `Terminal.tsx` respectively — never here.
 */

import { getShip } from "./ships";

/**
 * The minimal location tuple that decides co-location — the six-tier coordinate
 * `(galaxy, arm, cluster, system, planet, region)`. `Player` is a structural
 * superset, so a `Player` is a valid argument.
 */
export interface LocationView {
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  planet: number;
  region: number;
}

/**
 * Whether two players share the FULL location tuple — i.e. they're in the same
 * place and can see each other. Because the tuple includes `region`, this groups
 * the three "same place" cases uniformly: same-region surface players (matching
 * `region`), same-planet orbiters (`region = 0`), and same-outpost dockers
 * (`region = -1`). Pure; self-exclusion is the caller's job.
 */
export function sameLocation(a: LocationView, b: LocationView): boolean {
  return (
    a.galaxy === b.galaxy &&
    a.arm === b.arm &&
    a.cluster === b.cluster &&
    a.system === b.system &&
    a.planet === b.planet &&
    a.region === b.region
  );
}

/**
 * A co-located player as seen by others — PUBLIC-SAFE only. Deliberately carries
 * no `id`/`user_id`/email: handle is the public identity, ship is its display
 * name, and `state` is the orbit/surface readout.
 */
export interface PresentPlayer {
  /** The other player's public handle. */
  handle: string;
  /** Display name of the ship they're flying (e.g. "Freighter"). */
  ship: string;
  /** Where they are relative to the planet: "in orbit" vs "on the surface". */
  state: string;
}

/**
 * The public-safe SOURCE fields needed to build a `PresentPlayer`. This is the
 * full set of player fields a presence view is allowed to read — note the
 * conspicuous ABSENCE of `id`/`user_id`/email. `world.playersHere` maps a
 * service-role row into this shape (snake_case → camelCase) before calling
 * `presentPlayerView`, so identity columns never reach the view.
 */
export interface PresentPlayerSource {
  handle: string;
  shipId: string;
  embarked: boolean;
  landed: boolean;
}

/**
 * The orbit-land presence state of a player: "on the surface" when landed
 * (landed aboard, or on foot — `!embarked ⇒ landed`), "in orbit" otherwise
 * (orbiting, or docked at the outpost). Pure.
 */
export function presenceState(landed: boolean): string {
  return landed ? "on the surface" : "in orbit";
}

/**
 * Build the public-safe presence view of another player from its source fields.
 * Resolves the ship display name from the code catalog (falling back to the raw
 * id for an unknown ship rather than throwing). NEVER reads or returns
 * identity fields — the returned object is safe to serialize to any client.
 */
export function presentPlayerView(p: PresentPlayerSource): PresentPlayer {
  let ship: string;
  try {
    ship = getShip(p.shipId).name;
  } catch {
    ship = p.shipId; // unknown/legacy ship id: show the id rather than crash
  }
  return {
    handle: p.handle,
    ship,
    state: presenceState(p.landed),
  };
}

// ---------------------------------------------------------------------------
// Foundation 3b — LIVE presence + local chat (Supabase Realtime). The helpers
// below are PURE; the Realtime IO (broadcast publisher, client subscription)
// lives elsewhere and consumes them.
// ---------------------------------------------------------------------------

/**
 * The presence HINT the server stamps on every dispatched render frame: the
 * name of the Realtime channel the client should be subscribed to RIGHT NOW
 * (it changes as the player moves), plus the player's own public-safe view to
 * `track` on that channel. Additive on `RenderFrame` (like `status`); absent
 * when Supabase is unconfigured. `self` is PUBLIC-SAFE — never identity.
 */
export interface PresenceHint {
  /** The co-location Realtime channel name (see `presenceChannelFor`). */
  channel: string;
  /** This player's own public-safe presence view, to `track` on the channel. */
  self: PresentPlayer;
}

/**
 * A deterministic Realtime channel name derived from the FULL six-tier location
 * tuple. Load-bearing invariant: `presenceChannelFor(a) === presenceChannelFor(b)`
 * **iff** `sameLocation(a, b)` — co-location ⇔ same channel, which is exactly
 * what makes "players in the same place" share one live presence room (and hear
 * each other's `say`). Pure; no IO.
 */
export function presenceChannelFor(loc: LocationView): string {
  return `loc:${loc.galaxy}:${loc.arm}:${loc.cluster}:${loc.system}:${loc.planet}:${loc.region}`;
}

/**
 * Build the per-frame presence hint for `player`: the channel for its current
 * location + its own public-safe view (reusing the 3a `presentPlayerView`
 * projection, so the privacy rule is defined in exactly one place — never
 * `user_id`/email). `Player` is a structural superset of the inputs.
 */
export function presenceHintFor(
  player: LocationView & PresentPlayerSource,
): PresenceHint {
  return {
    channel: presenceChannelFor(player),
    self: presentPlayerView({
      handle: player.handle,
      shipId: player.shipId,
      embarked: player.embarked,
      landed: player.landed,
    }),
  };
}

/**
 * Maximum length of a chat message body. Long enough for a real sentence, short
 * enough to keep the local channel readable. Exported so the handler and tests
 * agree on one number.
 */
export const CHAT_MAX_LEN = 240;

/**
 * Clean a raw `say` body for ephemeral broadcast: strip control characters
 * (no newline / multi-line injection), collapse runs of whitespace, trim, and
 * cap at `CHAT_MAX_LEN`. Preserves ordinary text and case. Returns the cleaned
 * string, or `null` for an empty / whitespace-only message (the handler turns
 * `null` into a "say what?" error — no empty broadcasts). Pure.
 */
export function sanitizeChatBody(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // Replace any control char (U+0000–U+001F, U+007F — incl. newlines/tabs) with
  // a space, then collapse whitespace and trim. This guarantees a single-line
  // body with no raw control chars surviving.
  const collapsed = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, CHAT_MAX_LEN);
}

/**
 * Reduce a Supabase Realtime presence-state object into the live roster of
 * OTHER co-located players. The state shape is `{ [presenceKey]: Array<tracked
 * metadata> }` where each metadata entry is (at least) a `PresentPlayer`. We
 * flatten it, exclude self (by matching the tracked `handle` to `selfKey` — we
 * track under our own handle), dedupe by handle, and stable-sort by handle.
 *
 * Pure and DEFENSIVE: tolerates a missing/garbage state, empty arrays, and
 * metadata missing fields (such entries are skipped rather than throwing) — the
 * Realtime payload shape is not under our control.
 */
export function presenceRoster(
  presenceState: Record<string, unknown> | null | undefined,
  selfKey: string,
): PresentPlayer[] {
  const out: PresentPlayer[] = [];
  const seen = new Set<string>();
  if (!presenceState || typeof presenceState !== "object") return out;

  for (const arr of Object.values(presenceState)) {
    if (!Array.isArray(arr)) continue;
    for (const meta of arr) {
      if (!meta || typeof meta !== "object") continue;
      const handle = (meta as { handle?: unknown }).handle;
      if (typeof handle !== "string" || handle.length === 0) continue;
      if (handle === selfKey) continue; // exclude self (tracked under our handle)
      if (seen.has(handle)) continue; // dedupe by handle
      seen.add(handle);
      const ship = (meta as { ship?: unknown }).ship;
      const state = (meta as { state?: unknown }).state;
      out.push({
        handle,
        ship: typeof ship === "string" ? ship : "",
        state: typeof state === "string" ? state : "",
      });
    }
  }
  // Stable, deterministic order by handle.
  out.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return out;
}
