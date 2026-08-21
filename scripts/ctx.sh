#!/usr/bin/env bash
# One-call worktree context. Replaces the 5-8 separate git/gh calls an agent
# otherwise makes to answer "where am I and what have I changed" — a family
# that accounts for ~20% of all shell calls in this repo's agent transcripts.
# Every call re-reads the whole model context, so collapsing the family into
# one call is worth more than making any single call faster.
#
# Read-only. NOFETCH=1 skips the origin fetch (faster, but a stale base has
# produced false PR-gate verdicts before — the fetch is on by default).
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "not inside a git worktree" >&2
  exit 1
}

BASE="${BASE:-origin/main}"
CAP="${CAP:-40}"

hdr() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

[ "${NOFETCH:-}" = "1" ] || git fetch -q origin 2>/dev/null || true

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
  echo "$status" | head -"$CAP"
  n="$(echo "$status" | wc -l | tr -d ' ')"
  [ "$n" -gt "$CAP" ] && echo "... $((n - CAP)) more"
fi

hdr "CHANGED vs $BASE (this must equal your intended file list)"
files="$(git diff --name-only "$BASE...HEAD" 2>/dev/null)"
if [ -z "$files" ]; then
  echo "(no committed changes)"
else
  echo "$files" | head -"$CAP"
  n="$(echo "$files" | wc -l | tr -d ' ')"
  [ "$n" -gt "$CAP" ] && echo "... $((n - CAP)) more"
  git diff --shortstat "$BASE...HEAD" 2>/dev/null
fi

hdr "COMMITS not in $BASE"
git log --oneline "$BASE..HEAD" 2>/dev/null | head -15 || echo "(none)"

if git config --file .gitmodules --get-regexp path >/dev/null 2>&1; then
  hdr "SUBMODULE"
  git submodule status 2>/dev/null | head -5
  if ! git diff --quiet "$BASE...HEAD" -- packages/owletto 2>/dev/null; then
    echo "!! owletto pointer MOVED in this branch — ui-review applies."
    echo "   verify direction (a three-dot diff hides a backwards pointer):"
    git diff "$BASE...HEAD" -- packages/owletto 2>/dev/null | grep -E '^[+-]Subproject' || true
  fi
fi

hdr "PR"
pr="$(gh pr list --head "$branch" --state all --json number,state,title,url,isDraft \
  --jq '.[0] | select(.) | "\(.number)\t\(.state)\t\(.isDraft)\t\(.title)\t\(.url)"' 2>/dev/null)"
if [ -z "$pr" ]; then
  echo "no PR for $branch"
else
  IFS=$'\t' read -r num state draft title url <<<"$pr"
  printf '#%s  %s%s  %s\n%s\n' "$num" "$state" \
    "$([ "$draft" = "true" ] && echo ' (draft)')" "$title" "$url"

  required="$(gh api "repos/:owner/:repo/branches/main/protection/required_status_checks" \
    --jq '.contexts[]?' 2>/dev/null | sort)"
  rollup="$(gh pr checks "$num" --json name,state \
    --jq '.[] | "\(.name)\t\(.state)"' 2>/dev/null)"

  if [ -n "$rollup" ]; then
    echo "--- checks ---"
    echo "$rollup" | awk -F'\t' '{printf "  %-34s %s\n", $1, $2}' | sort | head -30
  fi
  if [ -n "$required" ]; then
    # The documented footgun: a required check that has not STARTED is absent
    # from `gh pr checks` entirely — it reads as "not pending", not as missing.
    # Merging --admin here bypasses a check that never reported.
    missing="$(comm -23 <(echo "$required") \
      <(echo "$rollup" | cut -f1 | sort -u) 2>/dev/null)"
    if [ -n "$missing" ]; then
      echo "!! REQUIRED but NOT YET REPORTING (do not --admin past these):"
      echo "$missing" | sed 's/^/     /'
    fi
  fi
fi
echo
