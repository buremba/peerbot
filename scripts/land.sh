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

case "$CHECK_ONLY" in
  0 | 1) ;;
  *)
    echo "CHECK_ONLY must be 0 or 1, got: $CHECK_ONLY" >&2
    exit 1
    ;;
esac
case "$TIMEOUT_MIN" in
  '' | *[!0-9]*)
    echo "TIMEOUT_MIN must be a positive integer, got: $TIMEOUT_MIN" >&2
    exit 1
    ;;
esac
if [ "$TIMEOUT_MIN" -eq 0 ]; then
  echo "TIMEOUT_MIN must be greater than zero" >&2
  exit 1
fi

if [ -z "$PR" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if ! PR="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number')"; then
    echo "could not query GitHub for an open PR on '$branch'" >&2
    exit 1
  fi
  [ -z "$PR" ] && {
    echo "no open PR for '$branch'; pass N=<pr>" >&2
    exit 1
  }
  echo "resolved PR #$PR from branch $branch"
fi

verify_pr_head() {
  local head_sha local_sha
  if ! head_sha="$(gh pr view "$PR" --json headRefOid --jq .headRefOid)" || [ -z "$head_sha" ]; then
    echo "!! could not read PR #$PR head; refusing to merge blind." >&2
    return 1
  fi
  local_sha="$(git rev-parse HEAD)"
  if [ "$head_sha" != "$local_sha" ]; then
    echo "!! local HEAD ($(git rev-parse --short HEAD)) != PR #$PR head (${head_sha:0:7})." >&2
    echo "   Push first so the reviewed local commit is the PR head." >&2
    return 1
  fi
}

read_required() {
  gh api "repos/:owner/:repo/branches/main/protection/required_status_checks" \
    --jq '.contexts[]?' | sort -u
}

verify_pr_head || exit 1

if ! required="$(read_required)" || [ -z "$required" ]; then
  echo "!! could not read branch protection; refusing to merge blind." >&2
  exit 1
fi
echo "required checks:"
while IFS= read -r check; do printf '  %s\n' "$check"; done <<<"$required"

echo
echo ">> waiting for checks on #$PR (timeout ${TIMEOUT_MIN}m)..."
deadline=$(($(date +%s) + TIMEOUT_MIN * 60))
while :; do
  rollup="$(gh pr checks "$PR" --required --json name,bucket,link \
    --jq '.[] | "\(.name)\t\(.bucket)\t\(.link)"' 2>/dev/null)"
  reported="$(printf '%s\n' "$rollup" | cut -f1 | sed '/^$/d' | sort -u)"
  satisfied="$(printf '%s\n' "$rollup" \
    | awk -F'\t' '$2=="pass" || $2=="skipping" {print $1}' | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$required") \
    <(printf '%s\n' "$reported") 2>/dev/null)"
  unsatisfied="$(comm -23 <(printf '%s\n' "$required") \
    <(printf '%s\n' "$satisfied") 2>/dev/null)"
  failed="$(printf '%s\n' "$rollup" | awk -F'\t' '$2=="fail" || $2=="cancel"')"
  pending="$(printf '%s\n' "$rollup" | awk -F'\t' '$2=="pending" {print $1}')"
  unknown="$(printf '%s\n' "$rollup" \
    | awk -F'\t' '$2!="pass" && $2!="skipping" && $2!="pending" && $2!="fail" && $2!="cancel"')"

  if [ -n "$failed" ]; then
    echo
    echo "!! FAILING checks — not merging:" >&2
    printf '%s\n' "$failed" \
      | awk -F'\t' '{printf "   %-34s %s\n   %s\n", $1, $2, $3}' >&2
    exit 1
  fi
  protection_refresh_failed=0
  if [ -z "$unsatisfied" ] && [ -z "$pending" ] && [ -z "$unknown" ]; then
    if ! current_required="$(read_required)" || [ -z "$current_required" ]; then
      protection_refresh_failed=1
    elif [ "$current_required" = "$required" ]; then
      break
    else
      echo "branch-protection requirements changed while waiting; using the new floor."
      required="$current_required"
    fi
  fi
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    echo
    echo "!! TIMED OUT after ${TIMEOUT_MIN}m — not merging." >&2
    if [ "$protection_refresh_failed" -eq 1 ]; then
      echo "   could not refresh branch protection" >&2
    fi
    if [ -n "$missing" ]; then
      echo "   never reported:" >&2
      while IFS= read -r check; do printf '     %s\n' "$check"; done <<<"$missing" >&2
    fi
    if [ -n "$pending" ]; then
      echo "   still running:" >&2
      while IFS= read -r check; do printf '     %s\n' "$check"; done <<<"$pending" >&2
    fi
    if [ -n "$unknown" ]; then
      echo "   unknown check states:" >&2
      printf '%s\n' "$unknown" | awk -F'\t' '{printf "     %s (%s)\n", $1, $2}' >&2
    fi
    exit 1
  fi
  sleep_for=$((deadline - now))
  [ "$sleep_for" -gt 20 ] && sleep_for=20
  sleep "$sleep_for"
done

echo
echo "all $(printf '%s\n' "$required" | wc -l | tr -d ' ') required checks are merge-satisfying."

# The PR can be updated during the wait. Do not merge a different commit than
# the one inspected in this worktree.
verify_pr_head || exit 1

if [ "$CHECK_ONLY" = "1" ]; then
  echo "CHECK_ONLY=1 — stopping before merge."
  exit 0
fi

echo ">> squash-merging #$PR"
gh pr merge "$PR" --squash --admin || exit $?

merge_sha="$(gh pr view "$PR" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null)"
echo "merged. squash commit: ${merge_sha:-unknown}"

# Merging is the only event that retires a task worktree, and nothing is wired
# to it: `task-clean` exists but only ever runs when someone types it, so a
# merged branch leaves a multi-GB worktree and a Daytona sandbox that keeps
# billing for disk against the org ceiling until the next `make sandbox` fails
# on quota. Deliberately a hint and not an action — the worktree is often still
# needed after the merge to verify the rollout, and this may be running from
# inside the very directory it would remove.
report_cleanup() {
  local head worktree slug
  head="$(gh pr view "$PR" --json headRefName --jq .headRefName 2>/dev/null)" || return 0
  [ -n "$head" ] || return 0
  worktree="$(git worktree list --porcelain \
    | awk -v want="branch refs/heads/$head" \
      '/^worktree /{path = substr($0, 10)} $0 == want {print path; exit}')"
  [ -n "$worktree" ] || return 0
  # task-clean.sh:44 resolves NAME to "$repo/.claude/worktrees/$NAME", so the
  # command below is only actionable for a worktree that actually lives there.
  # Landing from the main checkout or an ad-hoc worktree (~/Code/lobu-pr3173-exact)
  # would otherwise print a command that exits "no worktree at ...".
  case "$worktree" in
    */.claude/worktrees/*) ;;
    *) return 0 ;;
  esac
  slug="$(basename "$worktree")"
  echo
  echo "Cleanup: this merge does not retire the worktree or its dev sandbox."
  echo "Once you no longer need it for verification:"
  echo "  make task-clean NAME=$slug"
}
report_cleanup
echo
echo "Prod-visible? Gate rollout on the SQUASH commit, not your branch head:"
echo "  git merge-base --is-ancestor ${merge_sha:-<sha>} \"\$DEPLOYED_SHA\""
exit 0
