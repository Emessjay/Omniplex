# Omniplex

A browser-based, **text-interface sci-fi MMO** — one shared,
procedurally-generated universe rendered as a terminal. Explore savage
planets, harvest rare resources, build, research, and climb NPC empires.

This repository is the foundation scaffold: a Next.js + TypeScript +
Supabase skeleton with a custom terminal UI shell. **No gameplay yet** — the
terminal currently echoes input and the command pipeline is a stub seam that
later workers attach to. See [`DESIGN.md`](DESIGN.md) for the product shape,
MVP scope, and architecture.

## Stack

- **Next.js** (App Router) + **React** + **TypeScript** (strict)
- **Tailwind CSS** (v3) — dark-first terminal skin
- **Supabase** — Postgres + Auth + Realtime (server uses service-role, client
  uses anon)
- **Vitest** — unit tests for pure logic
- Deployed on **Railway**

## Quickstart

```bash
# 1. Install
npm install

# 2. Configure env (optional for local UI work — the app builds & runs
#    without Supabase; clients init lazily and only error when used).
cp .env.example .env.local
#    …then fill in values if you want a live Supabase.

# 3. Run on an isolated port (auto-picks the lowest free port >= 3000)
scripts/dev-instance.sh
#    → prints e.g.  url : http://localhost:3000

# 4. Test
npx vitest run
```

Open the printed URL and you'll see the terminal. Type `help` (or click it),
use ↑/↓ for command history, and press Tab for completion.

### Running multiple worktrees concurrently

Workers operate in sibling worktrees (`Omniplex-<slug>/`). Always launch via
`scripts/dev-instance.sh` rather than `npm run dev` so each instance gets its
own port:

```bash
scripts/dev-instance.sh        # auto-pick lowest free port
scripts/dev-instance.sh 2      # force index 2 → port 3002
scripts/dev-instance.sh --fresh  # clean → build → production start
```

`--fresh` is what the Nimbus critic preamble runs to defeat stale build/data
artefacts. If a worktree uses a live Supabase, point it at its **own**
project/schema via that worktree's `.env.local` so instances don't share
mutable game state.

## Environment variables

| Variable                        | Where    | Purpose                                          |
| ------------------------------- | -------- | ------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | both     | Supabase project URL                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser  | Anon key — RLS-scoped reads + Realtime only      |
| `SUPABASE_SERVICE_ROLE_KEY`     | server   | Service-role key — authoritative writes (secret) |
| `WORLD_SEED`                    | server   | Seed for deterministic universe generation       |

Never commit real secrets. `.env.local` is gitignored; `.env.example`
documents the names.

## Database

The SQL schema lives in [`supabase/migrations/`](supabase/migrations/). It
creates the MVP mutable-state tables (`players`, `inventory`, `resources`,
`world_deltas`, `discoveries`, `markets`), enables RLS (public read for world/
catalog/leaderboard rows; per-player read for own rows; all writes via the
service role), and seeds the resource catalog + a global market.

Apply it with the bundled, psql-based migration runner (no Supabase CLI
required) — it tracks applied files in `public.schema_migrations` and is safe
to re-run:

```bash
export DATABASE_URL='postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres'
scripts/db-migrate.sh            # apply pending migrations
scripts/db-migrate.sh --dry-run  # preview without applying
scripts/db-migrate.sh --help     # full usage
```

The connection string comes from Supabase → Project Settings → Database. A
manual SQL-editor fallback (and full context) is in [`DEPLOY.md`](DEPLOY.md).

## Deploying to Railway + Supabase

See **[`DEPLOY.md`](DEPLOY.md)** for the complete, numbered runbook: creating
the Supabase project and finding each credential, applying migrations,
configuring Supabase Auth redirect URLs (a real magic-link gotcha), the full
Railway setup with every env var, the `/api/health` health check, and
`WORLD_SEED` guidance.

A health check lives at `GET /api/health` — it returns `200` with
`{ "status": "ok", "supabase": "configured" | "unconfigured" }` and is wired
into `railway.json` as the deploy `healthcheckPath`. The Node major is pinned
(Node 22) via `engines.node` and `.node-version` / `.nvmrc` for reproducible
Nixpacks builds.

## Project layout

```
src/
  app/                     Next.js App Router (layout, page, globals.css)
  components/Terminal.tsx  Custom DOM terminal renderer (NOT xterm)
  lib/
    terminal/
      types.ts             RenderFrame model — the client⇄server wire format
      helpers.ts           Pure builders for render frames
      pipeline.ts          submitCommand() — the command-pipeline SEAM (stub)
      completion.ts        Tab-completion source (stub)
    supabase/
      client.ts            Browser (anon) client factory — lazy
      server.ts            Server (service-role) client factory — lazy
    utils.ts               cn() class-name helper
supabase/migrations/       SQL schema (forward-only)
scripts/
  dev-instance.sh          Per-worktree isolated launcher (+ --fresh)
  post-worktree.sh         Copies env into new worktrees (sourced by Nimbus)
```

See [`CLAUDE.md`](CLAUDE.md) §Conventions for the load-bearing decisions
downstream workers rely on (the `RenderFrame` shape, the pipeline seam, the
Supabase import paths, the migration naming convention).
