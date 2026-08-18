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

workflow_job() {
  local workflow="$1"
  local job="$2"
  awk -v header="  $job:" '
    $0 == header { found = 1 }
    found && $0 != header && $0 ~ /^  [[:alnum:]_-]+:$/ { exit }
    found { print }
  ' "$workflow"
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

skipped_job="${success/\"finished\",\"attempts\"/\"skipped\",\"attempts\"}"
remote_ci_status_succeeded <<<"$skipped_job" || fail "skipped conditional job was rejected"
if remote_ci_print_failures <<<"$skipped_job" | grep -q 'job ci.yml:unit'; then
  fail "skipped conditional job was reported as a failure"
fi

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
repo="$tmp_dir/repo"
mkdir -p "$repo"
(
  cd "$repo"
  git init -q
  printf 'tracked\n' > tracked.txt
  git add tracked.txt

  initial_tree="$(remote_ci_staged_tree)"
  [ -n "$initial_tree" ] || fail "staged tree was empty"

  printf 'new\n' > new.txt
  if remote_ci_require_no_untracked >/dev/null 2>&1; then
    fail "untracked file was accepted"
  fi
  if remote_ci_staged_tree >/dev/null 2>&1; then
    fail "tree with an untracked file was accepted"
  fi

  git add new.txt
  remote_ci_require_no_untracked || fail "staged new file was rejected"

  printf 'unstaged\n' >> tracked.txt
  if remote_ci_staged_tree >/dev/null 2>&1; then
    fail "tree with unstaged changes was accepted"
  fi

  git add tracked.txt
  settled_tree="$(remote_ci_staged_tree)"
  assert_eq "$settled_tree" "$(git write-tree)"
)

workflow="$SCRIPT_DIR/../../../.github/workflows/ci.yml"
sdk_build="$(workflow_job "$workflow" sdk-cli-build)"
[ -n "$sdk_build" ] || fail "sdk-cli-build job is missing"
grep -q 'tar -czf "\$RUNNER_TEMP/sdk-cli-distributions.tgz" packages/\*/dist' <<<"$sdk_build" ||
  fail "sdk-cli-build does not preserve package paths in its distribution artifact"
if grep -q '^    needs:' <<<"$sdk_build"; then
  fail "sdk-cli-build still waits for the merge graph"
fi
for smoke in sdk-lifecycle-e2e sdk-error-taxonomy-e2e cli-command-smoke; do
  block="$(workflow_job "$workflow" "$smoke")"
  [ -n "$block" ] || fail "$smoke job is missing"
  grep -q '^    needs: sdk-cli-build$' <<<"$block" || fail "$smoke does not reuse sdk-cli-build"
  grep -q 'tar -xzf "\$RUNNER_TEMP/sdk-cli-distributions/sdk-cli-distributions.tgz"' <<<"$block" ||
    fail "$smoke does not restore the built distributions"
done
sdk_gate="$(workflow_job "$workflow" sdk-cli-e2e)"
grep -q '^    needs: \[sdk-lifecycle-e2e, sdk-error-taxonomy-e2e, cli-command-smoke\]$' <<<"$sdk_gate" ||
  fail "sdk-cli-e2e does not aggregate every deep smoke"
dead_code="$(workflow_job "$workflow" dead-code-report)"
[ -n "$dead_code" ] || fail "advisory dead-code report was dropped during SDK fan-out"
grep -q '^    needs: \[unit, frontend, integration, format-lint, typecheck, migrations\]$' <<<"$dead_code" ||
  fail "advisory dead-code report does not retain its post-gate scheduling"
sdk_lifecycle="$(workflow_job "$workflow" sdk-lifecycle-e2e)"
grep -q 'Report available exec-sandbox backends' <<<"$sdk_lifecycle" ||
  fail "main-push exec-sandbox probe was dropped during SDK fan-out"
optional_filter="$(workflow_job "$workflow" optional-smoke-filter)"
if grep -q '^    needs:' <<<"$optional_filter"; then
  fail "optional smoke filter still waits for the merge graph"
fi
vitest_job="$(workflow_job "$workflow" server-integration-vitest)"
grep -q -- '--shard=${{ matrix.shard }}/3' <<<"$vitest_job" ||
  fail "static isolated Vitest shard is missing"
if grep -q 'depot/tests-run-action' <<<"$vitest_job"; then
  fail "timing regrouping is unsafe for the order-sensitive shared-DB suite"
fi

echo "ok - remote CI helpers fail closed"
