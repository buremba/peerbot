#!/usr/bin/env bash
# clean-merged.sh — reap task worktrees whose PR is already merged.
#
# Usage:
#   make clean-merged            # dry-run: print what WOULD be reaped
#   make clean-merged APPLY=1    # actually run task-clean on each
#
# Dry-run by default. A worktree is reaped only when ALL hold:
#   - it lives under .claude/worktrees/<name>  (a managed task worktree)
#   - its branch is exactly feat/<name>        (the task-setup convention)
#   - its PR is MERGED on GitHub               (the real gate — squash-safe,
#     unlike `git merge-base --is-ancestor`, which a squash merge defeats)
#   - the working tree is clean                (no uncommitted local work)
# Anything else is KEPT with a printed reason, so this never surprises you.

set -euo pipefail

apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI required" >&2; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)")"
wt_root="$repo/.claude/worktrees"

echo "→ fetching merged PRs from GitHub…"
merged="$(gh pr list --state merged --limit 1000 --json headRefName -q '.[].headRefName' 2>/dev/null || true)"
[[ -n "$merged" ]] || { echo "error: could not list merged PRs (gh auth / network?)" >&2; exit 1; }
is_merged() { grep -qxF "$1" <<<"$merged"; }

reap=()

# Parse `git worktree list --porcelain` into "<path>\t<branch>" for attached
# worktrees (detached HEADs print no branch line and are skipped).
while IFS=$'\t' read -r path ref; do
  branch="${ref#refs/heads/}"
  [[ "$branch" == "main" ]] && continue
  name="$(basename "$path")"
  # Only manage worktrees that live directly under .claude/worktrees/<name>.
  [[ "$path" == "$wt_root/$name" ]] || continue

  if [[ "$branch" != "feat/$name" ]]; then
    printf "  keep   %-32s non-standard branch (%s)\n" "$name" "$branch"
    continue
  fi
  if ! is_merged "$branch"; then
    printf "  keep   %-32s PR not merged (open/none)\n" "$name"
    continue
  fi
  if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
    printf "  keep   %-32s merged but has uncommitted changes\n" "$name"
    continue
  fi
  printf "  REAP   %-32s merged + clean\n" "$name"
  reap+=("$name")
done < <(git -C "$repo" worktree list --porcelain | awk '
  /^worktree /{wt=$2}
  /^branch /{print wt"\t"$2}
')

echo ""
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
  # --force is safe here: the merged-PR gate already proved the work is landed,
  # and we only reach this for a clean working tree.
  "$script_dir/task-clean.sh" "$name" --force || echo "warning: task-clean failed for '$name'" >&2
done
echo "✓ done"
