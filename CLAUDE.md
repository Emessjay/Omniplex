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
