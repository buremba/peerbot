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
branch="feat/$name"

if [[ ! -d "$worktree_dir" ]]; then
  echo "error: no worktree at $worktree_dir" >&2
  exit 1
fi

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

if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "→ deleting lobu branch $branch"
  git -C "$repo" branch -D "$branch"
fi

if [[ -d "$repo/packages/owletto" ]] \
   && git -C "$repo/packages/owletto" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "→ deleting owletto branch $branch"
  git -C "$repo/packages/owletto" branch -D "$branch"
fi

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
