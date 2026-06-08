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
- `psql` (the Postgres client) on your machine, to run migrations:
  `brew install libpq` (macOS) or `apt-get install postgresql-client`
  (Debian/Ubuntu). The migration runner is psql-based and does **not**
  require the Supabase CLI.

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
| **DB connection string**    | Project Settings → **Database** → "Connection string" → URI | `DATABASE_URL` (migrations only) |

> ⚠️ The **service-role key** and the **DB connection string** are secrets
> with full database access. Never expose them to the browser, never commit
> them. Only `NEXT_PUBLIC_*` vars are safe in client code.

> The connection-string URI looks like
> `postgresql://postgres:[YOUR-PASSWORD]@db.<ref>.supabase.co:5432/postgres`.
> Substitute the database password you set in step 1 for `[YOUR-PASSWORD]`.
> Either the direct (port 5432) or pooled string works for DDL; the direct
> one is the safest for migrations.

---

## 2. Apply the database migrations

The schema lives in [`supabase/migrations/`](supabase/migrations/) as
forward-only SQL files. Apply them with the bundled runner, which tracks
applied files in a `public.schema_migrations` table and skips ones already
applied (and the migrations are themselves idempotent, so a re-run is safe
either way):

```bash
export DATABASE_URL='postgresql://postgres:YOUR-PASSWORD@db.<ref>.supabase.co:5432/postgres'
scripts/db-migrate.sh
```

It prints what it applied vs. skipped. Preview without changing anything:

```bash
scripts/db-migrate.sh --dry-run
```

`scripts/db-migrate.sh --help` documents all options. Run it again any time
you add a new migration file — already-applied ones are skipped.

### Manual fallback (no `psql`)

If you can't install `psql`, paste each file in
`supabase/migrations/` — **in filename (lexical) order** — into the Supabase
dashboard **SQL Editor** and run it. The migrations are idempotent, so
re-running is harmless. (Skipping the tracking table is fine in this path;
ordering is what matters.)

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

## 4. Deploy on Railway

1. **New Project → Deploy from GitHub repo**, and pick this repo.
2. Railway detects [`railway.json`](railway.json) and uses it:
   - **Builder:** Nixpacks
   - **Build:** `npm run build`
   - **Start:** `npm run start -- -p ${PORT}` (Railway injects `$PORT`;
     the app binds it)
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

   `DATABASE_URL` is **only** needed locally to run migrations (step 2); it
   does **not** need to be set on the Railway service.

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
