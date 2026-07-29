# review-upstream-guard.sh — refuse to post a verdict onto a superseded commit.
# shellcheck shell=bash
#
# review.sh posts the pi-review status to `repos/$repo/statuses/$HEAD_SHA` —
# the LOCAL head. Codex (committer `Codesmith`) pushes commits to open PR
# branches asynchronously; it has done so on 15+ branches in the last 30 days.
# When it lands one while a review is in flight, the verdict attaches to a
# commit that is no longer the PR head, the real head carries no `pi-review`
# status at all, and because that context is required with enforce_admins the
# PR sits blocked forever. Nothing reports the problem: the reviewer exits 0,
# the status posts successfully, and the PR just never becomes mergeable.
#
# Being AHEAD of the remote is fine and stays allowed — review.sh already
# supports reviewing unpushed commits (the CI snapshot is simply empty). The
# only unsafe case is the remote holding commits this HEAD does not contain,
# which is exactly `! git merge-base --is-ancestor <upstream> HEAD`.

# Exits non-zero when the upstream branch has moved past HEAD.
#   $1 — HEAD sha the verdict would be posted to
#   $2 — status context name, for the message only (default: pi-review)
review_assert_head_is_current() {
  local head_sha="$1"
  local status_context="${2:-pi-review}"
  local upstream remote branch upstream_sha

  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  # No upstream: the branch was never pushed, so there is no PR head to
  # strand. review.sh reviews it diff-only by design.
  [ -n "$upstream" ] || return 0

  remote="${upstream%%/*}"
  branch="${upstream#*/}"

  # The remote-tracking ref goes stale on its own, so the fetch is
  # load-bearing — without it this compares against whatever was last seen
  # locally and passes exactly when it matters most.
  if ! git fetch -q "$remote" "$branch" 2>/dev/null; then
    # Offline or the branch is gone from the remote. Fail open: this guard
    # exists to stop a wasted verdict, not to gate correctness, and a review
    # that cannot run at all is worse than one posted from stale information.
    printf '>> warning: could not fetch %s — skipping stale-head check\n' "$upstream" >&2
    return 0
  fi

  upstream_sha="$(git rev-parse FETCH_HEAD 2>/dev/null || true)"
  [ -n "$upstream_sha" ] || return 0

  git merge-base --is-ancestor "$upstream_sha" "$head_sha" 2>/dev/null && return 0

  printf '!! %s is at %s, which HEAD (%s) does not contain.\n' \
    "$upstream" "${upstream_sha:0:9}" "${head_sha:0:9}" >&2
  printf '   Someone pushed while you were working — Codex pushes to open PR\n' >&2
  printf '   branches, so check `git log --format=%%cn` before assuming an agent.\n' >&2
  printf '   A verdict posted now would attach to a commit that is not the PR\n' >&2
  printf "   head, leaving the real head with no '%s' status and the PR\n" "$status_context" >&2
  printf '   blocked with nothing reporting why.\n' >&2
  printf '   Integrate first:  git pull --rebase   (then re-run the tests)\n' >&2
  return 1
}
