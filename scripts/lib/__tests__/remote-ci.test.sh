#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/../remote-ci.sh"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

run_id="$(printf 'Org: test\nRun: bj0453b334\nWaiting...\n' | remote_ci_extract_run_id)"
assert_eq "$run_id" "bj0453b334"

success='{
  "status":"finished",
  "workflows":[{"name":"CI","status":"finished","jobs":[
    {"job_key":"ci.yml:unit","status":"finished","attempts":[{"view_url":"https://example.test/unit"}]}
  ]}]
}'
remote_ci_status_succeeded <<<"$success" || fail "finished graph was rejected"
remote_ci_status_terminal <<<"$success" || fail "finished graph was not terminal"
assert_eq "$(remote_ci_status_summary <<<"$success")" "finished=1"

for bad_status in failed running cancelled queued; do
  bad="${success/\"status\":\"finished\"/\"status\":\"$bad_status\"}"
  if remote_ci_status_succeeded <<<"$bad"; then
    fail "$bad_status graph was accepted"
  fi
  case "$bad_status" in
    failed|cancelled)
      remote_ci_status_terminal <<<"$bad" || fail "$bad_status graph was not terminal"
      ;;
    *)
      if remote_ci_status_terminal <<<"$bad"; then
        fail "$bad_status graph was terminal"
      fi
      ;;
  esac
done

failed_job='{
  "status":"finished",
  "workflows":[{"name":"CI","status":"finished","jobs":[
    {"job_key":"ci.yml:unit","status":"failed","attempts":[{"view_url":"https://example.test/unit"}]}
  ]}]
}'
if remote_ci_status_succeeded <<<"$failed_job"; then
  fail "failed job inside a finished run was accepted"
fi

empty='{"status":"finished","workflows":[]}'
if remote_ci_status_succeeded <<<"$empty"; then
  fail "empty graph was accepted"
fi

empty_workflow='{
  "status":"finished",
  "workflows":[
    {"name":"empty","status":"finished","jobs":[]},
    {"name":"other","status":"finished","jobs":[
      {"job_key":"ci.yml:unit","status":"finished","attempts":[]}
    ]}
  ]
}'
if remote_ci_status_succeeded <<<"$empty_workflow"; then
  fail "workflow without jobs was accepted"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/lobu-remote-ci-test.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
marker="$tmp_dir/attestation"
printf 'abc123\n' > "$marker"
remote_ci_attestation_matches abc123 "$marker" || fail "matching attestation was rejected"
if remote_ci_attestation_matches different "$marker"; then
  fail "stale attestation was accepted"
fi

echo "ok - remote CI helpers fail closed"
