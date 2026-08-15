#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
checker="$repo_root/scripts/check-submodule-drift.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_pass() {
  local label="$1" expected="$2" output rc
  shift 2
  set +e
  output="$("$@" 2>&1)"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "$label: expected pass, got $rc: $output"
  case "$output" in
    *"$expected"*) ;;
    *) fail "$label: expected output containing '$expected', got: $output" ;;
  esac
}

expect_fail() {
  local label="$1" expected="$2" output rc
  shift 2
  set +e
  output="$("$@" 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$label: expected failure, got pass: $output"
  case "$output" in
    *"$expected"*) ;;
    *) fail "$label: expected output containing '$expected', got: $output" ;;
  esac
}

[ -x "$checker" ] || fail "missing executable checker: $checker"

tmp_root="$(mktemp -d /tmp/lobu-submodule-drift.XXXXXX)"
trap 'rm -rf "$tmp_root"' EXIT

remote="$tmp_root/owletto.git"
source_repo="$tmp_root/source"
checkout="$tmp_root/checkout"

git init -q --bare "$remote"
git init -q "$source_repo"
git -C "$source_repo" config user.email dev@lobu.ai
git -C "$source_repo" config user.name Developer
git -C "$source_repo" checkout -q -b main

printf 'a\n' > "$source_repo/app.ts"
git -C "$source_repo" add app.ts
git -C "$source_repo" commit -q -m "feat: a"
sha_a="$(git -C "$source_repo" rev-parse HEAD)"

printf 'b\n' > "$source_repo/app.ts"
git -C "$source_repo" commit -qam "feat: b"
sha_b="$(git -C "$source_repo" rev-parse HEAD)"

printf 'c\n' > "$source_repo/app.ts"
git -C "$source_repo" commit -qam "feat: c"
sha_c="$(git -C "$source_repo" rev-parse HEAD)"

git -C "$source_repo" remote add origin "$remote"
git -C "$source_repo" push -q -u origin main
git clone -q "$remote" "$checkout"

git -C "$checkout" checkout -q --detach "$sha_a"
expect_pass "unrelated PR" "unrelated PR is not blocked" \
  env EVENT_NAME=pull_request PR_BASE_POINTER="$sha_a" PR_HEAD_POINTER="$sha_a" \
  SUBMODULE_PATH="$checkout" "$checker"

git -C "$checkout" checkout -q --detach "$sha_b"
expect_pass "unrelated PR after base pointer advanced" "unrelated PR is not blocked" \
  env EVENT_NAME=pull_request PR_BASE_POINTER="$sha_a" PR_HEAD_POINTER="$sha_a" \
  SUBMODULE_PATH="$checkout" "$checker"

expect_pass "forward pointer PR" "later Owletto commits remain" \
  env EVENT_NAME=pull_request PR_BASE_POINTER="$sha_a" PR_HEAD_POINTER="$sha_b" \
  SUBMODULE_PATH="$checkout" "$checker"

git -C "$checkout" checkout -q --detach "$sha_c"
expect_pass "pointer PR subsumed by advanced base" "matches owletto/main" \
  env EVENT_NAME=pull_request PR_BASE_POINTER="$sha_a" PR_HEAD_POINTER="$sha_b" \
  SUBMODULE_PATH="$checkout" "$checker"

git -C "$checkout" checkout -q --detach "$sha_a"
expect_fail "rollback pointer PR" "moves backwards" \
  env EVENT_NAME=pull_request PR_BASE_POINTER="$sha_b" PR_HEAD_POINTER="$sha_a" \
  SUBMODULE_PATH="$checkout" "$checker"

expect_fail "mismatched checked-out PR pointer" "does not include PR head pointer" \
  env EVENT_NAME=pull_request PR_BASE_POINTER="$sha_a" PR_HEAD_POINTER="$sha_b" \
  SUBMODULE_PATH="$checkout" "$checker"

expect_fail "main drift" "parent bump is missing" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

git -C "$checkout" config user.email dev@lobu.ai
git -C "$checkout" config user.name Developer
printf 'private\n' > "$checkout/private.ts"
git -C "$checkout" add private.ts
git -C "$checkout" commit -q -m "feat: private"
expect_fail "off-main pin" "is not reachable from owletto/main" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

git -C "$checkout" checkout -q --detach "$sha_c"
expect_pass "up-to-date main" "matches owletto/main" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

git -C "$source_repo" checkout -q -b bot-only "$sha_a"
mkdir -p "$source_repo/deploy"
printf 'tag: next\n' > "$source_repo/deploy/image.yaml"
git -C "$source_repo" add deploy/image.yaml
GIT_AUTHOR_NAME=Flux GIT_AUTHOR_EMAIL=fluxcd@lobu.ai \
  GIT_COMMITTER_NAME=Flux GIT_COMMITTER_EMAIL=fluxcd@lobu.ai \
  git -C "$source_repo" commit -q -m "chore: update images"
git -C "$source_repo" push -q --force origin bot-only:main

git -C "$checkout" checkout -q --detach "$sha_a"
expect_pass "bot-only main drift" "only by FluxCD image-tag commits" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

git -C "$source_repo" checkout -q -B wrong-bot-author "$sha_a"
mkdir -p "$source_repo/deploy"
printf 'tag: wrong-author\n' > "$source_repo/deploy/image.yaml"
git -C "$source_repo" add deploy/image.yaml
git -C "$source_repo" commit -q -m "chore: update images"
git -C "$source_repo" push -q --force origin wrong-bot-author:main

expect_fail "deploy-only lookalike with wrong author" "parent bump is missing" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

git -C "$source_repo" checkout -q -B wrong-bot-subject "$sha_a"
mkdir -p "$source_repo/deploy"
printf 'tag: wrong-subject\n' > "$source_repo/deploy/image.yaml"
git -C "$source_repo" add deploy/image.yaml
GIT_AUTHOR_NAME=Flux GIT_AUTHOR_EMAIL=fluxcd@lobu.ai \
  GIT_COMMITTER_NAME=Flux GIT_COMMITTER_EMAIL=fluxcd@lobu.ai \
  git -C "$source_repo" commit -q -m "chore: update image"
git -C "$source_repo" push -q --force origin wrong-bot-subject:main

expect_fail "deploy-only lookalike with wrong subject" "parent bump is missing" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

git -C "$source_repo" checkout -q -B bot-lookalike "$sha_a"
printf 'product\n' > "$source_repo/product.ts"
git -C "$source_repo" add product.ts
GIT_AUTHOR_NAME=Flux GIT_AUTHOR_EMAIL=fluxcd@lobu.ai \
  GIT_COMMITTER_NAME=Flux GIT_COMMITTER_EMAIL=fluxcd@lobu.ai \
  git -C "$source_repo" commit -q -m "chore: update images"
git -C "$source_repo" push -q --force origin bot-lookalike:main

expect_fail "bot lookalike with product change" "parent bump is missing" \
  env EVENT_NAME=push SUBMODULE_PATH="$checkout" "$checker"

echo "submodule drift policy tests passed"
