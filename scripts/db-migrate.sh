#!/usr/bin/env bash
# ============================================================================
# db-migrate.sh — apply Omniplex SQL migrations to a target Postgres database.
# ============================================================================
# Applies every supabase/migrations/*.sql file, in filename (lexical) order,
# to the database named by DATABASE_URL. Tracks applied files in a
# `public.schema_migrations` table and skips ones already recorded. The
# migrations are themselves idempotent (create table if not exists,
# on conflict do nothing, create or replace function), so a re-run is safe
# even if the tracking table is dropped.
#
# This runner is psql-based and driven purely by a connection string, so it
# does NOT require the Supabase CLI to be installed or linked.
#
# NOTE: For deploys and for anyone without `psql`, prefer the Node runner
# `npm run db:migrate` (scripts/migrate.mjs) — Node-only (the `pg` package),
# runs automatically before `next start` on Railway, and uses the SAME
# `public.schema_migrations` table + filename-order logic as this script, so
# the two never diverge. This bash runner remains for psql users / --dry-run.
#
# Usage:
#   DATABASE_URL='postgresql://...' scripts/db-migrate.sh
#   scripts/db-migrate.sh --database-url 'postgresql://...'
#   scripts/db-migrate.sh --dry-run        # list pending migrations, apply nothing
#   scripts/db-migrate.sh --help
#
# Where to get DATABASE_URL: Supabase → Project Settings → Database →
# "Connection string" (URI). Use the value that includes your DB password.
# For Supabase, the pooled or direct connection both work for DDL; the direct
# (port 5432) string is the safest for migrations.
#
# Requirements: `psql` on PATH (Postgres client). Install via your package
# manager (e.g. `brew install libpq` / `apt-get install postgresql-client`).
#
# Exit codes: 0 success (incl. nothing-to-do); non-zero on misconfiguration or
# a failed migration (each file is applied in a single transaction).
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

DATABASE_URL="${DATABASE_URL:-}"
DRY_RUN=0

usage() {
  sed -n '2,37p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url)
      [[ $# -ge 2 ]] || { echo "error: --database-url needs a value" >&2; exit 1; }
      DATABASE_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unrecognized argument '$1'" >&2
      echo "try: scripts/db-migrate.sh --help" >&2
      exit 1 ;;
  esac
done

# --- Preconditions -----------------------------------------------------------
if [[ -z "$DATABASE_URL" ]]; then
  echo "error: DATABASE_URL is not set." >&2
  echo "  Set the env var or pass --database-url. Find it in Supabase under" >&2
  echo "  Project Settings → Database → Connection string (URI)." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "error: 'psql' not found on PATH." >&2
  echo "  Install the Postgres client, e.g. 'brew install libpq' or" >&2
  echo "  'apt-get install postgresql-client', then re-run." >&2
  exit 1
fi

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "error: migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

# Collect migration files in lexical order. Fail loudly if there are none.
shopt -s nullglob
MIGRATIONS=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob
if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  echo "error: no .sql files found in $MIGRATIONS_DIR" >&2
  exit 1
fi
IFS=$'\n' MIGRATIONS=($(sort <<<"${MIGRATIONS[*]}")); unset IFS

# psql invocation: fail on first SQL error, stop on error, quiet, no pager.
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet --no-psqlrc --pset pager=off)

# --- Ensure the tracking table exists ---------------------------------------
"${PSQL[@]}" >/dev/null <<'SQL'
create table if not exists public.schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);
SQL

# Which filenames are already recorded?
APPLIED="$("${PSQL[@]}" --tuples-only --no-align \
  -c 'select filename from public.schema_migrations;')"

is_applied() {
  local name="$1"
  grep -Fxq "$name" <<<"$APPLIED"
}

echo "── Omniplex db-migrate ─────────────────────────────────────────"
echo "  migrations : $MIGRATIONS_DIR"
echo "  found      : ${#MIGRATIONS[@]} file(s)"
[[ "$DRY_RUN" == "1" ]] && echo "  mode       : DRY RUN (no changes applied)"
echo "────────────────────────────────────────────────────────────────"

applied_count=0
skipped_count=0

for path in "${MIGRATIONS[@]}"; do
  name="$(basename "$path")"
  if is_applied "$name"; then
    echo "  skip   $name (already applied)"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  pending $name"
    applied_count=$((applied_count + 1))
    continue
  fi

  echo "  apply  $name"
  # Run the migration and record it in ONE transaction: if the SQL fails, the
  # insert is rolled back too, so the file is retried on the next run.
  {
    echo "begin;"
    cat "$path"
    printf "\ninsert into public.schema_migrations (filename) values (%s) on conflict (filename) do nothing;\n" \
      "$(printf "'%s'" "${name//\'/\'\'}")"
    echo "commit;"
  } | "${PSQL[@]}" >/dev/null
  applied_count=$((applied_count + 1))
done

echo "────────────────────────────────────────────────────────────────"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "  $applied_count pending, $skipped_count already applied."
else
  echo "  done: $applied_count applied, $skipped_count skipped."
fi
