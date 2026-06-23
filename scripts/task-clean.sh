#!/usr/bin/env bash
# task-clean.sh — remove a task worktree, its branches in both repos,
# and its Lobu CLI context entry.
#
# Usage:
#   scripts/task-clean.sh <name> [--force]
#
# Refuses by default when there is unfinished work:
#   - uncommitted changes in the lobu worktree or in packages/owletto
#   - commits on feat/<name> not pushed to origin
#
# Pass --force (or `make task-clean NAME=<name> FORCE=1`) to override.

set -euo pipefail

usage() {
  echo "usage: $0 <name> [--force]" >&2
  exit 1
}

force=0
name=""
for arg in "$@"; do
  case "$arg" in
    --force|-f) force=1 ;;
    -*) echo "error: unknown flag '$arg'" >&2; usage ;;
    *) [[ -z "$name" ]] && name="$arg" || usage ;;
  esac
done
[[ -n "$name" ]] || usage

if ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "error: name must be kebab-case: '$name'" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve `repo` to the main checkout, not whatever worktree the script
# happens to live inside. Same fix as task-setup.sh (#900) —
# `--git-common-dir --path-format=absolute` returns the shared .git path
# regardless of which worktree the call is made from, so invoking
# `make task-clean` from inside a worktree targets the right paths.
repo="$(dirname "$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)")"
worktree_dir="$repo/.claude/worktrees/$name"
default_branch="feat/$name"
branch="$default_branch"

# shellcheck source=scripts/lib/db-name.sh
. "$script_dir/lib/db-name.sh"

if [[ ! -d "$worktree_dir" ]]; then
  echo "error: no worktree at $worktree_dir" >&2
  exit 1
fi

# task-setup creates feat/<name>, but a worktree may sit on any branch. Clean up
# the branch it's ACTUALLY on (so a non-standard branch — revert/…, chore/… — is
# deleted, not silently left behind), keeping feat/<name> as the fallback.
actual_branch="$(git -C "$worktree_dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ -n "$actual_branch" ]] && branch="$actual_branch"

# Count commits on $branch that aren't reachable from $upstream. Echoes 0 when
# $upstream is missing (treats "no upstream" as "no proven publish"; caller
# may still bail elsewhere). Echoes a positive number if the branch is ahead.
ahead_of() {
  local gitdir="$1" upstream="$2"
  if ! git -C "$gitdir" rev-parse --verify "$upstream" >/dev/null 2>&1; then
    echo 0
    return
  fi
  git -C "$gitdir" rev-list --count "$upstream..$branch" 2>/dev/null || echo 0
}

if [[ $force -eq 0 ]]; then
  # Refresh remote-tracking refs so the "ahead of origin/<branch>" check below
  # doesn't trust a stale local ref (e.g. branch deleted on remote → we'd see
  # origin/<branch> at its old position and conclude 0 unpushed commits).
  (cd "$worktree_dir" && git fetch origin --prune --quiet) || true
  if [[ -d "$worktree_dir/packages/owletto" ]]; then
    (cd "$worktree_dir/packages/owletto" && git fetch origin --prune --quiet) || true
  fi

  if [[ -n "$(git -C "$worktree_dir" status --porcelain)" ]]; then
    echo "error: uncommitted changes in $worktree_dir (pass --force to discard)" >&2
    exit 1
  fi
  if [[ -d "$worktree_dir/packages/owletto" ]] \
     && [[ -n "$(git -C "$worktree_dir/packages/owletto" status --porcelain)" ]]; then
    echo "error: uncommitted changes in packages/owletto (pass --force to discard)" >&2
    exit 1
  fi

  ahead_lobu="$(ahead_of "$worktree_dir" "origin/$branch")"
  # When the branch was never pushed, fall back to "ahead of origin/main".
  if ! git -C "$worktree_dir" rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
    ahead_lobu="$(ahead_of "$worktree_dir" "origin/main")"
  fi
  if [[ "$ahead_lobu" != "0" ]]; then
    echo "error: lobu $branch has $ahead_lobu unpushed commit(s) (pass --force to discard)" >&2
    exit 1
  fi

  if [[ -d "$worktree_dir/packages/owletto" ]]; then
    ahead_owl="$(ahead_of "$worktree_dir/packages/owletto" "origin/$branch")"
    if ! git -C "$worktree_dir/packages/owletto" rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
      ahead_owl="$(ahead_of "$worktree_dir/packages/owletto" "origin/main")"
    fi
    if [[ "$ahead_owl" != "0" ]]; then
      echo "error: owletto $branch has $ahead_owl unpushed commit(s) (pass --force to discard)" >&2
      exit 1
    fi
  fi
fi

echo "→ removing worktree $worktree_dir"
git -C "$repo" worktree remove "$worktree_dir" --force

# Returns 0 if branch <b> in <gitdir> carries no local-only commits (its tip is
# reachable from origin/main, or equals its pushed remote ref). Used to protect
# the feat/<name> default below — we never auto-delete unpushed work.
branch_is_pushed() { # <gitdir> <b>
  local gitdir="$1" b="$2" tip
  tip="$(git -C "$gitdir" rev-parse "$b" 2>/dev/null)" || return 0
  git -C "$gitdir" merge-base --is-ancestor "$tip" origin/main 2>/dev/null && return 0
  git -C "$gitdir" rev-parse --verify "origin/$b" >/dev/null 2>&1 \
    && [[ "$tip" == "$(git -C "$gitdir" rev-parse "origin/$b")" ]] && return 0
  return 1
}

# Never delete a long-lived integration branch, even if a worktree was somehow
# moved onto it (removing the worktree first would free the ref, so `branch -D`
# would otherwise succeed and nuke main/master).
is_protected_branch() { case "$1" in main|master) return 0 ;; *) return 1 ;; esac; }

# Delete the branch the worktree was actually on. Safety for THIS branch is
# enforced upstream — the force=0 ahead-of-origin guard above, or clean-merged's
# merged-head gate — so by the time we get here, deleting it is sanctioned.
delete_actual() { # <gitdir> <label>
  local gitdir="$1" label="$2"
  if is_protected_branch "$branch"; then
    echo "→ refusing to delete protected $label branch '$branch'" >&2
    return 0
  fi
  if git -C "$gitdir" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "→ deleting $label branch $branch"
    git -C "$gitdir" branch -D "$branch"
  fi
}

# Also clean up the feat/<name> default when the worktree had been moved onto a
# different branch — but ONLY if it has no unpushed commits. The upstream guard
# never inspected this branch, so deleting it blind could discard work the user
# didn't target (exactly the failure mode that lost an unpushed fix earlier).
delete_default_if_pushed() { # <gitdir> <label>
  local gitdir="$1" label="$2"
  [[ "$default_branch" != "$branch" ]] || return 0
  is_protected_branch "$default_branch" && return 0
  git -C "$gitdir" show-ref --verify --quiet "refs/heads/$default_branch" || return 0
  if branch_is_pushed "$gitdir" "$default_branch"; then
    echo "→ deleting $label branch $default_branch (feat default, fully pushed)"
    git -C "$gitdir" branch -D "$default_branch"
  else
    echo "→ keeping $label branch $default_branch (has unpushed commits; delete manually if intended)" >&2
  fi
}

for spec in "$repo:lobu" "$repo/packages/owletto:owletto"; do
  gitdir="${spec%:*}"; label="${spec##*:}"
  [[ "$label" == "lobu" || -d "$gitdir" ]] || continue
  delete_actual "$gitdir" "$label"
  delete_default_if_pushed "$gitdir" "$label"
done

# Drop the per-branch dev database created by `make dev-db`. The name depends on
# how dev-db was invoked: `make dev-db` inside the worktree keys off the branch
# (lobu_feat_<name>), while `make dev-db NAME=<name>` keys off the bare name
# (lobu_<name>). Try every candidate — the bare name, the actual branch, and the
# feat/<name> default — via the shared `lobu_db_name` helper so the name can't
# drift from what dev-db created. Non-fatal: a missing DB or an unreachable
# Postgres just skips (cleanup must still finish).
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5418}" PGUSER="${PGUSER:-$USER}"
dropped_dbs=""
for raw in "$name" "$branch" "$default_branch"; do
  [[ -n "$raw" ]] || continue
  db="$(lobu_db_name "$raw")"
  case " $dropped_dbs " in *" $db "*) continue ;; esac
  dropped_dbs="$dropped_dbs $db"
  # Never drop a shared/long-lived DB: the integration-test DB, or the
  # main/master dev DBs (`make dev-db` on main creates lobu_main). Match EXACTLY —
  # a `*_test` glob would wrongly skip legitimate per-task DBs like
  # lobu_feature_test, and only these exact names are off-limits.
  case "$db" in
    lobu_test | lobu_main | lobu_master)
      echo "→ skipping protected database '$db'"; continue ;;
  esac
  exists="$(psql -tAc "select 1 from pg_database where datname='$db'" postgres 2>/dev/null || true)"
  [[ "$exists" == "1" ]] || continue
  # --force evicts a still-connected dev server; --if-exists guards the race.
  if dropdb --if-exists --force "$db" 2>/dev/null; then
    echo "→ dropped dev database '$db'"
  else
    echo "warning: failed to drop '$db' — drop it manually: dropdb --force $db" >&2
  fi
done

if command -v lobu >/dev/null 2>&1; then
  if lobu context rm "$name" >/dev/null 2>&1; then
    echo "→ removed Lobu context '$name'"
  else
    echo "warning: failed to remove Lobu context '$name' (already gone or CLI error)" >&2
  fi
else
  echo "warning: 'lobu' CLI not on PATH; skipping context removal" >&2
fi

echo "✓ cleaned up task '$name'"
