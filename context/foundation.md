# Foundation & Infrastructure

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

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

### Load-bearing decisions from `manifolds` (a top coordinate tier above galaxy — isolated parallel data layers)

- **`manifold` is the NEW top tier of the spatial hierarchy**: `manifold → galaxy
  → arm → cluster → system → planet → region`. A manifold is a **parallel DATA
  LAYER** — a pure partition: generation is manifold-INVARIANT (manifold −1
  produces byte-identical worlds/flora/fauna to manifold 0 — same seed, same
  content), but every stored row keys by manifold and **there is NO travel between
  manifolds**, so a manifold is an airtight isolated slice of the universe inside
  the SAME Supabase project. **Prod = manifold 0; the staging/test universe = −1.**
  Mirrors `addressing-overhaul` (the coord-tier-addition + key-migration template).
- **Coords**: `manifold: number` is the FIRST field of `ClusterCoord`/
  `SystemCoord`/`PlanetCoord`/`RegionCoord` (`types.ts`). 0 = prime/prod, −1 =
  test; any integer valid (future manifolds positive).
- **Keys gain a leading manifold segment** (`gen.ts`): `systemKey` →
  `"<manifold>:<galaxy>:<arm>:<cluster>:<system>"` (5 seg), `planetKey` +`:planet`
  (6), `regionKey` +`:region` (7). `parseLocationKey` now parses 5/6/7-seg only
  (old 4/5/6 were migrated to the `0:`-prefixed form). These remain the
  `world_deltas`/`discoveries`/`bases`/`salvaged_sites`/`markets`/`system_supply`
  keys → all shared-world state partitions by manifold automatically.
- **Generation is manifold-INVARIANT — `manifold` NEVER seeds an RNG** (`makeRng`
  calls are UNCHANGED). Gen functions only PROPAGATE the input coord's `manifold`
  onto returned coords (e.g. `genome.ts` `manifold: coord.manifold`) so keys land
  in the right partition. ⇒ identical worlds across manifolds (the approved "pure
  partition"; folding manifold into the seed for true alternate-universe content
  is a DEFERRED future enhancement). **`warpDistance` returns `Infinity` across
  manifolds** (like cross-galaxy) — uncrossable.
- **`players.manifold integer not null default 0`** (migration
  `20260612000000_manifolds.sql`) on `Player`/`PlayerRow`/`rowToPlayer`. **Travel
  NEVER changes manifold** (`warp`/`hyperwarp`/`orbit`/`land`/`jump`/`move` build
  targets with the player's current manifold; no command crosses manifolds — the
  crossing "unique mechanic" is DEFERRED). Isolation by construction.
- **Spawn config**: `spawnManifold(env?)` in `src/lib/game/config.ts` parses
  **`OMNIPLEX_SPAWN_MANIFOLD`** (server-only, integer, **default 0**, non-int →
  0, never read at import). `getOrCreatePlayer` stamps it on insert via
  `randomStartingWorld(seed, rand, manifold)` (+ `startingWorld(seed, manifold=0)`
  gained the param). Prod unset → 0; **staging sets `-1`** → test accounts born in
  the isolated test universe.
- **Presence + leaderboard are manifold-scoped**: `presence.ts` `LocationView`/
  `sameLocation` include `manifold` (and `presenceChannelFor` → `loc:<manifold>:…`,
  so live presence/chat is per-manifold); `world.playersHere` filters
  `.eq("manifold", …)`; the public `leaderboard` view EXPOSES `manifold`
  (appended LAST — the `CREATE OR REPLACE VIEW` append-only constraint, same as
  cartography) and `topByCredits(limit, manifold)`/`who` filter by the viewer's
  manifold. So −1 and 0 players are mutually invisible; test accounts never appear
  on prod's board.
- **Migration** (forward-only/idempotent, runner-tracked → runs once): adds
  `manifold`; prefixes existing `world_deltas`/`discoveries`/`bases`/
  `salvaged_sites`/`system_supply` keys + non-`'global'` `markets` keys with `0:`;
  **resets `completed_contracts`/`completed_bounties`** (their keys embed a hub
  systemKey — a non-destructive double-fulfill-guard reset, players just re-see the
  current rotation); recreates the leaderboard view with `manifold`.
- **This is the test-isolation foundation** for the pillars push (built + played
  in manifold −1, promoted to main = manifold 0). **Deferred & noted**: the
  manifold-CROSSING mechanic + manifold-in-RNG generation MODIFIERS (true alternate
  universes). DEPLOY.md §7 documents the one-Supabase staging model.
