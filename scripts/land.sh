#!/usr/bin/env bash
# Wait for CI, verify the FULL branch-protection required list, then squash-merge.
# One blocking call instead of a poll loop plus a merge call.
#
# The safety this encodes: `gh pr checks` only lists checks that have STARTED.
# A required check that has not begun is absent from that output entirely — it
# does not read as "pending" — so `--admin` merges straight past it. This
# script diffs the reported set against the branch-protection list and refuses
# to merge while anything required is still missing.
#
#   make land N=3012              wait for green, then squash-merge
#   make land N=3012 CHECK_ONLY=1 wait and report, never merge
#
# TIMEOUT_MIN caps the wait (default 25).
set -uo pipefail

PR="${N:-}"
CHECK_ONLY="${CHECK_ONLY:-0}"
TIMEOUT_MIN="${TIMEOUT_MIN:-25}"

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1

if [ -z "$PR" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  PR="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number' 2>/dev/null)"
  [ -z "$PR" ] && {
    echo "no open PR for '$branch'; pass N=<pr>" >&2
    exit 1
  }
  echo "resolved PR #$PR from branch $branch"
fi

# The local branch must be the PR head, or the statuses you post land on a
# commit the PR does not contain.
head_sha="$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null)"
local_sha="$(git rev-parse HEAD)"
if [ -n "$head_sha" ] && [ "$head_sha" != "$local_sha" ]; then
  echo "!! local HEAD ($(git rev-parse --short HEAD)) != PR #$PR head (${head_sha:0:7})." >&2
  echo "   Push first — gate statuses would attach to the wrong commit." >&2
  exit 1
fi

required="$(gh api "repos/:owner/:repo/branches/main/protection/required_status_checks" \
  --jq '.contexts[]?' 2>/dev/null | sort)"
if [ -z "$required" ]; then
  echo "!! could not read branch protection; refusing to merge blind." >&2
  exit 1
fi
echo "required checks:"
echo "$required" | sed 's/^/  /'

echo
echo ">> waiting for checks on #$PR (timeout ${TIMEOUT_MIN}m)..."
# --watch is the blocking primitive: one call, returns when every check that
# has started reaches a terminal state.
timeout "${TIMEOUT_MIN}m" gh pr checks "$PR" --watch --interval 20 >/dev/null 2>&1
watch_rc=$?

# --watch returning is necessary but not sufficient: a required check may have
# started only after it returned, or never started at all. Re-verify the floor.
deadline=$(($(date +%s) + TIMEOUT_MIN * 60))
while :; do
  rollup="$(gh pr checks "$PR" --json name,state,link --jq '.[] | "\(.name)\t\(.state)\t\(.link)"' 2>/dev/null)"
  reported="$(echo "$rollup" | cut -f1 | sort -u)"
  missing="$(comm -23 <(echo "$required") <(echo "$reported") 2>/dev/null)"
  pending="$(echo "$rollup" | awk -F'\t' '$2=="PENDING" || $2=="QUEUED" || $2=="IN_PROGRESS"')"

  if [ -z "$missing" ] && [ -z "$pending" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo
    echo "!! TIMED OUT after ${TIMEOUT_MIN}m — not merging." >&2
    [ -n "$missing" ] && { echo "   never reported:" >&2; echo "$missing" | sed 's/^/     /' >&2; }
    [ -n "$pending" ] && { echo "   still running:" >&2; echo "$pending" | cut -f1 | sed 's/^/     /' >&2; }
    exit 1
  fi
  sleep 20
done

failed="$(echo "$rollup" | awk -F'\t' '$2=="FAILURE" || $2=="ERROR" || $2=="CANCELLED"')"
if [ -n "$failed" ]; then
  echo
  echo "!! FAILING checks — not merging:" >&2
  echo "$failed" | awk -F'\t' '{printf "   %-34s %s\n   %s\n", $1, $2, $3}' >&2
  echo >&2
  echo "   logs:  gh run view --log-failed --job <id>" >&2
  exit 1
fi

echo
echo "all $(echo "$required" | wc -l | tr -d ' ') required checks reported and green."

if [ "$CHECK_ONLY" = "1" ]; then
  echo "CHECK_ONLY=1 — stopping before merge."
  exit 0
fi

echo ">> squash-merging #$PR"
gh pr merge "$PR" --squash --admin || exit $?

merge_sha="$(gh pr view "$PR" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null)"
echo "merged. squash commit: ${merge_sha:-unknown}"
echo
echo "Prod-visible? Gate rollout on the SQUASH commit, not your branch head:"
echo "  git merge-base --is-ancestor ${merge_sha:-<sha>} \"\$DEPLOYED_SHA\""
[ "$watch_rc" -ne 0 ] && echo "(note: gh pr checks --watch exited $watch_rc; the floor check above is authoritative)"
exit 0
