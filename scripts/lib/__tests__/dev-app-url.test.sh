#!/usr/bin/env bash
# Unit tests for scripts/lib/dev-app-url.sh (pathless SPA origin).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=scripts/lib/dev-app-url.sh
. "$ROOT/scripts/lib/dev-app-url.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

assert_eq() {
  local got="$1" want="$2" label="$3"
  [[ "$got" == "$want" ]] || fail "$label: got='$got' want='$want'"
}

assert_eq "$(lobu_dev_spa_origin_from_gateway_url 'http://127.0.0.1:8811/lobu')" \
  'http://127.0.0.1:8811' 'strip /lobu'
assert_eq "$(lobu_dev_spa_origin_from_gateway_url 'http://127.0.0.1:8811/lobu/')" \
  'http://127.0.0.1:8811' 'strip /lobu/'
assert_eq "$(lobu_dev_spa_origin_from_gateway_url 'http://127.0.0.1:8811')" \
  'http://127.0.0.1:8811' 'already pathless'
assert_eq "$(lobu_dev_spa_origin_from_gateway_url 'https://app.example.com/lobu')" \
  'https://app.example.com' 'https strip'

PUBLIC_GATEWAY_URL='http://127.0.0.1:8811/lobu'
assert_eq "$(lobu_dev_app_url)" 'http://127.0.0.1:8811' 'lobu_dev_app_url from gateway'

unset PUBLIC_GATEWAY_URL
HOST=127.0.0.1 PORT=9999
assert_eq "$(lobu_dev_app_url)" 'http://127.0.0.1:9999' 'fallback without /lobu'

echo "OK dev-app-url tests"
