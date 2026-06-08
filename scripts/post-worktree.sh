# ============================================================================
# post-worktree.sh — sourced by Nimbus's new-worktree.sh after `npm install`.
# ============================================================================
# Runs INSIDE the freshly-created worktree (cwd = the new worktree). The
# caller exposes `$repo_root` (the main checkout) and `$worktree_path`.
#
# Purpose: copy gitignored local env files from the main checkout into the new
# worktree so `scripts/dev-instance.sh` can run without re-entering config.
#
# IMPORTANT: this file is SOURCED under `set -e`. A failing command here would
# abort new-worktree.sh, so every step is guarded and best-effort — never let
# a missing file or copy error propagate.
# ============================================================================

if [[ -n "${repo_root:-}" && -d "${repo_root}" ]]; then
  for _env in .env .env.local; do
    if [[ -f "${repo_root}/${_env}" && ! -f "./${_env}" ]]; then
      cp "${repo_root}/${_env}" "./${_env}" 2>/dev/null \
        && echo "post-worktree: copied ${_env} from main checkout" \
        || echo "post-worktree: could not copy ${_env} (skipping)"
    fi
  done
  unset _env
else
  echo "post-worktree: no main checkout env to copy (skipping)"
fi
