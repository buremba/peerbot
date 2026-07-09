#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=scripts/lib/review-database-url.sh
. "$repo_root/scripts/lib/review-database-url.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

accept() {
  validate_review_database_url "$1" >/dev/null || fail "rejected safe URL: $1"
}

reject() {
  if validate_review_database_url "$1" >/dev/null 2>&1; then
    fail "accepted unsafe URL: $1"
  fi
}

accept 'postgresql://user@127.0.0.1/lobu_test'
accept 'postgres://user:secret@localhost:5432/lobu_test_review?sslmode=disable'
reject 'postgresql://prod.example/production'
reject 'postgresql://prod.example/lobu_test?database=production'
reject 'postgresql://prod.example/lobu_test?%64atabase=production'
reject 'postgresql://prod.example/lobu_test?database%00ignored=production'
reject 'postgresql://prod.example/lobu_test?dbname=production'
reject 'https://prod.example/lobu_test'
reject 'not a database URL'

echo "review database URL tests passed"
