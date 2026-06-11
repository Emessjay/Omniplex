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
 * each command), no live push / chat / combat — those build on this in 3b.
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
