#!/usr/bin/env bash
# task-setup.sh — prepare a paired-branch worktree for a new task.
#
# Usage:
#   make task-setup NAME=<name>       (recommended, team-friendly)
#   scripts/task-setup.sh <name>      (direct invocation)
#
#   <name>  kebab-case task slug (e.g. fix-sse-leak)
#
# Companion: `make task-clean NAME=<name> [FORCE=1]` removes the worktree,
# its branches in both repos, and the Lobu CLI context.
#
# Behavior (idempotent — re-running on an existing worktree refreshes .env
# and .env.local only):
#   1. Creates a lobu worktree at .claude/worktrees/<name> on branch feat/<name>.
#   2. Initializes packages/owletto submodule on a real named branch feat/<name>
#      (never detached HEAD — fixes the "we keep losing changes" bug).
#   3. Runs `bun install` after submodule init (avoids the bun.lock prune bug).
#   4. Copies .env from the main repo (gitignored secrets don't auto-carry into
#      a fresh worktree, so `make dev` / `lobu run` would otherwise fail at boot).
#   5. Writes .env.local with PORT / WORKER_PROXY_PORT picked to avoid collisions
#      with other worktrees and the main repo (which defaults to 8787 / 8118).
#   6. Drops a .task marker file at the worktree root so `git worktree list`
#      can distinguish human task-worktrees from agent-* isolation worktrees.
#
# Optional shell-function sugar — `make task-setup` does the setup, then you
# still have to `cd <path> && claude` by hand. If you want one command that
# also moves your shell and launches claude, add this to ~/.zshrc:
#
#   task-start() {
#     local name="$1"; local repo="$HOME/Code/lobu"
#     "$repo/scripts/task-setup.sh" "$name" || return $?
#     cd "$repo/.claude/worktrees/$name" && exec claude
#   }
#   task-resume() {
#     local name="$1"; local repo="$HOME/Code/lobu"
#     [[ -d "$repo/.claude/worktrees/$name" ]] \
#       || { echo "no such worktree: $name"; return 1; }
#     cd "$repo/.claude/worktrees/$name" && exec claude
#   }
#
# The cd + exec must live in the shell function (not a Makefile target or this
# script) so that the parent terminal actually moves and Warp/iTerm detect the
# new working directory.

set -euo pipefail

usage() {
  echo "usage: $0 <name>" >&2
  echo "  <name>  kebab-case task slug (lowercase letters/digits, hyphens)" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
name="$1"

if ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "error: name must be kebab-case: '$name'" >&2
  exit 1
fi

# Reserve names that match the built-in Lobu CLI contexts so `task-setup` never
# clobbers a global context (it calls `lobu context add <name>`, which would
# overwrite the entry — and `lobu context rm` refuses the default, so cleanup
# wouldn't recover). Keep this list in sync with the contexts most users have.
case "$name" in
  lobu|dev|local)
    echo "error: '$name' is a reserved CLI context name; pick a feature slug" >&2
    exit 1
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Always resolve `repo` to the main checkout, not the cwd we were invoked
# from. Worktrees share the full working tree (scripts/ included), so a naive
# `$script_dir/..` resolves to whatever worktree the user happened to be
# inside when they ran `make task-setup`. That landed new worktrees at
# <calling-worktree>/.claude/worktrees/<name>/ — nested instead of flat,
# and `make task-clean` of the outer one would then refuse on (or rm -rf
# through) the inner ones.
#
# `git rev-parse --git-common-dir` returns the SHARED .git directory (the
# main repo's .git path) regardless of which worktree the call is made from.
# Its parent is the main checkout — exactly what we want for both the
# `git worktree add` target and the `.env` source.
#
# `--path-format=absolute` is load-bearing. Without it, `--git-common-dir`
# returns a path relative to git's cwd ("../.git"), and `dirname` of that
# resolves against whatever directory the caller happens to be in — landing
# the worktree at the wrong path (e.g. /Users/burakemre/Code instead of
# /Users/burakemre/Code/lobu when run from the main checkout). The absolute
# form makes the resolution invariant.
repo="$(dirname "$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)")"
worktree_dir="$repo/.claude/worktrees/$name"
branch="feat/$name"

refresh_only=0
if [[ -d "$worktree_dir" ]]; then
  echo "→ worktree exists; refreshing .env + .env.local only"
  refresh_only=1
fi

if [[ $refresh_only -eq 0 ]]; then
  echo "→ creating lobu worktree: $worktree_dir on $branch"
  (cd "$repo" && git fetch origin --quiet)
  if (cd "$repo" && git show-ref --verify --quiet "refs/heads/$branch"); then
    (cd "$repo" && git worktree add "$worktree_dir" "$branch")
  else
    (cd "$repo" && git worktree add "$worktree_dir" -b "$branch" origin/main)
  fi

  echo "→ preparing packages/owletto submodule on $branch (real branch, not detached)"
  (cd "$worktree_dir" && git submodule update --init packages/owletto)
  # Branch from the submodule HEAD (the SHA the parent pins), NOT origin/main —
  # the pin and origin/main can differ, and using origin/main here would
  # silently bump the submodule pointer in the new worktree.
  (
    cd "$worktree_dir/packages/owletto"
    git fetch origin --quiet
    if git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
      git switch -c "$branch" --track "origin/$branch"
    elif git show-ref --verify --quiet "refs/heads/$branch"; then
      git switch "$branch"
    else
      git switch -c "$branch" HEAD
    fi
  )

  echo "→ bun install"
  (cd "$worktree_dir" && bun install)
fi

if [[ -f "$repo/.env" ]]; then
  cp "$repo/.env" "$worktree_dir/.env"
  echo "→ copied .env from main repo"
else
  echo "warning: no .env in $repo — worktree will lack secrets" >&2
fi

highest_port=8787
highest_proxy=8118
shopt -s nullglob
for env_local in "$repo"/.claude/worktrees/*/.env.local; do
  [[ "$env_local" == "$worktree_dir/.env.local" ]] && continue
  p="$(awk -F= '/^PORT=/{print $2; exit}' "$env_local" | tr -d '[:space:]')"
  q="$(awk -F= '/^WORKER_PROXY_PORT=/{print $2; exit}' "$env_local" | tr -d '[:space:]')"
  [[ -n "$p" && "$p" =~ ^[0-9]+$ && "$p" -gt "$highest_port" ]] && highest_port="$p"
  [[ -n "$q" && "$q" =~ ^[0-9]+$ && "$q" -gt "$highest_proxy" ]] && highest_proxy="$q"
done
shopt -u nullglob

if [[ -f "$worktree_dir/.env.local" ]] \
   && existing_port="$(awk -F= '/^PORT=/{print $2; exit}' "$worktree_dir/.env.local" | tr -d '[:space:]')" \
   && [[ "$existing_port" =~ ^[0-9]+$ ]]; then
  port="$existing_port"
  proxy="$(awk -F= '/^WORKER_PROXY_PORT=/{print $2; exit}' "$worktree_dir/.env.local" | tr -d '[:space:]')"
  [[ "$proxy" =~ ^[0-9]+$ ]] || proxy=$((highest_proxy + 1))
else
  port=$((highest_port + 1))
  proxy=$((highest_proxy + 1))
fi

cat > "$worktree_dir/.env.local" <<EOF
PORT=$port
WORKER_PROXY_PORT=$proxy
LOBU_TASK_NAME=$name
EOF
echo "→ .env.local: PORT=$port WORKER_PROXY_PORT=$proxy"

echo "$name" > "$worktree_dir/.task"

# Auto-activate this worktree for the Chrome extension / Mac app (symlink swap).
# Safe / idempotent — task-use.sh re-points existing symlinks each time.
"$repo/scripts/task-use.sh" "$name" || true

# Register the worktree as a Lobu CLI context so the Mac menubar can spawn
# `lobu run` for it (lifecycle: managed) against the worktree's source. Safe to
# re-run — `lobu context add` overwrites the existing entry. Non-fatal: the
# worktree is still useful even if the lobu CLI isn't on PATH yet.
if command -v lobu >/dev/null 2>&1; then
  if lobu context add "$name" \
       --api-url "http://localhost:$port" \
       --port "$port" \
       --cwd "$worktree_dir" \
       --lifecycle managed >/dev/null; then
    echo "→ registered Lobu context '$name' (menubar can spawn its server)"
  else
    echo "warning: failed to register Lobu context '$name'" >&2
  fi
else
  echo "warning: 'lobu' CLI not on PATH; skipping context registration" >&2
fi

cat <<EOF

✓ Worktree ready: $worktree_dir

  lobu branch:       $branch
  owletto branch:    $branch (real named branch, not detached HEAD)
  PORT:              $port
  WORKER_PROXY_PORT: $proxy

When pushing owletto changes:
  1. Push owletto FIRST so the SHA is reachable on origin:
       git -C $worktree_dir/packages/owletto push -u origin $branch
  2. THEN bump the submodule pointer in lobu:
       git -C $worktree_dir add packages/owletto
       git -C $worktree_dir commit -m "chore: bump owletto pointer"
       git -C $worktree_dir push -u origin $branch

Launch via the task-start shell function (recommended; see script header),
or manually: cd $worktree_dir && claude
EOF
