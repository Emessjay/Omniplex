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
- **Verb vocabulary** is the `VERBS` array (now in `src/lib/game/usage.ts`;
  canonical verbs + the `look` alias; `inv` is omitted since it resolves as a
  prefix of `inventory`). `dispatch` resolves the line, renders `error` as an error frame
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

### Load-bearing decisions from `living-economy`

- **The shared world heals over time** via two slow, time-based mechanics plus a
  demand-side trade. The discipline is **apply-on-read, persist-on-write**: the
  pure recovery math runs every read off a stored timestamp, but state is only
  rewritten (and the recovery clock reset) on an actual mutation. The pure rule
  functions take **`elapsedMs` as a parameter** and never touch `Date` — the
  impure `world.ts` adapters compute `elapsedMs = Date.now() − timestamp` and
  pass it in (the only place `Date.now()` lives).
- **Tuning constants** (all in `src/lib/game/rules.ts`, documented inline):
  - `REGEN_PER_MS = 1 / 86_400_000` — a fully-drained ~1.0 ore vein regenerates
    over ~24h.
  - `PRICE_REVERT_PER_MS = 5e-6` — a ~100-credit price displacement drifts back
    to `base_value` over ~several hours.
  - `BUY_MARKUP = 1.5` — `buy` pays 150% of the current sell price.
- **Pure fns** (mirror the existing `priceAfterSale`/`effectiveAbundance` style):
  `regeneratedDepletion(totalDepleted, elapsedMs, regenPerMs?)` (clamped to
  `[0, totalDepleted]`, monotonically non-increasing in elapsed),
  `priceTowardBase(price, base, elapsedMs, revertPerMs?)` (moves toward `base`
  without overshooting, floored at `PRICE_FLOOR`), `buyUnitCost(price)` =
  `ceil(price * BUY_MARKUP)`, and `priceAfterPurchase(price, qtyBought)` (the
  buy-side mirror of `priceAfterSale`; see `price-stickiness` below for the
  current volume-based impact model that superseded the old per-unit `MARKET_IMPACT`).
- **Regen on read**: `world.getEffectiveDepletionMap(planetKey)` is the
  regen-aware sibling of `getDepletionMap` — it sums depletion deltas and heals
  each resource by the time since its *most recent* delta, returning the same
  `Record<resourceId, depletion>` shape so `scan`/`mine` feed it straight into
  `effectiveAbundance`. Mining still appends a delta, whose fresh `created_at`
  resets that resource's recovery clock.
- **Drift on read**: `getMarketPrices`/`getMarketPrice` apply
  `priceTowardBase(stored, baseValue, now − updated_at)` and round to an integer
  (the `markets.price` column is `integer ≥ 0`). `setMarketPrice` stamps
  `updated_at = now` on every trade, so drift accrues forward from the last
  trade. `sell`, `buy`, and `inventory` all read the drifted price.
- **`buy <resource> [qty]`** (`handleBuyResource` in `commands.ts`): `buy fuel`
  is unchanged; any other arg-0 is a mineral purchase. Validates credits and
  cargo space **before** mutating, then `addInventory` + `addPlayerCredits(−total)`
  + `setMarketPrice(priceAfterPurchase(...))`. The `buy` abbrev domain is
  `["fuel", ...RESOURCES ids]`; the `qty` arg stays opaque (numeric).

### Load-bearing decisions from `temp-hazard`

- **Hazard is derived from temperature** (`hazardFor` in
  `src/lib/universe/gen.ts`), no longer uniform random. A comfort band
  (`TEMP_COMFORT_MID` 15°C ± `TEMP_COMFORT_BAND` 50°C) reads as ~0 hazard;
  beyond it, `(departure / TEMP_EXTREME_SCALE)^TEMP_HAZARD_POWER ×
  TEMP_HAZARD_WEIGHT` plus ≤`HAZARD_JITTER` random, clamped [0,1]. Still pure
  & deterministic (one `rng()` draw). Knock-on: extreme-temp worlds are
  high-hazard → (via `rarityWeight`) carry the rarest resources. Because the
  coldest stars bottom out ~−160°C but hot stars exceed +400°C, the very
  highest hazards (voidstone) skew toward scorching worlds.
- The universe-gen suite's "both calm AND savage planets exist" assertions are
  the guardrail against over-coupling — keep the random jitter so the
  distribution doesn't collapse.

### Load-bearing decisions from `ship-upgrades`

- **Upgrade catalog lives in code** (`src/lib/game/upgrades.ts`), like
  `RESOURCES`: `UPGRADES`/`UPGRADE_IDS`/`isUpgradeId`/`getUpgrade`/`recipeOf`/
  `recipeCost`/`upgradeValue`. Recipes: Ablative Shields = titanium+silica,
  Antifreeze Tanks = titanium+iron. `upgradeValue = round(recipeCost ×
  CRAFT_VALUE_MARKUP)` (~1.2 — "a bit above components"). Upgrades are NOT in
  the `markets` table (no FK, no price drift); prices are code-derived.
- **Ownership** in `public.player_upgrades` (migration
  `20260608073000_ship-upgrades.sql`): `(player_id, upgrade_id, qty)`, RLS
  read-own, service-role writes, atomic `add_player_upgrade(player, upgrade,
  delta)` RPC clamped at 0. Owning ≥1 = capability active; selling the last
  one removes it.
- **Landing gate** (`canLand`/`landingRequirement` in `rules.ts`,
  `FREEZING_C` 0 / `BOILING_C` 100, boundaries survivable): `land` and `mine`
  are blocked on a world below freezing (needs Antifreeze Tanks) or above
  boiling (needs Ablative Shields) unless owned; **`warp` is never gated**
  (arrive in-orbit at planet 0 → can't softlock). `scan` shows the requirement.
- **`craft <upgrade>`** consumes recipe components from inventory atomically
  (validate `canCraft` first). `buy`/`sell` extended to upgrade ids (buy at
  `buyUnitCost(upgradeValue)`, sell at `upgradeValue`). Abbrev domains: `craft`
  → upgrade ids; `buy`/`sell` → resources + upgrade ids.

### Load-bearing decisions from `help-args`

- **`help <command>` shows live usage** drawn from the SAME `argDomain` the
  parser uses, so help can never list an argument the parser rejects (or omit
  one it accepts). `help` (no arg) is unchanged (`renderHelp` command list).
- **Two registration points for a command** — keep them in lock-step:
  1. `src/lib/game/usage.ts` (PURE, no `server-only`): `VERBS` (the
     abbreviation vocabulary, moved here from `commands.ts`) + `USAGE`
     (`verb → { desc, slots: { name, optional?, hint? }[] }`). A slot's `hint`
     is shown for OPAQUE positions only. `usageLine(verb)` renders the canonical
     usage string (`<required>` / `[optional]`). Every verb in `VERBS` MUST have
     a `USAGE` entry (unit-tested in `help-args.test.ts`).
  2. `commands.ts`: the contextual `argDomain` via the reusable
     `buildResolveSpec(ctx)` + `loadArgDomainContext(player, seed, verb)` pair
     (extracted from `dispatch`; only `mine`/`sell` hit the DB). Both `dispatch`
     and `handleHelp` call these, so resolution and help share one domain.
- **`handleHelp`** resolves its command arg by the same unique-prefix
  `resolveToken` (so `help mi` → `mine`); unknown/ambiguous → an error frame,
  never a throw. For each slot it calls `argDomain(verb, i, [])`: non-null →
  enumerate candidates (clickable as `verb <candidate>` when arg 0 + all later
  slots optional; empty → a contextual note like "nothing minable here");
  null → a `<placeholder>` + the slot's `hint`. Rendering is
  `renderCommandHelp(CommandHelpView)` in `render.ts` (pure; handler computes
  candidates/clickability, renderer stays dumb).

### Load-bearing decisions from `help-trade-clarity`

- **Grouped + price-annotated help** for trade commands. A resolvable help
  slot's candidates are now `CommandHelpGroup[]` (in `render.ts`): each group
  has a `label` (`null` = the single-category case, rendered inline against the
  `<placeholder>:` prefix exactly as before; a string = its own `label:` line)
  and `CommandHelpCandidate[]` (each `{ label, command, annotation? }`, the
  annotation shown muted as `(<n>cr)` after the clickable token). mine/craft
  stay one `{label:null}` group (visually unchanged).
- **`help buy`/`help sell`** keep sourcing the candidate SET from the SAME
  `argDomain` the parser uses (no-drift guarantee), then layer grouping +
  pricing on top in `handleHelp`. Grouping is the pure `groupTradeCandidates`
  in `src/lib/game/trade-help.ts` (`tradeCategoryOf`: `fuel`→fuel, `all`→
  everything, `isUpgradeId`→upgrades, else minerals; fixed group order;
  unit-tested in `trade-help.test.ts`). Prices come from ONE `getMarketPrices`
  call: buy = `buyUnitCost(price)` / `buyUnitCost(upgradeValue)` /
  `FUEL_PRICE_PER_UNIT`; sell = market price / `upgradeValue`; `all` carries no
  price. Credit format is `creditLabel(n)` = `<n>cr`.
- **Reuse for future trade-like commands**: build groups via
  `groupTradeCandidates` + `creditLabel`; single-category commands just pass one
  `{label:null}` group and render identically to the old single line.

### Load-bearing decisions from `price-stickiness`

- **Global prices are deliberately HARD to move.** The old per-unit, `≥1`-floored
  `MARKET_IMPACT = 0.02` (which swung prices on tiny trades and moved cheap goods
  ~20%/unit) is GONE. The current model is a single tunable constant
  `PRICE_IMPACT = 0.0015` (`rules.ts`, 0.15%/unit, **compounding**, NO per-unit
  `≥1` floor): `priceAfterSale(p, q) = max(PRICE_FLOOR, round(p · (1−PRICE_IMPACT)^q))`
  and `priceAfterPurchase(p, q) = round(p · (1+PRICE_IMPACT)^q)`. Same signatures
  as before — handlers (`sell`/`buy`) are unchanged; only the output is gentler.
- **Feel targets** (the reason for the tuning, reason-check before retuning):
  a ~10-unit trade moves a 1000cr price < ~2% (≈ ±15cr); ~500 units ≈ a ~50%
  swing; a single unit of a cheap good rounds to NO change. Monotonic
  (sale non-increasing, purchase non-decreasing in qty); `qty ≤ 0` is a no-op;
  sale floored at `PRICE_FLOOR`. `priceTowardBase` mean-reversion is untouched.
- **One-time reset**: migration `20260608075033_reset-prices.sql` snaps every
  `location_key = 'global'` market `price` back to its `resources.base_value`
  (and stamps `updated_at = now()`). Forward-only + tracked in
  `schema_migrations`, so it runs EXACTLY ONCE — it will not clobber
  organically-moved prices on later deploys.

### Load-bearing decisions from `help-parity`

- **The no-arg `help` command list is GENERATED from the single registry**
  (`VERBS` + `USAGE` in `usage.ts`), not a hardcoded array — `renderHelp()`
  (`render.ts`) iterates `VERBS` (skipping aliases) and renders
  `usageLine(verb)` + `USAGE[verb].desc` per command. So a new command appears
  in `help` automatically once it's in `USAGE`/`VERBS`; there is NO second
  command list to forget it in. Display order = `VERBS` order.
- **Aliases carry `alias: true`** in their `USAGE` descriptor (today: `look` →
  `scan`). Aliases stay in `VERBS` (so they abbreviate/resolve) and keep a
  `USAGE` entry (so `help <alias>` works), but `renderHelp` SKIPS them so the
  same capability isn't listed twice. Mark any future synonym this way rather
  than special-casing it in the renderer.
- **Parity is locked** in `help-args.test.ts`: the verbs `help` links to ===
  `VERBS` minus aliases (both directions), and `USAGE` keys === `VERBS` (both
  directions). Registering a command in only one place fails the suite.

### Load-bearing decisions from `planet-regions`

- **A planet is no longer a single place** — it has MANY regions, each with its
  own biome + deposits. Addressing gained a 4th integer: `RegionCoord =
  { sector, system, planet, region }` (in `src/lib/universe/types.ts`). The
  start location is `(0,0,0,0)`.
- **`Planet` reshape** (BREAKING — every call site updated in this change):
  REMOVED `biome` and `deposits`; ADDED `biomePalette: Biome[]` (a DISTINCT
  subset of `BIOMES`, size `[PALETTE_MIN, PALETTE_MAX]` = `[2, 4]`) and
  `regionCount: number` (integer in `[REGION_COUNT_MIN, REGION_COUNT_MAX]` =
  `[100, 100000]`, **log-uniform**: `round(10 ** randFloat(2,5))` clamped). The
  remaining planet fields (`temperature`, `hazard`, `gravity`, `atmosphere`,
  `name`, `coord`) still describe the whole world — the hazard/temperature/
  landing model stays PLANET-level.
- **`Region` + `regionAt(seed, planetCoord, regionIndex)`** (`gen.ts`): PURE &
  deterministic, its own RNG stream keyed by the full region coord
  (`makeRng(seed, "region", sector, system, planet, region)`) so a region
  reproduces without generating its (up to 100k) siblings. `biome` is `pick`ed
  from the planet's `biomePalette` (always a member); `deposits` use the
  existing hazard-coupled `depositsFor`, so savage→rare + rarity→abundance carry
  down to the region. `regionIndex` is NOT range-checked in gen — callers
  validate against `planet.regionCount`.
- **4-segment keys**: `regionKey(coord)` →
  `"<sector>:<system>:<planet>:<region>"`; `parseLocationKey` handles 2/3/4
  segments. **These region keys are the `world_deltas` depletion keys now** —
  depletion is PER-REGION. `world.ts` depletion adapters
  (`getDepletionMap`/`getEffectiveDepletionMap`/`recordDepletion`) take a
  generic `locationKey` and are fed `regionKey`. **Discoveries stay
  PLANET-level** (`planetKey`) — no per-region discovery rows.
- **`players.region`** (`integer not null default 0`, migration
  `20260608080000_player-region.sql`, forward-only/idempotent) carried on
  `Player`/`PlayerRow` + `rowToPlayer`. `warp` and `land` reset `region` to 0
  on arrival (handled inside `world.setFuelAndLocation`/`setPlanet`);
  `world.setRegion` is the `jump` mutator.
- **Commands**: `scan` describes the CURRENT region (biome + deposits) plus
  planet context (palette, region count, region index); `jump <n>` validates
  `0 ≤ n < regionCount` then re-scans (free, same planet, opaque numeric arg);
  `regions [page]` is a paged (~10/page) clickable `jump <n>` listing. `mine`
  works the current region's deposits and depletes per `regionKey`; its abbrev
  domain is the current REGION's minable resources. All region-scan output is
  built by the shared `regionScanFrame` helper in `commands.ts`.

### Load-bearing decisions from `addressing-overhaul`

- **Spatial addressing is now a SIX-tier hierarchy**: `galaxy → arm → cluster →
  system → planet → region`. `SystemCoord` (in `src/lib/universe/types.ts`) is
  `{ galaxy, arm, cluster, system }`; `PlanetCoord` adds `planet`; `RegionCoord`
  adds `region`. **`sector` was RENAMED to `cluster` everywhere** (code, schema,
  keys). The start location is `(0,0,0,0,0,0)`. `galaxy` is UNBOUNDED (≥ 0,
  effectively infinite outward — inter-galaxy travel is a LATER, condensate-gated
  phase; everyone stays in galaxy 0 for now). `cluster`/`system` ≥ 0.
- **`arm` is a RING within a galaxy**, canonical in `[0, armCount)`. Arm indices
  WRAP modulo the galaxy's `armCount` (so `warp 13 …` in a 12-arm galaxy lands on
  arm 1), and arm distance is symmetric around the ring.
- **`galaxyAt(seed, galaxy) → { index, name, armCount }`** (`gen.ts`): pure &
  deterministic; `armCount` is `randInt(ARM_COUNT_MIN, ARM_COUNT_MAX)` = `[2, 16]`
  and VARIES per galaxy. Callers get a galaxy's `armCount` from here.
- **Keys are 4/5/6-segment** (`gen.ts`): `systemKey` →
  `"galaxy:arm:cluster:system"`, `planetKey` → +`:planet`, `regionKey` →
  +`:region`. `parseLocationKey` returns `SystemCoord`/`PlanetCoord`/`RegionCoord`
  for 4/5/6 segments (old 2/3/4-seg data was migrated, so it no longer parses
  those). These remain the `world_deltas` (per-region, 6-seg) / `discoveries`
  (per-planet, 5-seg) keys.
- **`warpDistance(a, b, armCount)`** (`gen.ts`) now takes `armCount`: different
  galaxies → `Infinity` (not a warp); same galaxy → a weighted sum
  `armRing·ARM_SPAN + |Δcluster|·CLUSTER_SPAN + |Δsystem|·SYSTEM_SPAN` where
  `armRing = min(|Δarm|, armCount − |Δarm|)` (symmetric wrap) and exported spans
  satisfy `ARM_SPAN(100) ≫ CLUSTER_SPAN(10) ≫ SYSTEM_SPAN(1)`. 0-to-self,
  symmetric, positive between distinct same-galaxy coords. `map`/`warp` supply
  `armCount` via `galaxyAt(coord.galaxy).armCount`.
- **All gen RNG streams seed with the full coord** (`makeRng(seed, "...", galaxy,
  arm, cluster, system, …)`); the planet/region generation LOGIC (palette,
  regionCount, deposits, hazard/temperature) is otherwise UNCHANGED — just keyed
  richer, so different galaxy/arm ⇒ different worlds.
- **`players` schema** (migration `20260608090000_addressing-overhaul.sql`,
  forward-only): `sector` RENAMED to `cluster`; `galaxy`/`arm` ADDED (`integer
  not null default 0`). The migration also (a) recreates the public `leaderboard`
  view against the six-tier coords, and (b) prefixes existing
  `world_deltas.location_key` / `discoveries.planet_key` with `0:0:` so prior
  depletion/discoveries resolve under galaxy 0 / arm 0 (`markets='global'` left
  alone). Runs exactly once. `Player`/`PlayerRow` + `rowToPlayer` carry
  `galaxy`/`arm`/`cluster`.
- **This phase is the SPATIAL MODEL ONLY** — the single `fuel` and
  `fuelCost(warpDistance(...))` are unchanged. **`warp <arm> <cluster> <system>`**
  warps within the current galaxy (arm taken mod `armCount`, galaxy fixed);
  `map` lists arm/cluster/system neighbors + costs and shows the full location +
  arm count. The fuel split, orbital mechanics, and galaxy jumps are LATER
  phases. The roadmap (survival, production, fuel, galaxy travel) builds on this
  six-tier model.

### Load-bearing decisions from `survival-core`

- **Embark state machine.** A player is either `embarked` (aboard ship) or
  on foot in the current region. `players.embarked boolean not null default
  true` + `players.health integer not null default 100 check (health >= 0)`
  (migration `20260608090759_survival-core.sql`, forward-only/idempotent) carried
  on `Player`/`PlayerRow` + `rowToPlayer`. New players spawn embarked at full HP.
  `disembark` (embarked→on foot) and `embark` (on foot→aboard) toggle it via
  `world.setEmbarked`; both are idempotent-friendly. `warp`/`land` do NOT change
  embark state (you stay aboard to fly).
- **Command gating by embark state** (`dispatchResolved` in `commands.ts`, two
  `Set`s checked before the switch): `EMBARKED_ONLY = {buy, sell, warp, land}`
  (the economy + ship travel; `buy fuel` is covered by `buy`) errors "You must
  `embark` your ship first." when on foot; `DISEMBARKED_ONLY = {mine}` errors
  "You must `disembark` onto the surface to mine." when aboard. Everything else
  (`scan`/`map`/`inventory`/`upgrades`/`who`/`help`/`jump`/`regions`/`craft`) is
  state-agnostic. **P5 `explore` joins `DISEMBARKED_ONLY`** (today it's a
  coming-soon stub, `handleExplore`).
- **Hazard damage model is PURE in `rules.ts`** (rolls passed in; handler supplies
  `Math.random()`): `MAX_HEALTH=100`, `DEATH_GOLD_PENALTY=0.1`,
  `HAZARD_DAMAGE_MAX=40`. `damageChance(hazard)=clamp01(hazard)` (chance an action
  harms you; 0 at hazard 0, monotonic). `damageAmount(hazard, roll)=max(1,
  round(HAZARD_DAMAGE_MAX·hazard·(0.5+0.5·roll)))` (magnitude; positive int for
  hazard>0, monotonic in both args). `rollHazardDamage(hazard, chanceRoll,
  magnitudeRoll)` = 0 if `chanceRoll >= damageChance` else `damageAmount`.
  `creditsAfterDeath(c)=floor(c·0.9)` floored at 0. Seeded contract:
  `survival-core.test.ts`.
- **Damage applies AFTER a successful disembarked action** (this phase: `mine` —
  the ore is granted first, then `rollHazardDamage(planet.hazard, …)` subtracts
  from health). Hazard is PLANET-level (unchanged). On HP>0 after damage:
  `world.setHealth`, report damage + remaining HP in `danger` style. On HP≤0:
  **death sequence** — `addPlayerCredits(-(credits − creditsAfterDeath(credits)))`
  (atomic credit RPC; never negative), then `world.setHealthAndEmbarked(id,
  MAX_HEALTH, true)` (full HP, wake aboard, **location unchanged**), with a death
  frame. P5 (flora/fauna/combat/scavenging) and P6 (food) build directly on
  disembarked actions + this health model.
- **`scan` and `inventory` show survival status** — an `HP n/100` readout (red
  when ≤30%) + `aboard ship`/`on foot`, threaded through `ScanView`/
  `InventoryView` (`render.ts`). Disembarked surfacing only; the rules stay pure.

### Load-bearing decisions from `wildlife`

- **Materials subsystem** (the spoils of the on-foot loop) mirrors `upgrades`
  exactly: code catalog `src/lib/game/materials.ts` (`MATERIALS` =
  `{ id, name, category: "flora"|"animal"|"relic"|"mineral", value }`, helpers
  `isMaterialId`/`getMaterial`/`materialValue`), code-priced (NOT in `markets`,
  no drift, like upgrades). Ownership in `public.player_materials`
  (`player_id, material_id, qty`, pk, qty≥0 check, RLS read-own, service-role
  writes) + atomic `add_player_material(player, material, delta)` RPC, both added
  in migration `20260608093000_wildlife.sql` (forward-only/idempotent). World
  adapters `getPlayerMaterials`/`addPlayerMaterial` in `world.ts`. Relics
  (`precursor_relic`, `void_idol`) are the rare high-value tier.
- **Flora/fauna catalogs** in `src/lib/game/wildlife.ts` (code, no DB): `FLORA`
  (`{ id, name, biomes: Biome[], harvest: { materialId, qty } }`) and `FAUNA`
  (`{ id, name, biomes, maxHp, attack, hostile, drop: { materialId, qty } }`).
  Every one of the 10 `BIOMES` has ≥1 flora AND ≥1 fauna so `explore` always
  finds something (guarded in `wildlife-catalog.test.ts`). Helpers
  `floraForBiome`/`faunaForBiome`/`getFauna`/`getFlora` and the PURE selector
  `pickForBiome(list, biome, roll)` — filters to biome-valid entries then indexes
  by roll, so a pick is ALWAYS biome-appropriate (AC#2); `null` if none.
- **Combat is PURE in `rules.ts`**: `PLAYER_BASE_ATTACK = 12` (flat — no weapon
  upgrades yet), `combatRound({playerHp, playerAtk, creatureHp, creatureAtk})`
  deals damage to BOTH sides at once (clamped ≥0, `playerDead`/`creatureDead`
  flags; both can die in one round). `exploreOutcome(roll)` partitions `[0,1)` →
  `scavenge` `[0,0.30)` / `flora` `[0.30,0.65)` / `fauna` `[0.65,1)` (thresholds
  `EXPLORE_SCAVENGE_MAX`/`EXPLORE_FLORA_MAX`). Handlers supply the real
  `Math.random()` rolls (same pattern as the P4 hazard model).
- **Combat state** is `players.encounter jsonb` (nullable; `null` = not fighting,
  else `{ faunaId, hp }`), on `Player`/`PlayerRow`/`PlayerEncounter` +
  `rowToPlayer`. `world.setEncounter(id, enc|null)` is the mutator. Set on a fauna
  encounter (hostile AND placid — so `attack` always has a target), cleared on
  kill / `flee` / death.
- **Commands** (`commands.ts`): `explore`/`harvest`/`attack`/`flee` joined
  `VERBS`+`USAGE` (P4 explore stub replaced; help parity green).
  `explore`/`harvest`/`attack`/`flee` are all in `DISEMBARKED_ONLY`;
  `attack`/`flee` additionally need an `encounter` (handler-checked, helpful
  error else). `explore` rolls `exploreOutcome` → scavenge (`pickScavenge` award)
  / flora (offer `harvest`) / fauna (set `encounter`), then takes the P4
  hazard roll (can kill → death). Gated by `canLand` like `mine` (hostile
  surface needs the upgrade). `harvest` re-rolls a biome flora (no hazard).
  `attack` = one `combatRound`: creature dies → award `drop` + clear encounter;
  player dies → death sequence; else update both HPs. `flee` clears the
  encounter (no parting hit). The P4 death sequence was extracted to the shared
  `runDeath(player, causeText)` helper (also clears any encounter); `mine` now
  uses it too.
- **Selling**: `sell <material> [qty]` (embarked-only, like all economy) pays
  `materialValue`/u via `handleSellMaterial` (code-priced, no cargo, no `all`
  inclusion — default qty = whole stack). `sell`'s abbrev domain now appends
  OWNED material ids. `scan` shows an active encounter (creature + HP +
  `attack`/`flee`) via `ScanView.encounter`/`EncounterView`; `inventory` lists
  owned materials with their fixed value (`InventoryView.materials`).
- **For P6 (food)**: animal/flora materials become healing items there. P9's
  market-supply ideas may extend material selling. Combat is one-creature-at-a-
  time; no flee-into-new-encounter chains.

### Load-bearing decisions from `food`

- **Food are materials** with `category: "food"` (`src/lib/game/materials.ts`) —
  no new table; they reuse `player_materials` storage, the `sell <material>`
  path, and `getPlayerMaterials`/`addPlayerMaterial` exactly like every other
  material. What sets food apart: an optional **`heal`** field on `Material`
  (HP restored by `eat`; present + `> 0` only on food) and a **cooking recipe**.
  Helpers: `FOOD`/`FOOD_IDS`/`isFoodId`/`healOf(id)` (0 for inedible) +
  `FOOD_RECIPES`/`foodRecipeOf(id)` (food id → `{ materialId: qty }` of OTHER
  materials; throws on unknown). Food carry a real `value` so they're sellable
  too, but the point is `heal`. **`SCAVENGEABLE` now excludes `food`** (alongside
  `animal`) — cooked food is crafted, never found/dropped.
- **Cooking via `craft`** (no new verb): `handleCraft` branches up front —
  `isFoodId` → `handleCookFood` (consume MATERIAL ingredients from
  `player_materials`, then grant one food), else the existing upgrade path
  (consume MINED resources from cargo). Validation reuses the pure `canCraft(have,
  recipe)`; consumption is atomic via `add_player_material(-qty)`. `craft`'s
  abbrev domain is `[...UPGRADE_IDS, ...FOOD_IDS]`. Cooking is **un-gated** by
  embark state (matches `craft`).
- **`eat <food>`** (`handleEat`, new `VERBS`+`USAGE` entry): validates ownership
  + edibility (inedible material / unowned → clear error, no state change), reads
  the freshest HP, then `setHealth(healValue(hp, healOf(food), MAX_HEALTH))` and
  `add_player_material(-1)`. Refuses at full HP. **Un-gated** by embark state
  (you take damage on foot, but a snack aboard is fine). Reports HP before→after.
  Its abbrev domain = OWNED food ids (loaded in `loadArgDomainContext` like
  `sell`/`mine`; `ArgDomainContext.eatCandidates`).
- **Pure heal math** is `healValue(currentHp, healAmount, maxHp = MAX_HEALTH)` =
  `min(maxHp, currentHp + max(0, healAmount))` in `rules.ts` — never overheals,
  a non-positive heal can't reduce HP. Seeded contract: `food.test.ts`.
- **Inventory display**: `InventoryView.materials[]` items gained an optional
  `heal`; `renderInventory` shows `+N HP` and an `eat <id>` action for food
  (alongside the existing `sell` action). **No migration** — food is pure catalog
  + craft-extension + `eat`; `player_materials` already stores it.
- **For later phases**: cooking stations / buildings are production-era (P7–P9);
  this phase is catalog + `craft` branch + `eat` only.

### Load-bearing decisions from `bases-minerals`

- **Bases open the production track (P7): a base is a player's claim on a
  region, and OTHER players see it.** New `public.bases` table (migration
  `20260608100000_bases-minerals.sql`, forward-only/idempotent): `id uuid pk`,
  `owner_id → players(id) on delete cascade`, `region_key text` (the 6-seg
  `regionKey`; free-form coord, no FK — universe is procedural), `name text`,
  `created_at`, **unique (owner_id, region_key)** (one base per player per
  region; many players may base in the same region), index on `region_key`.
  RLS: **public read** (shared-world presence, like `world_deltas`/
  `discoveries`); **no** anon/authenticated write (service-role writes only).
  Buildings INSIDE bases (excavators/silos/production lines) are **P8**, which
  extends `build`'s structure domain beyond `base`.
- **`world.ts` base adapters**: `createBase(ownerId, regionKey, name?)` → `true`
  if inserted, `false` on the `(owner,region)` unique violation (`23505`; other
  errors throw); `basesInRegion(regionKey)` → `RegionBase[]` (`{ownerId, handle,
  name}`, handle resolved from the public `leaderboard` view, public-safe);
  `basesOwnedBy(playerId)` → `OwnedBase[]` (`{regionKey, name}`).
- **Base cost is a pure, tunable catalog** in `src/lib/game/bases.ts` (mirrors
  `upgrades.ts`/`materials.ts`): `BASE_BUILD_COST` is a `Record<string,number>`
  mixing the literal **`credits`** key with mineral ids (`{credits:500,
  titanium:2, iron:5}`); `BASE_BUILD_CREDITS`/`BASE_BUILD_MINERALS` split it;
  `canAffordBase(have, cost=BASE_BUILD_COST)` is true iff every cost line is met.
  Seeded contract: `base-cost.test.ts`.
- **`build base [name]`** (`handleBuild`, **DISEMBARKED_ONLY**, gated like
  `mine`): validates no-duplicate (via `basesOwnedBy`) + affordability (live
  credits + cargo) BEFORE mutating, consumes the cost atomically (minerals via
  `removeInventory`, then `addPlayerCredits(-credits)`), then `createBase`. A
  lost create race **refunds** the cost so nothing is consumed on failure.
  `build`'s arg-0 domain is just **`["base"]`** today (P8 grows it); the name is
  an opaque, case-preserved tail (`args.slice(1).join(" ")`). `build`+`bases`
  registered in `VERBS`+`USAGE` (help parity locked).
- **`bases`** (`handleBases`) lists your bases via `renderBases`
  (`describeRegionKey` parses the 6-seg key into a friendly coord label).
  **`scan`** shows bases in the current region (`ScanView.bases: ScanBase[]` =
  `{handle, name, mine}`; yours marked `(yours)`, others by `— <handle>`),
  fetched in `regionScanFrame` via `basesInRegion` — proving cross-player
  visibility.
- **More / biome-specific minerals.** `Resource` gained an optional
  **`biomes?: readonly Biome[]`** (type-only import from `types.ts` to avoid a
  runtime cycle): omitted/empty → GENERAL (anywhere, as the original 7);
  non-empty → BIOME-SPECIFIC (only regions of those biomes). New minerals:
  general `cobalt`; biome-specific `pyrite`(volcanic), `verdite`(jungle),
  `aquamarine`(ocean), `radium_salt`(irradiated/toxic), `prismatic_gem`
  (crystalline). Catalog (`resources.ts`) MUST match the DB seed in the
  migration (`insert ... on conflict do nothing` for both `resources` and the
  `global` `markets` price = `base_value`).
- **Biome-aware deposit gen** (still pure & deterministic): `depositsFor(rng,
  hazard, biome)` draws its candidate pool from **`mineralsForBiome(biome)`**
  (general + that biome's specifics — exported from `universe/index.ts`), so a
  region can NEVER yield a mineral specific to a different biome; the
  hazard→rarity (`rarityWeight`) + rarity→abundance couplings still apply over
  the filtered pool. `regionAt` rolls the biome BEFORE deposits so the pool is a
  deterministic function of the region coord. Seeded contract:
  `biome-minerals.test.ts` (the old fixed-catalog-size assertion in
  `universe-gen.test.ts` was relaxed to `>= 7`, preserving coverage).

### Load-bearing decisions from `base-buildings`

- **P8a opens the production track INSIDE a base: silos (storage) + excavators
  (passive, time-based ore drain).** Two new tables (migration
  `20260608110000_base-buildings.sql`, forward-only/idempotent), both **public
  read** (bases are public, so their buildings/contents are too) with
  service-role-only writes:
  - `base_buildings` — `id uuid pk`, `base_id → bases(id) on delete cascade`,
    `kind text` (`'silo' | 'excavator'`; no DB enum so P8b kinds need no
    migration), `state jsonb default '{}'` (excavator: `{ lastCollectedAt:
    <iso> }`), `created_at`, index on `base_id`.
  - `base_storage` — `(base_id → bases, item_id text, qty int ≥0)`, pk
    `(base_id, item_id)`; `item_id` is a **resource id for now** (P8b extends to
    materials/advanced). Atomic `add_base_storage(p_base, p_item, p_delta)` RPC
    mirroring `add_inventory`/`add_player_material` (single statement,
    `greatest(0, …)` clamp). No FK on `item_id` (code catalog, like inventory).
- **`world.ts` adapters**: `getBaseInRegion(ownerId, regionKey) → {id, name}|null`
  (the `(owner,region)` unique key ⇒ ≤1), `getBaseBuildings(baseId) →
  BaseBuilding[]` (`{id, kind, state, createdAt}`), `createBaseBuilding(baseId,
  kind, state?)`, `setBuildingState(buildingId, state)`, `getBaseStorage(baseId)
  → StorageStack[]` (`{itemId, qty}`, qty>0), `addBaseStorage(baseId, itemId,
  delta) → newQty`.
- **Pure rules** (`rules.ts`, seeded contract `base-buildings.test.ts`):
  `SILO_CAPACITY = 1000` (units/silo); `EXCAVATOR_RATE_PER_MS = 1/360_000`
  (~10 units/hr per excavator at abundance 1.0 — "slowly drains over time");
  `baseCapacity(siloCount) = SILO_CAPACITY · siloCount`; `excavatorYield(
  abundance, elapsedMs, ratePerMs?) = floor(min(1,abundance) · elapsedMs ·
  ratePerMs)`, 0 when abundance≤0 or elapsed≤0, monotonic in both. Time is passed
  in (handler supplies `Date.now()`); these stay pure & deterministic.
- **Building costs are tunable code catalog** in `bases.ts` (mirrors
  `BASE_BUILD_COST`): `BUILDING_BUILD_COST: Record<StructureKind, costMap>` =
  `{ silo: {credits:300, iron:5}, excavator: {credits:400, titanium:3, iron:5} }`;
  `STRUCTURE_KINDS`/`isStructureKind`/`buildingCost(kind)` + the generic
  `creditsOf`/`mineralsOf` splitters. `canAffordBase(have, cost)` checks any cost
  map uniformly. `commands.ts` shares `consumeCost`/`refundCost`/`affordContext`
  for the base AND building build paths.
- **`build` structure domain is now `["base","silo","excavator"]`** (abbrev-
  resolvable). `build silo`/`build excavator` are **DISEMBARKED_ONLY** (like
  `build base`) AND require an owned base in the current region; charge their cost
  atomically (validate→consume; nothing consumed on failure), create the building
  row. Excavators start with `lastCollectedAt = now`.
- **`deposit <item> [qty]` / `withdraw <item> [qty]`** move resources between ship
  cargo and the current region's base storage — **ungated by embark state**
  ("it's your base"). Bounded by holdings, free cargo, and `baseCapacity(#silos)`;
  default qty = "as much as fits". Atomic (`add_inventory`/`add_base_storage`
  pair). Abbrev domains: `deposit` arg0 = held resource ids; `withdraw` arg0 =
  this base's stored item ids (loaded in `loadArgDomainContext`).
- **`collect`** (ungated): for each excavator and each region deposit, accrue
  `excavatorYield(effectiveAbundance, elapsedSinceLastCollected)`, **clamped to
  remaining storage capacity** (banked in deposit order). Banked ore is added to
  `base_storage` AND written back via `recordDepletion(regionKey, …, qty ·
  DEPLETION_PER_UNIT, …)` — so excavation drains the **same** per-region
  depletion model as manual `mine` (others see less; regen refills). All
  excavators' `lastCollectedAt` advance to `now` whenever there was room (no time
  lost). No elapsed ⇒ nothing accrues.
- **`storage` (alias `base`)** shows the current region's base: silo/excavator
  counts + stored contents vs capacity (`renderStorage`/`StorageView` in
  `render.ts`). `base` is a `USAGE` alias (`alias:true`, skipped in the `help`
  list, like `look`→`scan`); both resolve to `handleStorage`.
- **For P8b**: production lines consume siloed raw → advanced materials (extend
  `base_buildings.kind`, the `build` domain, and `base_storage.item_id` beyond
  resource ids — no schema change needed for new kinds/items). P9 routes
  ship-upgrade manufacture through production lines.

### Load-bearing decisions from `production-lines`

- **P8b closes the production track: a production line turns siloed RAW minerals
  into advanced SHIP PARTS.** NO migration — `production_line` is just a new
  `base_buildings.kind` value (free-text column) and parts live in `base_storage`
  (free-text `item_id`), exactly as P8a anticipated. Reuses P8a's
  `base_buildings`/`base_storage`/`baseCapacity` + the `build`/cost machinery
  wholesale (no fork).
- **Ship-parts catalog (code)** is `src/lib/game/parts.ts`, mirroring
  `upgrades.ts`/`materials.ts`: `Part = { id, name, recipe: Record<resourceId,
  qty>, value }`; helpers `PARTS`/`PART_IDS`/`isPartId`/`getPart`/`partRecipeOf`/
  `partValue` (+ `partRawInputValue` = Σ qty × resource baseValue). Four starters
  (hull_plating, circuit_board, alloy_beam, sensor_array) built from GENERAL
  minerals so they're broadly producible early. **Invariant (unit-tested):** each
  `value` is strictly > its raw input value (manufacturing adds value); recipes
  reference only real `RESOURCES` ids. Parts are NOT in `markets` and (this phase)
  NOT sellable — they sit in storage as intermediates for P9.
- **`production_line` is now a `StructureKind`** (`bases.ts`): `STRUCTURE_KINDS =
  ["silo","excavator","production_line"]` (the P8a `base-buildings-cost.test.ts`
  exact-match assertion was updated to track this deliberate extension),
  `BUILDING_BUILD_COST.production_line = { credits:600, titanium:5, copper:5 }`.
  **`build production_line`** behaves exactly like other P8a structures
  (DISEMBARKED_ONLY, own a base in-region, atomic validate→consume→create via the
  shared `consumeCost`/`refundCost`/`affordContext`). `build`'s arg-0 domain is
  now `["base","silo","excavator","production_line"]`.
- **Pure rule** `canProduce(siloed, recipe, qty=1)` in `rules.ts` mirrors
  `canCraft` but scales the requirement by `qty` (the production-line analogue:
  inputs come from the SILO, not cargo). `qty<=0` is vacuously true (handler
  rejects non-positive separately). Seeded contract: `production-lines.test.ts`.
- **`produce <part> [qty]`** (`handleProduce`, **ungated by embark state** — it's
  your base, like `deposit`/`withdraw`/`collect`): requires a base in the current
  region with ≥1 production line; validates line-exists + inputs-siloed +
  capacity-fits BEFORE mutating (clear errors: "No production line here", "need 5
  Titanium in the silo (have 2)", storage-overflow). Consumes recipe inputs from
  `base_storage` then banks the part(s) back into `base_storage`, all via the
  atomic `add_base_storage` RPC. Instant (no timer); a metered-over-time variant
  (lastProducedAt + per-ms rate, like excavators) is a noted future enhancement.
  `produce`'s arg-0 domain = `PART_IDS`.
- **Parts stay in the silo.** `withdraw` is RAW-resources-only: part ids are
  filtered from its abbrev domain AND the handler rejects a typed part id (no
  cargo slot / sell path yet — P9 wires parts out). The storage display name
  helper `storageItemName(itemId)` resolves parts before resources so a part in
  storage never trips `getResource`'s throw.
- **`storage`/`base` view** gained a production-line count and, once ≥1 line
  exists, a clickable **Producible:** list (`StorageView.productionLines` +
  `producible: {id,name,recipe}[]`, rendered in `renderStorage`); a `build
  production_line` hint sits alongside the silo/excavator hints.
- **For P9**: Ablative Shields / Antifreeze Tanks become production-line OUTPUTS
  (consuming parts), and parts gain a finite, player-grown market supply +
  on-market selling. Extend `parts.ts` / the upgrade recipes there; no schema
  change needed.

### Load-bearing decisions from `upgrade-economy`

- **P9a turns ship upgrades into MANUFACTURED goods with a finite, player-driven
  market supply.** Two coupled changes, both reusing existing machinery (no
  fork):
  1. **Upgrade recipes are now SHIP PARTS, not raw minerals.** `Upgrade.recipe`
     keys are PART ids (`upgrades.ts`): Ablative Shields =
     `{ hull_plating: 2, alloy_beam: 1 }`, Antifreeze Tanks =
     `{ circuit_board: 2, sensor_array: 1 }`. `recipeCost` now sums **`partValue`**
     (× qty) and `upgradeValue = round(recipeCost × CRAFT_VALUE_MARKUP)` is
     unchanged in formula but much higher in absolute value (parts are valuable).
     `upgrades.ts` imports `getPart` from `parts.ts` (one-way; no cycle).
  2. **Upgrades moved OFF manual `craft` onto `produce`.** `craft` now ONLY cooks
     food (P6). `craft <upgrade>` errors with a redirect to `produce` + a
     production line. To make that redirect reachable (the resolver would
     otherwise reject an unknown arg), **`craft`'s arg domain is now OPAQUE
     (`null`)** and `handleCraft` resolves the food prefix itself via
     `resolveToken(target, FOOD_IDS)` (foods still abbreviate handler-side; `help
     craft` shows a `<food>` placeholder + hint). `produce`'s arg domain is now
     `[...PART_IDS, ...UPGRADE_IDS]`.
- **`produce <upgrade>`** (`handleProduceUpgrade`, branched out of `handleProduce`
  after the shared base + production-line checks): consumes the upgrade's siloed
  **PART** inputs (`add_base_storage(-)`) and **grants the upgrade to the player**
  (`add_player_upgrade(+1)`) — NOT banked into storage, so there's NO capacity
  check (upgrades don't sit in the silo). Validates `canProduce(siloed, recipe,
  qty)` BEFORE mutating; atomic; ungated by embark state (it's your base, like
  parts). Supports `qty`.
- **Finite buyable SUPPLY** lives in `public.upgrade_market` (migration
  `20260608120000_upgrade-economy.sql`, forward-only/idempotent): `upgrade_id
  text pk`, `supply integer ≥ 0`, `updated_at`. **PUBLIC read** (shared market,
  like `markets`/`bases`); service-role writes only. Atomic
  `add_upgrade_supply(upgrade, delta)` RPC (clamped ≥ 0, stamps `updated_at`),
  mirroring `add_player_upgrade`/`add_base_storage`. **Seeded 3 per upgrade** via
  `on conflict do nothing` (runs once; never clobbers organically-moved supply).
  The seeded ids MUST stay in lock-step with `UPGRADES`. `world.ts` adapters:
  `getUpgradeSupply(id)`, `getUpgradeSupplies()` (for the view),
  `addUpgradeSupply(id, delta)`.
- **buy/sell upgrade supply mechanics** (still embarked-only economy; PRICE stays
  code-derived `buyUnitCost(upgradeValue)` — only SUPPLY is the new mechanic):
  `buy <upgrade>` requires `canBuyFromSupply(supply)` (pure, `supply > 0`, in
  `upgrades.ts`) — out of stock errors "someone must manufacture and sell one";
  validates `supply ≥ qty` BEFORE charging, then `add_upgrade_supply(-qty)`.
  `sell <upgrade>` is unchanged in payout but now also `add_upgrade_supply(+qty)`
  — so the ONLY way buyable stock grows is players manufacturing + selling.
- **Supply is surfaced in the `upgrades` market view** (`renderUpgrades` /
  `UpgradesView.market`): a "Market (finite supply)" section listing each upgrade
  as `N in stock (price)` (clickable `buy` when in stock) or "out of stock". The
  owned-none hint points to `produce` (no longer a clickable `craft`).
- **Landing gate unchanged** (`canLand`/`landingRequirement`, owning ≥ 1
  Ablative/Antifreeze) — you just obtain upgrades via `produce`/`buy` now.
  `ship-upgrades.test.ts` was migrated: the recipe-component assertion now expects
  the parts-based recipes (the value-band `(cost, 2×cost)` assertion still holds at
  `CRAFT_VALUE_MARKUP = 1.2`).
- **For P9b**: render unbuyable (out-of-stock / unaffordable) and otherwise-
  unperformable action tokens RED. The supply read (`getUpgradeSupplies`) +
  `canBuyFromSupply` are the hooks for the out-of-stock case.

### Load-bearing decisions from `red-actions`

- **`ActionSpan.disabled` is the "unperformable → red" convention.** An
  `ActionSpan` (`src/lib/terminal/types.ts`) carries an optional
  `disabled?: boolean`; when set, the renderer colors the token with the
  `danger` (red) intent instead of the usual `link` (blue), **overriding any
  declared `style`**. It is **color-only** (theme-parity rule — no geometry
  change) and the token **stays clickable**: clicking a red action still submits
  its command and returns the normal "you can't do that" error frame (which is
  informative). Default undefined/false = performable = blue.
- **Renderer color choice is the pure `actionStyle(span)`** in
  `src/lib/terminal/helpers.ts` (`disabled → "danger"`, else `style ?? "link"`),
  used by `<Terminal>`'s `Span` (`STYLE_CLASS[actionStyle(span)]`) so the mapping
  is unit-testable without React (`src/lib/terminal/red-actions.test.ts`). The
  `action(label, command, { disabled })` helper gained the optional flag and
  stays back-compatible (falsey `disabled` is not serialized).
- **Server decides performability using the SAME gates that reject the command**
  — never parallel logic — so red ⇔ the command would error. Coverage today
  (`render.ts` + `commands.ts`): `mine` actions in `scan` (red when embarked, or
  hostile surface without the landing gear — `view.embarked` /
  `requiredUpgrade`+`hasRequiredUpgrade`); `land` siblings (red when on foot);
  `warp` in `map` (red when `fuelCost > fuel`); upgrade `buy` in `upgrades`
  (`!canBuyFromSupply(supply)` out-of-stock, or `credits < price`); `build
  silo|excavator|production_line` hints in `storage` (`canAffordBase(have,
  buildingCost(kind))`); `produce <part>` in `storage` (`!canProduce(siloed,
  recipe, 1)`); and `help buy` candidates (`buyDisabled` reusing
  `FUEL_PRICE_PER_UNIT`/`buyUnitCost`/`canBuyFromSupply`). `CommandHelpCandidate`
  and `StorageView`/`UpgradesView` gained the flags/affordability inputs that
  carry this from handler to renderer.
- **Future actionable output adopts this:** mark an action `disabled` whenever
  the emitting handler already knows it would be rejected. The exploration track
  should mark P2 can't-afford warp/fuel and P3 galaxy-jump-without-condensate
  actions `disabled` too.

### Load-bearing decisions from `fuel-orbital`

- **There are now TWO fuels (P2), with two cost models.** The existing `fuel`
  column/`Player.fuel` **is regular fuel**; a new `warp_fuel` column /
  `Player.warpFuel` is the second pool (migration
  `20260608130000_fuel-orbital.sql`, forward-only/idempotent `add column if not
  exists`, `default 100 check (warp_fuel >= 0)`; carried on `PlayerRow`/`Player`
  + `rowToPlayer`). RLS/leaderboard untouched (neither fuel is exposed there).
  - **WARP fuel** powers `warp` (system-and-larger jumps). Cost =
    `warpFuelCost(warpDistance(...))`, which scales **only with distance** (the
    old `fuelCost` renamed; identical `ceil(distance · WARP_FUEL_PER_DISTANCE)`
    contract — 0 at 0, non-decreasing, positive integer).
  - **REGULAR fuel** powers `land` (planet-to-planet WITHIN a system). Cost =
    `regularFuelCost(fromPlanet, toPlanet, Date.now())` = **takeoff +
    interplanetary**, the two ADDITIVE: `takeoffCost(atm, gravity)` =
    `(TAKEOFF_BASE + TAKEOFF_ATM_COEF · atmosphereDensity(atm)) · gravity`
    (additive in atmosphere density, multiplicative/linear in gravity) PLUS
    `INTERPLANETARY_FUEL_PER_DISTANCE · interplanetaryDistance(...)`, `ceil`'d to
    a positive integer. Region `jump` stays **free** (no interplanetary move).
- **Planets now have real, time-varying orbits.** `Planet` gained
  `orbitalRadius` (AU-ish, `[0.3, 40]`), `orbitalPeriod` (REAL-time ms,
  `[~6h, ~30d]`), `orbitalPhase` (`[0, 2π)`), all drawn deterministically in
  `generatePlanet` — appended **last** in the RNG stream so every pre-existing
  planet field stayed byte-identical. Position is the PURE
  `planetPosition(orbit, timeMs)` (circle: `angle = phase + 2π·timeMs/period`);
  `interplanetaryDistance(a, b, timeMs)` is the Euclidean separation (≥0,
  symmetric, **varies with time** as the two planets sweep at different rates).
  Gen NEVER touches `Date`; `timeMs` is a parameter (handlers pass `Date.now()`),
  so all of `rules.ts` stays pure & deterministic (seeded contract:
  `fuel-orbital.test.ts`).
- **Prices:** `REGULAR_FUEL_PRICE_PER_UNIT` (3, renamed from
  `FUEL_PRICE_PER_UNIT`) and `WARP_FUEL_PRICE_PER_UNIT` (9, **> regular** — warp
  fuel is the premium long-haul stuff). **`buy fuel [n]`** refills regular,
  **`buy warpfuel [n]`** refills warp; both embarked-only, share
  `handleBuyFuel(kind)`. `buy`'s arg domain is now
  `["fuel", "warpfuel", ...resources, ...upgrades]`; `tradeCategoryOf("warpfuel")
  = "fuel"` (so `help buy` groups it with fuel; pricing branches on the id).
- **World adapters:** `setWarpFuelAndLocation` (warp — warp_fuel + location,
  region→0; regular fuel untouched), `setFuelAndPlanet` (land — regular fuel +
  planet, region→0; warp fuel untouched), `setWarpFuel` (buy warpfuel), `setFuel`
  (buy fuel, unchanged). The old `setFuelAndLocation`/`setPlanet` were replaced
  by these fuel-aware mutators.
- **UI** shows BOTH fuels (`scan` fuel readout + per-sibling `land` fuel cost;
  `map` warp options show warp-fuel cost; `inventory` + boot banner). Affordability
  red reuses P9b's `disabled`-action convention: `map` warp tokens red when
  `warpFuelCost > warpFuel`; `scan` `land` siblings red when on foot OR
  `regularFuelCost > fuel` (`ScanView.siblingLand` carries the per-sibling cost +
  affordability the handler computed).
- **For P3 (galaxy jump):** consumes Hyperwarp Condensate and may also draw warp
  fuel; cross-galaxy `warpDistance` is `Infinity` so such warps are simply not
  offered until P3 adds the condensate path.

### Load-bearing decisions from `galaxy-jump`

- **P3 closes the exploration track: `hyperwarp <galaxy>` is the ONLY command
  that changes `players.galaxy`.** Normal `warp` stays within-galaxy (cross-galaxy
  `warpDistance` is `Infinity`, so `map`/`warp` never offer it). Embarked-only
  (joined `EMBARKED_ONLY` alongside `warp`/`land`/`buy`/`sell`). **NO migration** —
  the `galaxy` column exists (P1) and the condensate lives in `player_materials`
  (no new table, no DB seed; material ids are free-text/code catalog).
- **Hyperwarp Condensate is a CONSUMABLE material** — a new
  `MaterialCategory: "consumable"` (`materials.ts`), id `hyperwarp_condensate`,
  stored in `player_materials` like food. It is **manual-`craft`** (the
  consumables — food, condensate — are manual-craft; parts/upgrades are
  production-line `produce`). **Excluded from `SCAVENGEABLE`** (alongside
  `animal`/`food`): crafted, never found/dropped. Sellable (value 6000, above its
  raw voidstone cost) but the point is the jump.
- **Recipe is voidstone, a mined RESOURCE in CARGO** — not a material. Pure rules
  live in `src/lib/game/galaxy-jump.ts`: `CONDENSATE_RECIPE = { voidstone: 10 }`
  (tunable, "significant"; voidstone is rarity-5 savage-world-only, gating galaxy
  travel behind deep exploration), `HYPERWARP_CONDENSATE_ID`, and
  `canHyperwarp(condensateOwned, fromGalaxy, toGalaxy)` →
  `{ok:true} | {ok:false, reason:"no-condensate"|"same-galaxy"}` (condensate check
  FIRST — the more actionable message). Module is PURE (no IO/`Date`/`Math.random`).
  Seeded contract: `galaxy-jump.test.ts`.
- **`craft hyperwarp_condensate`** (`handleCraftCondensate`): `craft`'s arg is
  opaque, so `handleCraft` resolves the prefix itself against
  `[...FOOD_IDS, HYPERWARP_CONDENSATE_ID]` (foods + condensate abbreviate
  handler-side; `craft hyp` works). Unlike cooking (consumes `player_materials`),
  this validates `canCraft(cargo, CONDENSATE_RECIPE)` against the CARGO hold, then
  `removeInventory(voidstone)` + `addPlayerMaterial(condensate, +1)`. Ungated by
  embark (like all crafting). Shortfall → clear error, nothing consumed.
- **`hyperwarp <galaxy>`** (`handleHyperwarp`, opaque numeric arg): validates
  `target ≥ 0`, reads the LIVE condensate count, gates via `canHyperwarp` BEFORE
  mutating. On success: `addPlayerMaterial(condensate, -1)` then the new
  `world.setGalaxyLocation(id, {galaxy, arm, cluster:0, system:0, planet:0})`
  (region→0) — the **fixed entry point** is arm `0 % destGalaxy.armCount` (always
  0), cluster/system/planet/region 0. **NO fuel charge** — the condensate IS the
  cost. `setGalaxyLocation` is the ONLY `galaxy`-changing mutator (mirrors
  `setWarpFuelAndLocation` minus fuel). Reports arrival (new galaxy name + arm
  count from `galaxyAt`) and scans the entry region.
- **Surfacing** (P9b red-action convention): `map` gained a "Galaxy jump" section
  showing the condensate count and a `hyperwarp <galaxy+1>` action that reads RED
  (`disabled`) when the player holds none — clicking it still returns the helpful
  "craft one from voidstone" error. `MapLocation.condensate` carries the count
  (`handleMap` fetches `getPlayerMaterials`). Condensate count is also visible in
  `inventory` automatically (it's a material). `help`/abbrev/usage parity intact
  (`hyperwarp` in `VERBS`+`USAGE`, opaque `<galaxy>` slot).
- **This COMPLETES the exploration/survival/production mega-roadmap.**

### Load-bearing decisions from `context-help`

- **ONE applicability model is the single source of truth for both context-aware
  `help` AND the dispatch gate** — "shown in `help`" ⇔ "usable right now" can
  never drift (the same single-source pattern as arg domains + the verb
  registry). It lives in `src/lib/game/applicability.ts` (PURE — no IO, no
  `server-only`): `isApplicable(verb, state)` + `applicableVerbs(state, verbs?)`
  over `PlayerStateView = { embarked: boolean; inCombat: boolean }` (`inCombat =
  player.encounter != null`). This REPLACED the scattered `EMBARKED_ONLY` /
  `DISEMBARKED_ONLY` sets and the ad-hoc combat checks in `commands.ts` — there
  is NO parallel gating logic anymore.
- **State buckets** (each verb lives in exactly ONE; that placement decides both
  help-visibility and dispatch-acceptance):
  - **INFORMATIONAL** (always, every state incl. combat): `help`, `scan`,
    `map`, `inventory`, `upgrades`, `who`, `bases`, `regions`, `storage` (+ the
    `look`/`base` aliases, which follow their canonical informational verb).
  - **COMBAT_ONLY** (iff `inCombat`): `attack`, `flee`.
  - **EMBARKED_ACTIONS** (iff `embarked && !inCombat`): `buy`, `sell`, `warp`,
    `land`, `hyperwarp`, `disembark`.
  - **DISEMBARKED_ACTIONS** (iff `!embarked && !inCombat`): `mine`, `explore`,
    `harvest`, `build`, `produce`, `collect`, `deposit`, `withdraw`, `embark`.
    NOTE: `produce`/`collect`/`deposit`/`withdraw` are now DISEMBARKED-only
    (they were ungated "it's your base" before P10) — viewing the base
    (`storage`) stays informational, but ACTING on it requires being on foot.
  - **ANYTIME_OUT_OF_COMBAT** (either embark state, but NOT combat): `craft`
    (fabrication — cook food / make condensate), `jump` (free region nav; combat
    must not let you slip away).
  - **`eat`** is in the ALWAYS set (usable in every state incl. combat — you can
    always snack to heal).
- **Combat overrides everything**: while `inCombat`, only `attack`/`flee`/`eat`
  (+ informational) are applicable; all surface/economy/travel/base verbs are
  hidden in `help` and rejected by dispatch.
- **`renderHelp(state)`** (now takes state) lists `applicableVerbs(state)` minus
  aliases, preserving `VERBS` display order — still GENERATED from the registry,
  just state-filtered. **`handleHelp` threads `playerState(player)`**; the
  no-arg list is context-aware, and `help <command>` still fully describes any
  command but appends a muted `(<reason>)` note when it isn't usable now.
- **Dispatch gate** (`dispatchResolved`): `if (!isApplicable(verb, state))
  return errorFrame(inapplicableReason(verb, state))`. `inapplicableReason`
  derives the message from the SAME buckets (in-combat → "`attack`, `flee`, or
  `eat`"; combat verbs out of combat → "nothing to fight"; `embark`/`disembark`
  no-ops → "already aboard/on the surface"; else must-embark / must-disembark).
  Finer handler-level errors (e.g. `attack` with a stale encounter) still live
  in the handlers and stay CONSISTENT with the gate. You can still TYPE/abbrev
  any verb — inapplicable ones get the contextual rejection.
- **Parity is locked per-state** in `help-args.test.ts` (updated): for
  embarked/disembarked/combat, the `help`-listed set === applicable non-alias
  verbs, bidirectionally, and every listed verb is `isApplicable`. The seeded
  `context-help.test.ts` locks the `isApplicable`/`applicableVerbs` matrix.
- **Future commands declare applicability HERE**: add the verb to exactly one
  bucket in `applicability.ts` (alongside its `VERBS`+`USAGE` registration and
  `argDomain`/handler) — help-visibility and dispatch-gating both follow
  automatically.

### Load-bearing decisions from `biome-consistency`

- **Biome / temperature / hazard are now physically coherent.** All the new
  logic is PURE & deterministic in `src/lib/universe/gen.ts` (+ a `Region`
  reshape in `types.ts`) — **no schema/migration**; the only gameplay wiring is a
  damage-source + scan-render tweak in `commands.ts`/`render.ts`.
- **Temperature ← star brightness + orbital closeness** (`planetTemperatureFor(
  starClass, orbitalRadius, rng)`): `STAR_TEMP_BASE[starClass] + RADIUS_TEMP_COEF
  / orbitalRadius + jitter(±TEMP_JITTER)`. The deterministic part is MONOTONIC —
  hotter star ⇒ hotter, smaller radius ⇒ hotter (the `1/radius` insolation term).
  `RADIUS_TEMP_COEF = 120`, `TEMP_JITTER = 120`. **`orbitalRadius` is now drawn
  BEFORE temperature** in `generatePlanet` (the closeness term needs it); this
  replaced the old `STAR_TEMP_BASE + random`. Hazard is still `hazardFor(temp)`
  (temp-hazard coupling), computed off the new temperature — distribution is
  preserved (the `1/radius` term concentrates heat on rare close-in worlds, so
  the bulk stays star-driven and every existing universe test passes unmigrated).
- **Gas is exclusive (`["gas"]`).** `biomePaletteFor(rng, temperature)` rolls a
  `GAS_GIANT_CHANCE = 0.12` gas-giant up front (palette `["gas"]`); otherwise
  `gas` is filtered out of the candidate pool entirely. No planet is "part gas".
- **Palette SIZE ← temperature extremity.** `tempExtremity(temp)` ∈ [0,1] (0 when
  within ±`PALETTE_COMFORT`=40°C of the comfort mid 15°C, →1 over
  `PALETTE_EXTREME_SCALE`=130°C beyond). Size = `round(PALETTE_MAX −
  (PALETTE_MAX−PALETTE_MIN)·extremity + jitter)`, clamped to `[1, PALETTE_MAX]`.
  Moderate worlds reach 4; extreme worlds collapse toward 1. **`PALETTE_MIN` was
  lowered 2 → 1** (gas giants and extreme worlds are single-biome) — the existing
  `>= PALETTE_MIN` assertions still hold against the constant.
- **Palette COMPOSITION ← temperature affinity.** Each biome has a
  `BIOME_TEMP_AFFINITY` (+1 hot: volcanic/desert, −1 cold: tundra, 0 neutral);
  selection weight = `BIOME_WEIGHTS[b] · exp(AFFINITY_STRENGTH·affinity·tNorm)`
  (`AFFINITY_STRENGTH = 2.5`, `tNorm = (temp−15)/100`). Hot worlds downweight
  cold biomes / upweight hot, and vice-versa — so hot planets carry far fewer
  tundra regions than cold ones.
- **No oceans (or jungle) on extreme worlds.** When `temp > BOILING_C` (100) or
  `temp < FREEZING_C` (0), `ocean` AND `jungle` (the liquid/life biomes) are
  excluded from the candidate pool. (`gas` always excluded — it's the giant gate.)
- **Per-region temperature + hazard** (`Region` gained `temperature` and
  `hazard`): `region.temperature = clampRegionTemp(round1(planet.temperature +
  biomeTempOffset(biome)), planet.temperature)`; `region.hazard =
  clamp01(planet.hazard + biomeHazardOffset(biome))`. **`clampRegionTemp` keeps a
  region on the SAME side of 0/100 as its planet** (boiling planet → regions
  `> 100` via a `BAND_MARGIN`=0.1 push that survives 1-decimal rounding; freezing
  → `< 0`; moderate → `[0,100]`), so region variation can NEVER flip the
  planet-level landing category — the **landing gate stays planet-level**.
  Exported **`biomeTempOffset(biome)` / `biomeHazardOffset(biome)`** (from
  `@/lib/universe`) order extreme biomes above calm: volcanic↑ & tundra↓ temp;
  volcanic/irradiated/toxic ≥ 0 hazard; barren/gas neutral.
- **Deposits use the REGION's hazard** now (`depositsFor(rng, region.hazard,
  biome)` in `regionAt`) — the savage→rare rarity coupling bites per-region, so a
  volcanic region carries rarer ore than a calm one alongside it (biome rolled
  before temp/hazard/deposits so all three are deterministic per region coord).
- **Disembarked damage uses region hazard.** `mine`/`explore`/`disembark` in
  `commands.ts` roll `rollHazardDamage(region.hazard, …)` (was `planet.hazard`),
  and `scan` (`renderScan`) shows a `region temp / region hazard` line alongside
  the planet's mean — so "volcanic regions are more dangerous" actually bites.
- **Seeded contract**: `src/lib/universe/biome-consistency.test.ts` (gas
  exclusivity, temp monotone in star+radius, cold-biome-vs-temp, palette-size-vs-
  extremity, no-ocean-on-extreme, region band + offset ordering). The existing
  universe suites (universe-gen, planet-regions, biome-minerals, addressing)
  needed NO migration — the new distributions preserved their thresholds.
