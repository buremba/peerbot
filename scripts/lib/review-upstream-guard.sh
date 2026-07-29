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

  # Ask the remote directly. The remote-tracking ref goes stale on its own, so
  # comparing against it would pass exactly when it matters most — but a
  # `git fetch` is the wrong way to refresh it here: fetch writes FETCH_HEAD,
  # which is per-worktree shared scratch, and review.sh runs reviews of
  # different commits concurrently. Reading a FETCH_HEAD another command had
  # already overwritten produced an unparseable sha and a silent fail-OPEN —
  # the guard would allow precisely the case it exists to catch.
  # `ls-remote` writes nothing and needs no object download.
  upstream_sha="$(git ls-remote "$remote" "refs/heads/$branch" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -z "$upstream_sha" ]; then
    # Offline, or the branch is gone from the remote. Fail open: this guard
    # exists to stop a wasted verdict, not to gate correctness, and a review
    # that cannot run at all is worse than one posted from stale information.
    printf '>> warning: could not read %s from %s — skipping stale-head check\n' \
      "$branch" "$remote" >&2
    return 0
  fi

  # An unknown object means the remote holds a commit this checkout has never
  # seen, so `--is-ancestor` errors and the guard refuses — which is right.
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
