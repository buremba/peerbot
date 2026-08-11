#!/usr/bin/env bash
# Run the Linux CI graph on Depot against the current working tree. Depot
# applies committed, uncommitted, and untracked changes after checkout, so an
# agent can get a full preflight before pushing without using local CPU.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/lib/remote-ci.sh"
cd "$REPO_ROOT"

DEPOT_ORG_ID="${DEPOT_ORG_ID:-b9ffw2rv84}"
WORKFLOW=".github/workflows/ci.yml"
SOURCE_ACTION=".github/actions/setup-submodule/action.yml"
DEPOT_ACTION=".depot/actions/setup-submodule/action.yml"
ATTESTATION_FILE="$(git rev-parse --git-path lobu-remote-preflight)"

# All Linux jobs, including the two dependency aggregators. mac-build-smoke is
# intentionally absent: it requires macOS and remains on GitHub/Mac hardware.
DEFAULT_JOBS=(
  unit
  frontend
  server-integration-vitest
  server-integration-bun
  integration
  format-lint
  typecheck
  migrations
  optional-smoke-filter
  connector-parity-smoke
  sdk-cli-e2e
)

for cmd in depot git jq tee; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "$cmd not found on PATH." >&2
    exit 2
  }
done

if ! cmp -s "$SOURCE_ACTION" "$DEPOT_ACTION"; then
  echo "$DEPOT_ACTION has drifted from $SOURCE_ACTION." >&2
  echo "Keep the Depot copy byte-for-byte identical to the GitHub action." >&2
  exit 2
fi

# A changed workflow can read Depot secrets. Refuse to execute it by default;
# the explicit override is reserved for reviewed CI-infrastructure changes.
if [ "${DEPOT_ALLOW_WORKFLOW_CHANGES:-0}" != "1" ]; then
  git show-ref --verify --quiet refs/remotes/origin/main || {
    echo "origin/main is unavailable; fetch it before running remote CI." >&2
    exit 2
  }
  if ! git diff --quiet origin/main -- "$WORKFLOW" "$SOURCE_ACTION" "$DEPOT_ACTION"; then
    echo "Remote workflow/action files differ from origin/main." >&2
    echo "Review them, then rerun with DEPOT_ALLOW_WORKFLOW_CHANGES=1 if intentional." >&2
    exit 2
  fi
fi

echo ">> checking Depot repository access"
depot ci migrate preflight --org "$DEPOT_ORG_ID" >/dev/null

full_gate=0
if [ "$#" -eq 0 ]; then
  jobs=("${DEFAULT_JOBS[@]}")
  full_gate=1
else
  jobs=("$@")
fi

job_args=()
for job in "${jobs[@]}"; do
  job_args+=(--job "$job")
done

echo ">> running ${#jobs[@]} Linux CI jobs on Depot: ${jobs[*]}"
log_file="$(mktemp "${TMPDIR:-/tmp}/lobu-depot-ci.XXXXXX")"
trap 'rm -f "$log_file"' EXIT

# depot ci run --follow has returned zero for a failed job. Capture its output,
# then always query the authoritative run status below.
set +e
depot ci run \
  --workflow "$WORKFLOW" \
  --org "$DEPOT_ORG_ID" \
  "${job_args[@]}" \
  --follow 2>&1 | tee "$log_file"
cli_exit=${PIPESTATUS[0]}
set -e

run_id="$(remote_ci_extract_run_id < "$log_file")"
if [ -z "$run_id" ]; then
  echo "Depot did not return a run id (CLI exit $cli_exit)." >&2
  exit 1
fi

status_json="$(depot ci status "$run_id" --org "$DEPOT_ORG_ID" --output json)"
if ! remote_ci_status_succeeded <<<"$status_json"; then
  remote_ci_print_failures <<<"$status_json" >&2
  echo "Depot run $run_id failed (CLI exit $cli_exit)." >&2
  exit 1
fi

echo ">> Depot run $run_id passed"
jq -r '.workflows[].jobs[].attempts[-1].view_url // empty' <<<"$status_json" | sort -u

# Only a clean, full-graph success may suppress review.sh's duplicate local
# package build. A subset run or any tree change invalidates the attestation.
rm -f "$ATTESTATION_FILE"
if [ "$full_gate" = "1" ] && [ -z "$(git status --porcelain)" ]; then
  git rev-parse HEAD > "$ATTESTATION_FILE"
  echo ">> recorded full remote preflight for $(git rev-parse --short HEAD)"
fi
