#!/usr/bin/env bash
# ============================================================================
# dev-instance.sh — launch this worktree's Omniplex app on an isolated port.
# ============================================================================
# Workers run in concurrent sibling worktrees (Omniplex-<slug>/). Launching
# each via `npm run dev` directly would make them all fight over port 3000.
# This script assigns each instance a unique port so parallel worktrees
# coexist.
#
# Isolation notes:
#   * HTTP port — derived from an instance index (3000 + index). This is the
#     one hard collision between concurrent `next dev`/`next start` processes,
#     and the one this script owns.
#   * Build output (.next) — already per-worktree (separate directories), so
#     no isolation needed beyond what git worktrees give us.
#   * Supabase — the app runs WITHOUT a live Supabase connection (clients init
#     lazily), so there is no DB collision by default. If a worktree points at
#     a real Supabase, give it its OWN project/schema via that worktree's
#     .env.local (NEXT_PUBLIC_SUPABASE_URL etc.) so instances don't share
#     mutable game state.
#
# Usage:
#   scripts/dev-instance.sh [INDEX]        # dev server (hot reload)
#   scripts/dev-instance.sh --fresh [INDEX] # clean -> build -> production start
#
# INDEX is optional; if omitted, the lowest free port (>= 3000) is auto-picked.
# --fresh is used by the critic preamble to defeat stale build/data artefacts.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BASE_PORT=3000
MAX_INDEX=32
FRESH=0
INDEX=""

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) FRESH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        INDEX="$1"; shift
      else
        echo "error: unrecognized argument '$1'" >&2
        echo "try: scripts/dev-instance.sh [--fresh] [INDEX]" >&2
        exit 1
      fi
      ;;
  esac
done

# Is a TCP port already accepting connections / listening?
port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z localhost "$p" >/dev/null 2>&1
  else
    # No probe available; assume free.
    return 1
  fi
}

# Pick the lowest free index if none was given.
if [[ -z "$INDEX" ]]; then
  for i in $(seq 0 "$MAX_INDEX"); do
    if ! port_in_use "$((BASE_PORT + i))"; then
      INDEX="$i"
      break
    fi
  done
  if [[ -z "$INDEX" ]]; then
    echo "error: no free port found in ${BASE_PORT}..$((BASE_PORT + MAX_INDEX))" >&2
    exit 1
  fi
fi

PORT="$((BASE_PORT + INDEX))"
URL="http://localhost:${PORT}"

# Ensure dependencies are present (worktrees auto-install, but be defensive).
if [[ ! -d node_modules ]]; then
  echo "node_modules missing — running npm install…"
  npm install
fi

if [[ "$FRESH" == "1" ]]; then
  echo "── Omniplex [fresh] ────────────────────────────────────────────"
  echo "  index : $INDEX"
  echo "  port  : $PORT"
  echo "  url   : $URL"
  echo "  mode  : clean → build → start (production)"
  echo "────────────────────────────────────────────────────────────────"
  rm -rf .next
  npm run build
  exec npx next start -p "$PORT"
else
  echo "── Omniplex [dev] ──────────────────────────────────────────────"
  echo "  index : $INDEX"
  echo "  port  : $PORT"
  echo "  url   : $URL"
  echo "  mode  : next dev (hot reload)"
  echo "────────────────────────────────────────────────────────────────"
  exec npx next dev -p "$PORT"
fi
