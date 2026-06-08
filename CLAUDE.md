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

### Load-bearing decisions from `scaffold`

- **Render-frame model** lives in `src/lib/terminal/types.ts`
  (`RenderFrame = { lines: RenderLine[] }`; a `RenderLine` is an array of
  `RenderSpan`s; a span is a `TextSpan` or a clickable `ActionSpan` whose
  `command` string is submitted on click). This is the client⇄server wire
  format — extend it **additively**; do not reshape existing fields without
  an auditor decision. Build frames with the pure helpers in
  `src/lib/terminal/helpers.ts` (`text`, `action`, `line`, `frame`,
  `textFrame`, plus `lineToText`/`frameToText`).
- **Span styling is color-only.** `SpanStyle` maps to a color class in the
  renderer (`STYLE_CLASS` in `Terminal.tsx`); never encode geometry in a
  style (theme-parity rule). Add new intents to the `SpanStyle` union.
- **Command-pipeline seam**: `submitCommand(input: string): Promise<RenderFrame>`
  in `src/lib/terminal/pipeline.ts` is the single attach point for the real
  server pipeline (today a client-side echo stub). Keep that exact signature;
  `<Terminal>` depends on it. Tab-completion source is
  `completeCommand(partial) => string[]` in `completion.ts`. `clear` is a
  client-side meta-command handled in `Terminal.tsx`, not via the seam.
- **Supabase clients**: `getServerClient()` (service-role, authoritative,
  `import "server-only"`) in `src/lib/supabase/server.ts`;
  `getBrowserClient()` (anon, RLS-scoped reads + Realtime) in
  `src/lib/supabase/client.ts`. Both are **lazy + memoized** — never touch
  env at import time (so `npm run build` / CI work without secrets); they
  throw only when called unconfigured.
- **Migrations** live in `supabase/migrations/`, named
  `<UTC YYYYMMDDHHMMSS>_<slug>.sql`, forward-only — add new files, never edit
  landed ones. RLS is enabled on every table: public read for
  world/catalog/leaderboard rows, per-player read for own rows, and **no**
  anon/authenticated write policies (all writes go through the service role,
  which bypasses RLS). Public leaderboard data is exposed via the
  `public.leaderboard` view (no `user_id`), not by loosening `players` RLS.
- **Path alias**: `@/*` → `src/*` (mirrored in `tsconfig.json` and
  `vitest.config.ts`). Tests are `src/**/*.{test,spec}.ts(x)`, run with
  `npx vitest run`.

### Load-bearing decisions from `universe-gen`

- **Procedural universe** lives in `src/lib/universe/` (public API in
  `index.ts`). It is **pure & deterministic** — `systemAt(seed, coord)` and
  `planetAt(seed, coord)` are functions of their args only; same inputs ⇒
  byte-identical output, nothing stored. Never add I/O, `Date`, or
  `Math.random` to this module.
- **PRNG**: cyrb128 + sfc32 (`src/lib/universe/prng.ts`), seeded via
  `makeRng(seed, ...parts)`. Deterministic across JS engines; no deps.
- **Coordinates**: `SystemCoord { sector, system }`, `PlanetCoord
  { sector, system, planet }` — integers matching the `players` table.
- **Location keys** are colon-delimited: `systemKey` → `"<sector>:<system>"`,
  `planetKey` → `"<sector>:<system>:<planet>"`; `parseLocationKey` round-trips
  both. These are the `location_key` values for `world_deltas` / `discoveries`
  / `markets` rows.
- **`Planet`** = `{ coord, name, biome, atmosphere, gravity (0,10],
  hazard [0,1], temperature °C, deposits: {resourceId, abundance[0,1]}[] }`.
  **`StarSystem`** = `{ coord, name, starClass (O/B/A/F/G/K/M), planetCount
  [1,MAX_PLANETS], planets[] }`. Enums exported as `BIOMES`/`ATMOSPHERES`/
  `STAR_CLASSES`.
- **Resource catalog** (`resources.ts`, `RESOURCES`/`getResource`) is the
  gen-side source of truth and MUST stay in lock-step with the SQL seed
  (7 ids, rarity 1–5). `getResource` throws on unknown ids.
- **Rarity coupling**: hazard → rarity. High-hazard "savage" planets carry
  rarity-4/5 (iridium/xenon/voidstone); voidstone is savage-gated.
- **`warpDistance(a, b)`** is the deterministic system-to-system metric
  (0 to self, symmetric, positive between distinct). Fuel-cost scaling off
  it is `command-core`'s job.

### Load-bearing decisions from `auth-player`

- **Auth** is Supabase magic-link via `@supabase/ssr` (cookie sessions).
  Session-aware clients live in `src/lib/supabase/auth-server.ts`
  (`getSessionClient()`), `auth-client.ts`, `middleware.ts`, gated by
  `isSupabaseConfigured()` in `config.ts`. These are SEPARATE from the
  game-state clients (`getServerClient`/`getBrowserClient`): auth clients
  manage the user session, game clients manage game data. `middleware.ts`
  (repo root) refreshes the session per request.
- **Gating**: `src/app/page.tsx` resolves auth server-side and re-validates
  with `supabase.auth.getUser()` (never trust the raw cookie session for
  gating). Unconfigured → "not configured" login; no user → `LoginScreen`;
  authed → bootstrap player + render `<Terminal player={player} />`.
- **Player identity**: `getOrCreatePlayer(userId, email)` in
  `src/lib/players/` (service-role, `server-only`, idempotent via the
  `players.user_id` unique constraint + `23505` retry). New players take DB
  defaults (1000 credits, 100 fuel, 50 cargo, location `0/0/0` = starting
  system). `Player` type (`src/lib/players/types.ts`) is camelCase mapping
  the snake_case columns via `rowToPlayer`. **`command-core` imports
  `Player` and reads the current player server-side to run commands.**
- **Terminal greeting**: `<Terminal>` takes an optional `player` prop and
  shows a personalized boot banner. The `submitCommand` seam and
  `RenderFrame` types are unchanged — still the single attach point.

### Load-bearing decisions from `deploy-harden`

- **Migration runner**: `scripts/db-migrate.sh` applies every
  `supabase/migrations/*.sql` in filename order to the DB named by
  `DATABASE_URL` (Supabase → Project Settings → Database), via `psql` (no
  Supabase CLI dependency). It tracks applied files in
  `public.schema_migrations` (created at runtime with `if not exists`, NOT a
  landed migration) and applies each file + its tracking insert in one
  transaction, so a failed migration rolls back and is retried. Idempotent;
  safe to re-run. `--dry-run` previews.
- **Health check**: `GET /api/health` (`src/app/api/health/route.ts`) ALWAYS
  returns HTTP 200 with `{ status, supabase: "configured"|"unconfigured",
  missingEnv }` — never 500, never leaks secret values (names only). Wired
  into `railway.json` as `healthcheckPath`. Uses `force-dynamic` so env is
  read per-request.
- **Runtime env validation**: `src/lib/env.ts` — `REQUIRED_SERVER_ENV` is the
  canonical required-vars list (`NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WORLD_SEED`).
  `checkServerEnv()` is pure/non-throwing (used by the health route);
  `assertServerEnv()` throws on a real request path only. NEVER call these at
  import/build time — the build/test-without-secrets invariant must hold.
- **Node pinned to 22** via `engines.node` (`package.json`) + `.node-version`
  / `.nvmrc` for reproducible Nixpacks builds.
- **Deploy runbook** is [`DEPLOY.md`](DEPLOY.md) (linked from `README.md`);
  it owns the Railway + Supabase setup, including the Supabase Auth redirect
  allowlist gotcha for magic-link login.

### Load-bearing decisions from `dev-login`

- **Dev login** is an env-gated bypass of the magic-link email round-trip for
  solo testing — ⚠️ MUST stay OFF in production. The flag helper is
  `src/lib/devAuth.ts` (`isDevLoginEnabled(env?)` / `devLoginEmail(env?)`,
  pure + unit-tested). Gated on **server-only** env `OMNIPLEX_DEV_LOGIN`
  (truthy = on; unset/`0`/`false`/`off`/`no` = off) — NEVER `NEXT_PUBLIC_*`.
  Optional `OMNIPLEX_DEV_LOGIN_EMAIL` (default `dev@omniplex.local`). Neither
  is in `REQUIRED_SERVER_ENV`.
- **Entry point**: `GET /auth/dev` (`src/app/auth/dev/route.ts`,
  `force-dynamic`). Flag off ⇒ returns 404 and performs no auth (impossible to
  trigger by hitting the URL). Flag on ⇒ ensures the dev user via service-role
  `auth.admin.createUser({ email_confirm: true })` (idempotent), mints a token
  via `auth.admin.generateLink({ type: 'magiclink' })`, then redeems it through
  the cookie-bound session client's `verifyOtp` — a GENUINE `@supabase/ssr`
  session, identical to the real flow (`getUser()`/RLS/`getOrCreatePlayer` all
  work). No faked cookies; service-role key never reaches the client.
- **UI**: `LoginScreen` takes a `devLoginAvailable` boolean (only that boolean
  crosses to the client, never the flag); `page.tsx` passes
  `isDevLoginEnabled()`. The real magic-link flow is unchanged.

### Load-bearing decisions from `command-abbrev`

- **Prefix abbreviation** lets players type a unique *prefix* of a command verb
  or of an enumerable argument: `mi t` → `mine titanium`, `sc` → `scan`,
  `sel a` → `sell all`. Resolution is **server-authoritative** (the pipeline
  already knows the valid sets) and happens before dispatch.
- **Pure core** is `src/lib/game/resolve.ts` (no IO; the dispatcher supplies
  candidate sets from state). Two functions:
  - `resolveToken(fragment, candidates) → TokenResolution` — exact match wins
    outright (even when it also prefixes another candidate); else a single
    prefix match resolves; >1 ⇒ `{ok:false, reason:"ambiguous", matches}` (sorted);
    0 ⇒ `{ok:false, reason:"none"}`. Case-insensitive; returns canonical spelling.
  - `resolveCommandLine(input, spec) → LineResolution` — parses via
    `parseCommand`, resolves the verb against `spec.verbs`, then each arg via
    `spec.argDomain(verb, argIndex, priorArgs)`. Returns `{ok:true, verb, args,
    canonical}` or `{ok:false, error}` (human-readable, names candidates on
    ambiguity). Blank input ⇒ the empty verb (dispatcher no-op).
- **`argDomain` contract**: return the candidate `string[]` for a *resolvable*
  argument position, or **`null`** for an **opaque** position (free-form /
  numeric — passed through verbatim, never prefix-matched). Ambiguity / no-match
  **never silently picks one** — it always surfaces the choice as an error.
- **Resolvable positions today** (wired in `commands.ts` `dispatch`): `mine`
  arg 0 = resource ids with non-depleted deposits on the current planet; `sell`
  arg 0 = inventory resource ids + the literal `all`; `buy` arg 0 = `["fuel"]`.
  `warp`/`land` args (and `buy`'s quantity) are **opaque**. New verticals plug
  their arg domains into the same `argDomain` switch.
- **Verb vocabulary** is the `VERBS` array in `commands.ts` (canonical verbs +
  the `look` alias; `inv` is omitted since it resolves as a prefix of
  `inventory`). `dispatch` resolves the line, renders `error` as an error frame
  on failure, otherwise dispatches the canonical verb/args via
  `dispatchResolved` and prepends a muted `» <canonical>` echo line whenever
  abbreviation expanded the typed input (so players learn the full form).

### Load-bearing decisions from `google-auth`

- **Google sign-in** is additive: `LoginScreen` shows a "Continue with Google"
  button (when `configured`) alongside the magic-link form, calling
  `signInWithOAuth({ provider: "google", options: { redirectTo:
  ${window.location.origin}/auth/callback } })` via the shared
  `getAuthBrowserClient()`. OAuth errors surface inline like magic-link send
  errors. PKCE OAuth returns to the **same** `/auth/callback` route (it
  already exchanges the `code` for a session — never was magic-link-specific),
  so player bootstrap (`getOrCreatePlayer`) and the `publicOrigin` redirect
  fix are shared unchanged. **Provider creds (Google Client ID/secret) live in
  Supabase → Authentication → Providers → Google, NOT in app env** — there are
  no new app env vars. Setup runbook in `DEPLOY.md` §3a.
