#!/usr/bin/env bash
# clean-merged.sh — reap task worktrees whose PR is already merged.
#
# Usage:
#   make clean-merged            # dry-run: print what WOULD be reaped
#   make clean-merged APPLY=1    # actually run task-clean on each
#
# Dry-run by default. A worktree is reaped only when ALL hold:
#   - it lives under .claude/worktrees/<name>  (a managed task worktree)
#   - its branch's PR is MERGED on GitHub      (squash-safe: gates on PR state,
#     not `git merge-base --is-ancestor`, which a squash merge defeats)
#   - the local branch tip is CONTAINED in the merged PR head — i.e. there are
#     NO local commits beyond what was merged. This is the load-bearing guard:
#     a branch can be merged AND carry unpushed local work on top, and reaping
#     that would destroy the work. (Earlier a naive "working tree clean" check
#     did exactly that to a branch with an unpushed fix.)
#   - the working tree is clean                (no uncommitted local changes)
#   - the worktree is NOT active               (no running dev server / bound port)
# Anything else is KEPT with a printed reason. Active worktrees are tagged.

set -euo pipefail

apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI required" >&2; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)")"
wt_root="$repo/.claude/worktrees"

echo "→ fetching merged PRs from GitHub…"
# Map of head branch → the commit SHA that was on the PR head when it merged.
merged_map="$(gh pr list --state merged --limit 1000 --json headRefName,headRefOid \
  -q '.[] | .headRefName + "\t" + .headRefOid' 2>/dev/null || true)"
[[ -n "$merged_map" ]] || { echo "error: could not list merged PRs (gh auth / network?)" >&2; exit 1; }
# First match wins — gh lists most-recent first, so a reused branch name resolves
# to its latest merged PR head.
merged_head_oid() { awk -F'\t' -v b="$1" '$1==b{print $2; exit}' <<<"$merged_map"; }

# A worktree is "active" if a process is running from inside it, or its dev-server
# port (from .env.local) is being listened on.
is_active() {
  local path="$1" port
  pgrep -f "$path" >/dev/null 2>&1 && return 0
  port="$(awk -F= '/^PORT=/{print $2; exit}' "$path/.env.local" 2>/dev/null | tr -d '[:space:]')"
  [[ "$port" =~ ^[0-9]+$ ]] && lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0
  return 1
}

reap=()
active_kept=0

while IFS=$'\t' read -r path ref; do
  branch="${ref#refs/heads/}"
  name="$(basename "$path")"
  [[ "$path" == "$wt_root/$name" ]] || continue   # managed worktrees only
  [[ "$branch" == "main" || "$branch" == "master" ]] && continue

  tag=""; is_active "$path" && { tag=" [ACTIVE]"; }

  if [[ -z "$branch" || "$ref" != refs/heads/* ]]; then
    printf "  keep   %-32s detached HEAD%s\n" "$name" "$tag"; continue
  fi
  head_oid="$(merged_head_oid "$branch")"
  if [[ -z "$head_oid" ]]; then
    printf "  keep   %-32s PR not merged (open/none)%s\n" "$name" "$tag"; continue
  fi
  local_tip="$(git -C "$path" rev-parse HEAD 2>/dev/null || echo none)"
  if ! git -C "$path" merge-base --is-ancestor "$local_tip" "$head_oid" 2>/dev/null; then
    printf "  keep   %-32s has local commits beyond merged PR (unpushed)%s\n" "$name" "$tag"; continue
  fi
  if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
    printf "  keep   %-32s merged but has uncommitted changes%s\n" "$name" "$tag"; continue
  fi
  if [[ -n "$tag" ]]; then
    printf "  keep   %-32s merged + clean but ACTIVE (server running)\n" "$name"
    active_kept=$((active_kept + 1)); continue
  fi
  printf "  REAP   %-32s merged + clean + fully pushed\n" "$name"
  reap+=("$name")
done < <(git -C "$repo" worktree list --porcelain | awk '
  /^worktree /{wt=$2; br=""}
  /^branch /{br=$2}
  /^detached/{br="detached"}
  /^$/{if(wt!=""){print wt"\t"br; wt=""}}
  END{if(wt!=""){print wt"\t"br}}
')

echo ""
[[ $active_kept -gt 0 ]] && echo "($active_kept merged worktree(s) kept because they are ACTIVE — stop the server to reap them.)"
if [[ ${#reap[@]} -eq 0 ]]; then
  echo "Nothing to reap."
  exit 0
fi

if [[ $apply -eq 0 ]]; then
  echo "${#reap[@]} worktree(s) would be reaped. Re-run with APPLY=1 to remove them."
  exit 0
fi

echo "Reaping ${#reap[@]} worktree(s)…"
for name in "${reap[@]}"; do
  echo "── $name ──"
  # --force is safe here: we proved the local tip is contained in the merged PR
  # head (nothing unpushed) and the tree is clean. task-clean reads the
  # worktree's real branch, so a non-standard branch is cleaned correctly.
  "$script_dir/task-clean.sh" "$name" --force || echo "warning: task-clean failed for '$name'" >&2
done
echo "✓ done"
