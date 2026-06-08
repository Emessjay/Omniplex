# Omniplex — Claude project notes

Omniplex is a browser-based, text-interface sci-fi MMO: a single shared,
procedurally-generated universe (think No Man's Sky rendered as a
terminal) where players explore savage planets, harvest rare resources,
build production and businesses, research, climb NPC empires, and hunt
bounties. Deployed on Railway; all state lives in Supabase (Postgres +
Auth + Realtime).

## Auditor system

The agent role handbooks (`AUDITOR.md`, `WORKER.md`, `DEBUGGER.md`,
`LIGHTWEIGHT.md`, `CRITIC.md`) live in the **Nimbus orchestration
repo** — the same checkout this agent was booted from. Read Nimbus's
`CLAUDE.md` (resolvable via `$NIMBUS_HOME/CLAUDE.md`, or by following
the path that booted you) for the auditor-system orientation — it
links each role handbook and spells out the conventions agents follow.

If you were booted by `omniplex-audit` (env `OMNIPLEX_ROLE=auditor`),
you are the supervisor and a PreToolUse hook will block you from editing
source code. If you were booted by `omniplex-worker` inside an
`Omniplex-<slug>/` worktree, you are a worker and report status via
`./scripts/worker-done.sh` and `./scripts/worker-blocked.sh`. The Nimbus
handbooks are written for a generic "home repo" — this repo (Omniplex)
is the home repo; project-specific hygiene lives in the rest of this
file. Either way, the rest of this file still applies.

## Stack (authoritative — do not drift without an auditor decision)

- **Framework:** Next.js (App Router) + React + TypeScript.
- **UI:** A custom DOM-based terminal renderer (NOT xterm) so output
  can contain clickable links/actions. Hybrid input: a command line
  with history + tab-completion, plus clickable nouns/actions in the
  rendered output. Tailwind for the terminal skin (monospace,
  scanline/CRT aesthetic optional). Dark-first; theme parity rules from
  AUDITOR.md still apply.
- **Game logic:** Server-authoritative. The client is a thin terminal
  renderer; it sends a command string (or a structured action from a
  click) to a server action / API route. The server validates against
  game rules + current DB state, mutates Postgres, and returns the new
  render payload. Never trust the client for resource/credit math.
- **Persistence / Auth / Realtime:** Supabase. Server writes use the
  service-role key (authoritative); client uses the anon key for reads
  and Realtime subscriptions only. RLS on every table.
- **Procedural universe:** Deterministic, seed-based. Static planet
  attributes (biome, atmosphere, gravity, hazard, resource table) are
  derived from `hash(WORLD_SEED, coords)` and never stored. Only
  *mutable* state — resource depletion, claims, structures,
  discoveries — is persisted as rows keyed by a canonical location key.
  This keeps the universe effectively infinite without storing every
  planet. Generation lives in pure, unit-testable functions.
- **Tests:** Vitest for pure logic (procedural gen + game rules are the
  bulk and are highly testable). Playwright may come later for UI.

## Test command

The Nimbus debugger gate (`debugger-approve.sh`) and critic gate
(`spawn-critic.sh`) both read `.nimbus-test-command` at this repo's
root — a single-line file containing the command that runs the full
project test suite. Created by the `scaffold` worker; value is
`npx vitest run`. Pairs require a test suite and both gates refuse to
proceed without the command declared. See Nimbus's `AUDITOR.md`
§"Specs and tests" for test-suite authoring conventions.

## Worktree-per-feature

Workers run in concurrent sibling worktrees (`Omniplex-<slug>/`). To
avoid port / Supabase-project / data collisions between simultaneously
running instances, launch the app via `scripts/dev-instance.sh` (created
by the `scaffold` worker) rather than `npm run dev` directly. The script
allocates a per-instance HTTP port and an isolated Supabase schema/local
stack so parallel worktrees don't fight. `dev-instance.sh --fresh`
resets to a clean state for critic rounds (wired into
`.nimbus-critic-preamble`).

## Critic freshness preamble

`.nimbus-critic-preamble` runs `./scripts/dev-instance.sh --fresh`
before each critic round to defeat stale build/data artefacts. Created
by the `scaffold` worker. See Nimbus's `AUDITOR.md` §"Critic review".

## Conventions

Project-specific conventions (file layout, naming, schema patterns,
gotchas) accrete here as workers surface things worth persisting. See
`DESIGN.md` for the product shape, MVP scope, and architecture sketch.
