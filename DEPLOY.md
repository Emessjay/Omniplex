# Deploying Omniplex — Railway + Supabase

This is the end-to-end runbook for putting Omniplex into production. It
assumes no prior knowledge of the repo. The app is server-authoritative
Next.js (App Router) with all state in Supabase (Postgres + Auth +
Realtime), deployed on Railway.

Total time for a first deploy: ~20–30 minutes.

> **Local development?** You do not need any of this. See
> [`README.md` → Quickstart](README.md#quickstart): `cp .env.example
> .env.local`, fill in values (optional — the app builds and runs without
> Supabase), then `scripts/dev-instance.sh`.

---

## 0. Prerequisites

- A [Supabase](https://supabase.com) account.
- A [Railway](https://railway.app) account, with this repo pushed to a
  GitHub repo Railway can read.
- Nothing else to install for migrations: the default runner is
  Node-based (`npm run db:migrate`), so it works anywhere Node runs —
  including the Railway container, where migrations apply **automatically
  on every deploy**. `psql` is only needed if you prefer the legacy
  `scripts/db-migrate.sh` runner (`brew install libpq` / `apt-get install
  postgresql-client`). Neither runner needs the Supabase CLI.

---

## 1. Create the Supabase project

1. In the Supabase dashboard, **New project**. Pick a name, a strong
   database password (save it — you need it for the connection string),
   and a region close to where Railway will run.
2. Wait for provisioning to finish (~2 min).

### Where to find each credential

All four live under your project's settings:

| Credential                  | Dashboard location                                         | Used as env var                  |
| --------------------------- | ---------------------------------------------------------- | -------------------------------- |
| **Project URL**             | Project Settings → **API** → "Project URL"                 | `NEXT_PUBLIC_SUPABASE_URL`       |
| **Anon (public) key**       | Project Settings → **API** → "Project API keys" → `anon`   | `NEXT_PUBLIC_SUPABASE_ANON_KEY`  |
| **Service-role key**        | Project Settings → **API** → "Project API keys" → `service_role` | `SUPABASE_SERVICE_ROLE_KEY` |
| **DB connection string**    | Project Settings → **Database** → "Connection string" → URI | `DATABASE_URL` (runs migrations) |

> ⚠️ The **service-role key** and the **DB connection string** are secrets
> with full database access. Never expose them to the browser, never commit
> them. Only `NEXT_PUBLIC_*` vars are safe in client code.

> ⚠️ **Use the pooler connection string for `DATABASE_URL`**, not the
> direct host. In the dashboard pick the **Connection pooling** URI, which
> looks like
> `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
> Substitute the database password you set in step 1 for `[YOUR-PASSWORD]`.
> The pooler host is **IPv4-friendly**; the direct host
> (`db.<ref>.supabase.co`) is **IPv6-only** and will fail to connect from
> many environments (including the Railway container). The pooler works fine
> for DDL/migrations.

---

## 2. Database migrations (automatic on deploy)

The schema lives in [`supabase/migrations/`](supabase/migrations/) as
forward-only SQL files. **You do not need to apply these by hand for a
Railway deploy.** As long as `DATABASE_URL` is set on the Railway service
(see [step 4](#4-deploy-on-railway)), every deploy runs
`node scripts/migrate.mjs` **before** `next start`, so pending migrations
always apply before the app serves traffic — code can never ship ahead of
its schema.

The runner is:

- **Idempotent** — it tracks applied files in a `public.schema_migrations`
  table and skips ones already recorded; the migrations are themselves
  idempotent, so a re-run is harmless either way.
- **Advisory-locked** — the whole run is wrapped in a Postgres advisory
  lock, so two Railway instances booting at once can't race the same
  migration or double-apply.
- **Transactional per file** — each migration plus its tracking insert runs
  in one transaction; a failed migration rolls back and fails the deploy
  loudly (rather than serving a stale schema), and is retried next deploy.
- **Safe without config** — if `DATABASE_URL` is unset/empty it logs a
  warning and exits 0 (a no-op), so `npm install`, `npm run build`, and CI
  never hard-crash.

### Running migrations locally

The same Node runner works on your machine — no `psql` needed:

```bash
export DATABASE_URL='postgresql://postgres.<ref>:YOUR-PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres'
npm run db:migrate
```

It prints what it applied vs. skipped. Run it again any time you add a
migration file — already-applied ones are skipped.

### Alternatives

- **psql runner** — if you prefer `psql`, `scripts/db-migrate.sh` does the
  same thing (same `public.schema_migrations` table + filename order) and
  also offers `--dry-run`. See `scripts/db-migrate.sh --help`.
- **Manual** — or paste each file in `supabase/migrations/` — **in filename
  (lexical) order** — into the Supabase dashboard **SQL Editor**. The
  migrations are idempotent, so re-running is harmless.

---

## 3. Configure Supabase Auth (don't skip — magic-link login breaks without it)

Omniplex logs players in with **magic links**. The browser asks Supabase to
email a link back to `<your-app-origin>/auth/callback` (see
`src/components/LoginScreen.tsx`). Supabase only honors redirect targets on
its allowlist, so if you don't configure this, login silently fails —
players click the email link and land nowhere useful.

In the Supabase dashboard → **Authentication** → **URL Configuration**:

1. **Site URL** → your production app URL, e.g.
   `https://omniplex.up.railway.app` (you'll get this from Railway in
   step 4; come back and set it once you know it).
2. **Redirect URLs** (allowlist) → add **all** of these:
   - `https://<your-production-domain>/auth/callback`
   - `http://localhost:3000/auth/callback` (local dev)
   - `http://localhost:3001/auth/callback`,
     `http://localhost:3002/auth/callback`, … if you run multiple
     dev-instance worktrees (each `scripts/dev-instance.sh` uses a port
     `3000 + index`).

3. Make sure the **Email** provider is enabled (Authentication → Providers
   → Email). The default Supabase email sender works for testing; wire up a
   custom SMTP provider before real traffic.

---

## 3a. Google sign-in setup (optional — enables "Continue with Google")

The login screen shows a **"Continue with Google"** button alongside the
email form. It calls `supabase.auth.signInWithOAuth({ provider: "google" })`
and returns through the **same** `/auth/callback` route the magic-link flow
uses. Google's OAuth credentials live in **Supabase**, not the app — there
are **no new env vars** on the Railway service. If you skip this section the
button still renders, but clicking it surfaces a Supabase "provider not
enabled" error inline.

1. **Google Cloud Console** (https://console.cloud.google.com) → create or
   pick a project. Under **APIs & Services → OAuth consent screen**,
   configure the consent screen (User Type *External* for a public app; set
   the app name, support email, and your domain).
2. Under **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**, choose application type **Web application**.
3. Set the **Authorized redirect URI** to **Supabase's** callback:

   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

   For this project that is:

   ```
   https://rjfusrxkocbktskjkoli.supabase.co/auth/v1/callback
   ```

   > ⚠️ **This is the Supabase-hosted callback, NOT the app's
   > `/auth/callback`.** Google redirects to Supabase first; Supabase then
   > redirects back to the app's `/auth/callback`. Pasting the app URL here
   > is the #1 reason Google sign-in fails — don't mix them up.

4. Copy the generated **Client ID** and **Client secret** into Supabase →
   **Authentication → Providers → Google**, paste both, and **enable** the
   provider.
5. **No extra app redirect needed.** The app's existing Site URL / redirect
   allowlist from **step 3** (the `/auth/callback` entry) already covers the
   post-login return — Google users land back in the terminal through the
   same path as magic-link users and get a `players` row on first login.

---

## 4. Deploy on Railway

1. **New Project → Deploy from GitHub repo**, and pick this repo.
2. Railway detects [`railway.json`](railway.json) and uses it:
   - **Builder:** Nixpacks
   - **Build:** `npm run build`
   - **Start:** `node scripts/migrate.mjs && npm run start -- -p ${PORT}`
     — applies pending migrations, then boots the app (Railway injects
     `$PORT`; the app binds it)
   - **Health check:** `GET /api/health` (Railway waits for a 200 before
     routing traffic and uses it for liveness)
   - **Restart policy:** on failure, up to 10 retries
   - **Node version:** pinned to Node 22 via `engines.node` in
     `package.json` and `.node-version` / `.nvmrc`, so the Nixpacks build is
     reproducible.
3. **Set the service's environment variables** (Railway → your service →
   **Variables**). All four are required at runtime in production:

   | Variable                        | What it is                                        | Where it comes from                          |
   | ------------------------------- | ------------------------------------------------- | -------------------------------------------- |
   | `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL (safe to expose)             | Step 1 — Project Settings → API              |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key — RLS-scoped reads + Realtime (safe)     | Step 1 — Project Settings → API              |
   | `SUPABASE_SERVICE_ROLE_KEY`     | Service-role key — authoritative writes (secret)  | Step 1 — Project Settings → API              |
   | `WORLD_SEED`                    | Seed for deterministic universe generation        | You choose — see step 5                      |
   | `DATABASE_URL`                  | Postgres URI — runs migrations on every deploy (secret) | Step 1 — Project Settings → Database (**pooler** URI) |

   > ⚠️ **`DATABASE_URL` must be the Supabase _pooler_ connection string**
   > (`...pooler.supabase.com:5432`), **not** the direct
   > `db.<ref>.supabase.co` host — that host is IPv6-only and the Railway
   > container can't reach it. With `DATABASE_URL` set, the deploy's start
   > command runs `node scripts/migrate.mjs` before booting the app, so
   > migrations apply automatically (idempotent + advisory-locked — see
   > [step 2](#2-database-migrations-automatic-on-deploy)). If you leave it
   > unset, the app still boots but **no migrations run** — a schema lagging
   > behind the code is exactly the bug this guards against, so set it.

4. Trigger a deploy. Once it's live, copy the generated domain
   (e.g. `https://omniplex-production.up.railway.app`) and go back to
   **step 3** to set it as the Supabase **Site URL** and add its
   `/auth/callback` to the redirect allowlist.

5. Verify: open `https://<your-domain>/api/health` — you should see
   `{"status":"ok","supabase":"configured","missingEnv":[]}`. If
   `supabase` is `"unconfigured"` or `missingEnv` is non-empty, a required
   env var is missing on the service — fix it in **Variables** and redeploy.

---

## 5. `WORLD_SEED` guidance

`WORLD_SEED` seeds the deterministic procedural universe: the same seed +
coordinates always produce the same planet, and nothing about static planet
attributes is stored — they're recomputed from `hash(WORLD_SEED, coords)`.

**Set it once and never change it on a live game.** Changing the seed
re-rolls the entire universe, so every player's stored location and the
mutable world deltas (depletion, claims, discoveries, markets) would now
point at a *different* procedurally-generated world — silently corrupting
the shared game. Pick a stable string (any value works) at launch and leave
it. If you need a fresh universe, that's a new deployment + a reset database.

---

## 5a. Dev login (testing only)

Supabase's magic-link email round-trip (rate limits, SMTP setup) is painful
for solo testing. An **env-gated dev login** bypasses it: one click logs you
in as a fixed dev user with a *genuine* Supabase session (real `auth.users`
row, real cookies, RLS and `getOrCreatePlayer` all behave exactly as a real
login). The real magic-link flow is untouched.

> **⚠️  Leave this OFF for any real or public launch.** It lets anyone who can
> reach the URL sign in as the dev user with no email verification. It is gated
> on a **server-only** env var (never `NEXT_PUBLIC_*`), so it cannot be probed
> or toggled from the browser, and with the flag unset the `/auth/dev` route
> returns 404 and performs no auth. Do **not** set it in your production
> Railway service.

**Enable (e.g. a throwaway preview/staging service):**

| Variable | Value | Notes |
| --- | --- | --- |
| `OMNIPLEX_DEV_LOGIN` | `1` | Truthy enables it; unset / `0` / `false` / `off` / `no` disable it. |
| `OMNIPLEX_DEV_LOGIN_EMAIL` | `dev@omniplex.local` | Optional. The dev user's email; this is the default. |

Supabase must still be configured (the dev login mints a real session via the
service-role key). Once enabled, the login screen shows a **"dev login (skip
email)"** link; clicking it (or visiting `/auth/dev` directly) ensures the dev
user exists, signs you in, and drops you into the terminal. The dev user
appears in `auth.users` and gets a normal `players` row on first login.

To disable: remove `OMNIPLEX_DEV_LOGIN` (or set it to `0`) and redeploy — the
button disappears and the route goes inert.

---

## 6. Local-dev quickstart (pointer)

For day-to-day development you don't deploy at all:

```bash
cp .env.example .env.local     # fill in your Supabase values (optional)
scripts/dev-instance.sh        # isolated port, auto-picks 3000+
```

The app builds and runs **without** Supabase configured (clients init
lazily and only error when actually used), so you can work on the terminal
UI with no secrets. See [`README.md`](README.md) for the full quickstart and
the multi-worktree workflow.
