#!/usr/bin/env node
// ============================================================================
// migrate.mjs — apply Omniplex SQL migrations to a target Postgres database.
// ============================================================================
// The Node-based sibling of scripts/db-migrate.sh, written so it runs anywhere
// Node runs — local, CI, and the Railway Nixpacks container (whose Node runtime
// does NOT ship `psql`). It is wired into the deploy start path
// (`start:prod` → `node scripts/migrate.mjs && next start`) so migrations
// always apply BEFORE the app serves traffic — code can never ship ahead of
// its schema.
//
// Behaviour (kept byte-for-byte consistent with db-migrate.sh):
//   - reads DATABASE_URL from env (the Supabase pooler connection string);
//   - applies every supabase/migrations/*.sql file in filename (lexical)
//     order, tracking applied files in the SAME `public.schema_migrations`
//     table the bash runner uses, skipping ones already recorded;
//   - each migration runs in its own transaction (the file + the tracking
//     insert together), so a failure rolls back and is retried next deploy;
//   - the whole run is wrapped in a Postgres advisory lock so two instances
//     starting at once don't race the same migration;
//   - prints what it applied vs. skipped.
//
// Exit codes:
//   0  success, including nothing-to-do AND the no-op when DATABASE_URL is
//      unset/empty (so `npm install`, `npm run build`, CI, and a misconfigured
//      boot don't hard-crash — the health endpoint already flags missing
//      Supabase config, and DEPLOY.md instructs setting DATABASE_URL).
//   1  an actual migration failure (so a broken migration fails the deploy
//      loudly rather than serving stale schema), or a connection error.
//
// Usage:
//   DATABASE_URL='postgresql://...' node scripts/migrate.mjs
//   npm run db:migrate
// ============================================================================

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT_DIR, "supabase", "migrations");

// Fixed advisory-lock key. Arbitrary but STABLE — every instance of this
// runner (and only this runner) must agree on it for mutual exclusion to work.
// Derived once, hard-coded so it can never drift between deploys.
const ADVISORY_LOCK_KEY = 776699001122n;

/**
 * List migration files in filename (lexical) order. Pure aside from the
 * directory read; the ordering is the contract shared with db-migrate.sh.
 * Exported for unit testing.
 */
export async function listMigrations(dir = MIGRATIONS_DIR) {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!databaseUrl.trim()) {
    // No-op so build/test/CI and a misconfigured boot don't hard-crash.
    console.warn(
      "⚠️  migrate.mjs: DATABASE_URL is unset/empty — skipping migrations (no-op).\n" +
        "   This is expected during `npm install` / `npm run build` / CI.\n" +
        "   In production, set DATABASE_URL on the Railway service (the Supabase\n" +
        "   pooler connection string) so migrations apply on deploy. See DEPLOY.md.",
    );
    process.exit(0);
  }

  const migrations = await listMigrations();
  if (migrations.length === 0) {
    console.error(`error: no .sql files found in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  console.log("── Omniplex migrate ────────────────────────────────────────────");
  console.log(`  migrations : ${MIGRATIONS_DIR}`);
  console.log(`  found      : ${migrations.length} file(s)`);
  console.log("────────────────────────────────────────────────────────────────");

  const client = new pg.Client({ connectionString: databaseUrl });
  let applied = 0;
  let skipped = 0;

  try {
    await client.connect();

    // Serialize concurrent runners (e.g. two Railway instances booting at once)
    // so they don't race the same migration. Session-level lock; released in
    // `finally` and implicitly on disconnect.
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    try {
      // Same tracking table as db-migrate.sh — created with `if not exists`,
      // not a landed migration.
      await client.query(`
        create table if not exists public.schema_migrations (
          filename   text primary key,
          applied_at timestamptz not null default now()
        );
      `);

      const { rows } = await client.query(
        "select filename from public.schema_migrations",
      );
      const appliedSet = new Set(rows.map((r) => r.filename));

      for (const name of migrations) {
        if (appliedSet.has(name)) {
          console.log(`  skip   ${name} (already applied)`);
          skipped += 1;
          continue;
        }

        console.log(`  apply  ${name}`);
        const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");

        // File + tracking insert in ONE transaction: if the SQL fails, the
        // insert is rolled back too, so the file is retried on the next run.
        try {
          await client.query("begin");
          await client.query(sql);
          await client.query(
            "insert into public.schema_migrations (filename) values ($1) on conflict (filename) do nothing",
            [name],
          );
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw new Error(`migration failed: ${name}\n  ${err.message}`);
        }
        applied += 1;
      }
    } finally {
      await client
        .query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
        .catch(() => {});
    }

    console.log("────────────────────────────────────────────────────────────────");
    console.log(`  done: ${applied} applied, ${skipped} skipped.`);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

// Only run when invoked directly (`node scripts/migrate.mjs`), not when
// imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
