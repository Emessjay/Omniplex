# Omniplex — Design & Scope

## Goal

Omniplex is a browser-based, text-interface sci-fi MMO: one shared,
procedurally-generated universe rendered as a terminal. Players explore
procedurally-generated planets (savage worlds hold rare resources),
harvest and produce, build businesses, research and invent, climb the
ranks of NPC empires, and hunt bounties. The long-term vision is
"No Man's Sky as a persistent text game" at large scale. We build it
incrementally: a solid, infinitely-extensible foundation first, then one
gameplay vertical at a time.

## Resolved decisions (locked)

- **Interface:** Hybrid terminal — a command line (history +
  tab-completion) plus clickable nouns/actions in rendered output.
- **First milestone (MVP):** Exploration + resources — the procedural
  universe is the seed every other vertical grows from.
- **Multiplayer:** One shared persistent async world in Postgres.
  Players see each other's lasting effects (depletion, claims, market
  prices, discovery/leaderboards), not live moment-to-moment presence.
- **Deploy/Storage:** Railway + Supabase (Postgres + Auth + Realtime).

## MVP scope (the first "done")

The smallest version worth calling playable — a satisfying core loop in
a shared world:

1. **Account + identity.** Supabase auth (email or magic link). Each
   user has one player with a handle, credits, a ship, and a current
   location.
2. **Procedural universe.** Deterministic galaxy → sector → system →
   planet, generated from a world seed + coordinates. Planets have
   biome, atmosphere, gravity, a hazard level, and a resource table.
   "Savage" planets (high hazard) carry the rarest resources.
3. **Terminal client.** Custom terminal renderer; hybrid input.
   Core commands: `look`/`scan`, `map`, `warp <dest>`, `mine
   <resource>`, `inventory`, `sell <resource>`, `buy fuel`, `who`,
   `help`. Clickable equivalents in output.
4. **Exploration loop.** Scan current planet → see resources/hazard →
   mine (costs fuel/energy, yields resources, writes a depletion delta)
   → warp to a new system (fuel cost) → discover new planets
   (first-discoverer gets a recorded credit) → return to a market and
   sell → buy fuel/upgrades → repeat.
5. **Shared-world effects.** Resource depletion, planet discoveries
   (first-to-find), and market prices are global and persisted; a
   discovery leaderboard and a "who's online / richest" board exist.

A player can log in, explore several procedurally-generated systems,
mine and sell rare resources, and see that the world remembers what
they and others did.

## Out of scope (v1)

Deferred — architecture should leave clean seams (e.g. generic
`structures`, a `factions` stub) but NO gameplay for these yet:

- Production chains, farming, refining pipelines.
- Businesses / companies / capitalism systems.
- Research / invention / tech tree.
- NPC empires & politics (rank progression).
- Bounty hunting & combat (ship-to-ship or surface).
- Live realtime presence, chat, ship piloting in real time.

## Architecture sketch

- **Frontend:** Next.js (App Router) + React + TS. A `<Terminal>`
  component renders a scrollback of server-produced "render frames"
  (styled text + clickable action tokens) and an input line with
  history + tab-completion. No game logic client-side.
- **Command pipeline:** client → server action `runCommand(playerId,
  input)` → parse → validate against rules + DB state → mutate Postgres
  (service role) → return a render frame. Pure parser + pure rule
  functions, thin DB adapter. This is the anti-cheat boundary.
- **Procedural gen:** `universe/` module of pure functions.
  `planetAt(seed, coords)` → deterministic planet descriptor via a
  seeded hash PRNG. Sectors/systems addressed by integer coords; warp
  moves between adjacent systems with a fuel cost scaling with distance.
  Nothing about an unvisited planet is stored — it's recomputable.
- **Mutable state (Postgres):**
  - `players` (id, user_id→auth, handle, credits, fuel, cargo_cap,
    location {sector,system,planet}, created_at)
  - `inventory` (player_id, resource_id, qty)
  - `resources` (catalog: id, name, rarity, base_value) — static seed
  - `world_deltas` (location_key, kind, payload jsonb) — depletion,
    claims, etc., keyed by canonical location key
  - `discoveries` (planet_key, player_id, discovered_at) — first-find
  - `markets` (location_key | global, resource_id, price) — MVP may use
    one global market that drifts with supply
  - RLS: players read their own rows + public world/leaderboard rows;
    all writes go through the server (service role).
- **Realtime (light use in MVP):** subscribe to leaderboard / market /
  "who's online" updates so boards feel live without per-tick sync.
- **Testing:** Vitest. Procedural determinism (same seed+coords ⇒ same
  planet), rule math (mining yield, fuel cost, market pricing), and
  command parsing are the high-value unit targets.

## Open questions

All architecture-blocking questions were resolved with the user (see
"Resolved decisions"). Remaining choices (auth method specifics, exact
resource catalog, market pricing curve, CRT styling degree) are
worker/auditor-level and do not block the foundation. The first such
decision — auth via magic link vs email+password — defaults to Supabase
magic-link for MVP simplicity unless the scaffold worker finds a reason
otherwise.

## Build order (auditor's plan)

1. `repo-seed` (lightweight): `.gitignore` + initial commit so worktrees
   work.
2. `scaffold` (worker): Next.js+TS+Tailwind app, Supabase client/server
   wiring, `<Terminal>` shell that echoes input, Vitest, Supabase schema
   migration for the MVP tables above, `scripts/dev-instance.sh`,
   `.nimbus-test-command`, `.nimbus-critic-preamble`, Railway config.
   Gate before all parallel feature work.
3. Parallel feature wave (after scaffold merges):
   - `universe-gen` (pair): pure procedural generation + tests.
   - `command-core` (pair): command pipeline + parser + render frames.
   - `auth-player` (worker): Supabase auth + player bootstrap.
   These touch mostly disjoint modules; sequence any that collide on
   shared types. Mining/market/warp wire together once gen + commands
   land.
