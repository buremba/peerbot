#!/usr/bin/env bash
# One-call worktree context. Combines the related git and GitHub reads needed
# to answer "where am I and what have I changed?"
#
# Does not change the working tree or remote state. NOFETCH=1 skips the local
# origin-ref refresh, but a stale base has produced false PR-gate verdicts.
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "not inside a git worktree" >&2
  exit 1
}

BASE="${BASE:-origin/main}"
CAP=40

hdr() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

if [ "${NOFETCH:-}" != "1" ] && ! git fetch -q origin; then
  echo "origin fetch failed; rerun with NOFETCH=1 only if stale refs are acceptable" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "base is not a commit: $BASE" >&2
  exit 1
fi
merge_base="$(git merge-base "$BASE" HEAD)" || {
  echo "no merge base between $BASE and HEAD" >&2
  exit 1
}

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo '(none)')"
ahead_behind="$(git rev-list --left-right --count "$BASE...HEAD" 2>/dev/null || echo '? ?')"
behind="${ahead_behind%%	*}"
ahead="${ahead_behind##*	}"

hdr "WHERE"
printf 'worktree : %s\n' "$(pwd)"
printf 'branch   : %s   upstream: %s\n' "$branch" "$upstream"
printf 'vs %s : %s ahead, %s behind\n' "$BASE" "$ahead" "$behind"

hdr "WORKING TREE"
status="$(git status --short 2>/dev/null)"
if [ -z "$status" ]; then
  echo "clean"
else
  printf '%s\n' "$status" | head -"$CAP"
  n="$(printf '%s\n' "$status" | wc -l | tr -d ' ')"
  [ "$n" -gt "$CAP" ] && echo "... $((n - CAP)) more"
fi

hdr "CHANGED vs $BASE (committed + working tree; must equal intended files)"
files="$({
  git diff --name-only "$merge_base"
  git ls-files --others --exclude-standard
} | sort -u)"
if [ -z "$files" ]; then
  echo "(no changes)"
else
  printf '%s\n' "$files" | head -"$CAP"
  n="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  [ "$n" -gt "$CAP" ] && echo "... $((n - CAP)) more"
  printf '%s file(s) listed' "$n"
  tracked_stat="$(git diff --shortstat "$merge_base")"
  [ -n "$tracked_stat" ] && printf '; tracked diff:%s' "$tracked_stat"
  untracked_count="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
  [ "$untracked_count" -gt 0 ] && printf '; %s untracked' "$untracked_count"
  echo
fi

hdr "COMMITS not in $BASE"
commits="$(git log --oneline "$BASE..HEAD" 2>/dev/null | head -15)"
if [ -n "$commits" ]; then
  printf '%s\n' "$commits"
else
  echo "(none)"
fi

if git config --file .gitmodules --get-regexp path >/dev/null 2>&1; then
  hdr "SUBMODULE"
  git submodule status 2>/dev/null | head -5
  if ! git diff --quiet "$merge_base" -- packages/owletto 2>/dev/null; then
    echo "!! owletto pointer MOVED in this branch — ui-review applies."
    echo "   verify direction:"
    git diff "$merge_base" -- packages/owletto 2>/dev/null | grep -E '^[+-]Subproject' || true
  fi
fi

hdr "PR"
if ! pr="$(gh pr list --head "$branch" --state all --json number,state,title,url,isDraft \
  --jq '.[0] | select(.) | "\(.number)\t\(.state)\t\(.isDraft)\t\(.title)\t\(.url)"')"; then
  echo "!! could not query GitHub for this branch" >&2
  echo
  exit 1
fi
if [ -z "$pr" ]; then
  echo "no PR for $branch"
else
  IFS=$'\t' read -r num state draft title url <<<"$pr"
  printf '#%s  %s%s  %s\n%s\n' "$num" "$state" \
    "$([ "$draft" = "true" ] && echo ' (draft)')" "$title" "$url"

  required="$(gh api "repos/:owner/:repo/branches/main/protection/required_status_checks" \
    --jq '.contexts[]?' 2>/dev/null | sort -u)"
  required_rc=$?
  rollup="$(gh pr checks "$num" --required --json name,bucket \
    --jq '.[] | "\(.name)\t\(.bucket)"' 2>/dev/null)"

  if [ -n "$rollup" ]; then
    echo "--- required checks ---"
    printf '%s\n' "$rollup" | awk -F'\t' '{printf "  %-34s %s\n", $1, $2}' | sort | head -30
  fi
  if [ "$required_rc" -ne 0 ] || [ -z "$required" ]; then
    echo "!! could not read branch-protection required checks" >&2
    exit 1
  else
    # A required check that has not started is absent from `gh pr checks`.
    # Compare the configured floor with only merge-satisfying results.
    satisfied="$(printf '%s\n' "$rollup" | awk -F'\t' '$2=="pass" || $2=="skipping" {print $1}' | sort -u)"
    missing="$(comm -23 <(printf '%s\n' "$required") \
      <(printf '%s\n' "$satisfied") 2>/dev/null)"
    if [ -n "$missing" ]; then
      echo "!! REQUIRED but NOT MERGE-SATISFYING (missing, pending, or failed):"
      while IFS= read -r check; do printf '     %s\n' "$check"; done <<<"$missing"
    fi
  fi
fi
echo
