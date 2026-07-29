#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
review_script="$repo_root/scripts/review.sh"
# shellcheck source=scripts/lib/review-upstream-guard.sh
. "$repo_root/scripts/lib/review-upstream-guard.sh"

tmp="$(mktemp -d /tmp/lobu-review-upstream-guard-test.XXXXXX)"
cleanup() {
  trap - EXIT INT TERM HUP
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The remote can move while the reviewer is running. Guard the cheap
# preflight, the final commit status, and the PR comment independently.
# shellcheck disable=SC2016
guard_call_count="$(
  grep -Fc 'review_assert_head_is_current "$HEAD_SHA" "$PI_REVIEW_STATUS_CONTEXT"' \
    "$review_script" || true
)"
[ "$guard_call_count" -eq 3 ] ||
  fail "review.sh must re-check the upstream at all three publication boundaries"

# A clone whose upstream is a real remote, so the guard's `git fetch` is
# exercised rather than stubbed — a stale remote-tracking ref is precisely the
# failure this guard exists to catch.
# Pin the branch because Git's default differs across developer and CI hosts.
new_clone() {
  local name="$1"
  local origin="$tmp/$name-origin.git"
  local work="$tmp/$name"
  git init -q --bare "$origin"
  git -C "$origin" symbolic-ref HEAD refs/heads/main
  git init -q "$work"
  git -C "$work" symbolic-ref HEAD refs/heads/main
  git -C "$work" config user.email t@t.t
  git -C "$work" config user.name t
  git -C "$work" commit -q --allow-empty -m base
  git -C "$work" remote add origin "$origin"
  git -C "$work" push -q -u origin main
  printf '%s\n' "$work"
}

# Simulates Codex pushing to the branch from elsewhere.
push_from_elsewhere() {
  local work="$1" other="$tmp/other-$RANDOM"
  git clone -q -b main "$(git -C "$work" remote get-url origin)" "$other"
  git -C "$other" config user.email c@c.c
  git -C "$other" config user.name Codesmith
  git -C "$other" commit -q --allow-empty -m "style: apply biome formatting"
  git -C "$other" push -q origin main
}

run_guard() {
  local work="$1"
  ( cd "$work" && review_assert_head_is_current "$(git rev-parse HEAD)" pi-review ) 2>"$tmp/err"
}

# 1. Up to date with the remote — the ordinary case, must pass.
work="$(new_clone insync)"
run_guard "$work" || fail "rejected a HEAD that matches its upstream"

# 2. Local commits not yet pushed. review.sh reviews unpushed commits by
#    design (the CI snapshot is just empty), so being AHEAD must stay allowed.
work="$(new_clone ahead)"
git -C "$work" commit -q --allow-empty -m "local work"
run_guard "$work" || fail "rejected a HEAD that is merely ahead of its upstream"

# 3. The remote moved and HEAD does not contain it — a verdict posted here
#    lands on a commit that is not the PR head. This is the bug.
work="$(new_clone behind)"
push_from_elsewhere "$work"
if run_guard "$work"; then
  fail "accepted a HEAD superseded on the remote — the verdict would be orphaned"
fi
grep -q "does not contain" "$tmp/err" \
  || fail "stale-head error did not explain the problem: $(cat "$tmp/err")"

# 4. Diverged: both sides moved. Still unsafe, for the same reason.
work="$(new_clone diverged)"
git -C "$work" commit -q --allow-empty -m "local work"
push_from_elsewhere "$work"
if run_guard "$work"; then
  fail "accepted a diverged HEAD"
fi

# 5. No upstream at all — nothing to strand, so the review proceeds.
git init -q "$tmp/noupstream"
git -C "$tmp/noupstream" config user.email t@t.t
git -C "$tmp/noupstream" config user.name t
git -C "$tmp/noupstream" commit -q --allow-empty -m base
run_guard "$tmp/noupstream" || fail "rejected a branch that was never pushed"

# 6. Unreachable remote must fail OPEN: this guard prevents a wasted verdict,
#    it is not a correctness gate, and blocking offline review would be worse.
work="$(new_clone offline)"
git -C "$work" remote set-url origin "$tmp/does-not-exist.git"
run_guard "$work" || fail "blocked the review when the remote was unreachable"
grep -q "skipping stale-head check" "$tmp/err" \
  || fail "fail-open path did not warn: $(cat "$tmp/err")"

echo "review-upstream-guard.test.sh: all cases pass"
