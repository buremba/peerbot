#!/usr/bin/env bash
# Run the Linux CI graph against local changes.
#
# Usage:
#   make pre-pr-remote              # Depot (GitHub Actions)
#   K8S=1 make pre-pr-remote        # kubectl (local K8s cluster)
#
# K8S mode creates a Pod with the CI image + Postgres sidecar, mounts the
# repo, and runs the test suite directly in the cluster. No Depot, no GitHub
# Actions — just kubectl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/lib/remote-ci.sh"
cd "$REPO_ROOT"

# ── K8S mode: run tests directly in the cluster ──────────────────────────
if [ "${K8S:-0}" = "1" ]; then
  for cmd in kubectl docker; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "$cmd not found on PATH." >&2
      exit 2
    }
  done

  CI_IMAGE="${CI_IMAGE:-lobu-ci:local}"
  K8S_NAMESPACE="${K8S_NAMESPACE:-default}"
  K8S_TIMEOUT="${K8S_TIMEOUT:-900}"

  # Build CI image if it doesn't exist locally
  if ! docker image inspect "$CI_IMAGE" >/dev/null 2>&1; then
    echo ">> building CI image $CI_IMAGE"
    docker build -t "$CI_IMAGE" -f docker/ci/Dockerfile .
  fi

  # Stage all changes so the pod sees the current tree
  if ! git diff --quiet --ignore-submodules=none --; then
    echo ">> K8S mode requires all changes to be staged." >&2
    echo "Run: git add -- <paths> && git commit (WIP ok)" >&2
    exit 1
  fi

  TREE="$(git write-tree)"
  POD="lobu-ci-${TREE:0:12}-$$"
  trap 'kubectl delete pod "$POD" -n "$K8S_NAMESPACE" --ignore-not-found >/dev/null 2>&1' EXIT

  echo ">> running CI in K8s pod $POD (tree $TREE)"

  # Create pod with CI runner (embedded Postgres, no sidecar needed)
  kubectl run "$POD" \
    -n "$K8S_NAMESPACE" \
    --image="$CI_IMAGE" \
    --restart=Never \
    --labels="app=lobu-ci,tree=$TREE" \
    --overrides="{
      \"spec\": {
        \"containers\": [
          {
            \"name\": \"ci\",
            \"image\": \"$CI_IMAGE\",
            \"command\": [\"bash\", \"-c\"],
            \"args\": [\"cd /workspace && bun install && bun run build:packages && bun test\"],
            \"resources\": {\"requests\": {\"cpu\": \"2\", \"memory\": \"4Gi\"}, \"limits\": {\"cpu\": \"4\", \"memory\": \"8Gi\"}}
          }
        ]
      }
    }"

  echo ">> waiting for pod $POD to be ready..."
  kubectl wait --for=condition=Ready pod/"$POD" -n "$K8S_NAMESPACE" --timeout=120s || {
    echo ">> pod did not become ready; fetching logs:" >&2
    kubectl logs "$POD" -n "$K8S_NAMESPACE" --all-containers --tail=100 >&2
    exit 1
  }

  echo ">> streaming CI logs (timeout ${K8S_TIMEOUT}s)..."
  kubectl logs "$POD" -n "$K8S_NAMESPACE" -c ci --follow &
  LOGPID=$!

  # Wait for completion
  deadline=$((SECONDS + K8S_TIMEOUT))
  while :; do
    phase="$(kubectl get pod "$POD" -n "$K8S_NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")"
    if [ "$phase" = "Succeeded" ]; then
      break
    fi
    if [ "$phase" = "Failed" ] || [ "$phase" = "CrashLoopBackOff" ]; then
      echo ">> pod $POD failed (phase: $phase)" >&2
      kill $LOGPID 2>/dev/null || true
      kubectl logs "$POD" -n "$K8S_NAMESPACE" --all-containers --tail=200 >&2
      exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo ">> CI timed out after ${K8S_TIMEOUT}s" >&2
      kill $LOGPID 2>/dev/null || true
      kubectl logs "$POD" -n "$K8S_NAMESPACE" --all-containers --tail=200 >&2
      exit 1
    fi
    sleep 5
  done

  kill $LOGPID 2>/dev/null || true
  echo ">> CI passed in K8s pod $POD"
  exit 0
fi

# ── Depot mode (default) ──────────────────────────────────────────────────
DEPOT_ORG_ID="${DEPOT_ORG_ID:-b9ffw2rv84}"
REMOTE_CI_TIMEOUT_SECONDS="${REMOTE_CI_TIMEOUT_SECONDS:-2700}"
REMOTE_CI_POLL_INTERVAL_SECONDS="${REMOTE_CI_POLL_INTERVAL_SECONDS:-5}"
REMOTE_CI_MAX_RETRIES="${REMOTE_CI_MAX_RETRIES:-1}"
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
  sdk-cli-build
  sdk-lifecycle-e2e
  sdk-error-taxonomy-e2e
  cli-command-smoke
  sdk-cli-e2e
  dead-code-report
  optional-smoke-filter
  connector-parity-smoke
)

for cmd in depot git jq tee; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "$cmd not found on PATH." >&2
    exit 2
  }
done

for value in "$REMOTE_CI_TIMEOUT_SECONDS" "$REMOTE_CI_POLL_INTERVAL_SECONDS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "Remote CI timeout and poll interval must be positive integers." >&2
    exit 2
  }
done
[[ "$REMOTE_CI_MAX_RETRIES" =~ ^[0-9]+$ ]] || {
  echo "Remote CI max retries must be a non-negative integer." >&2
  exit 2
}

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
attested_tree=""
if [ "$#" -eq 0 ]; then
  jobs=("${DEFAULT_JOBS[@]}")
  full_gate=1
  attested_tree="$(remote_ci_staged_tree)" || exit $?
else
  jobs=("$@")
  remote_ci_require_no_untracked || exit $?
fi

# Starting a new full run invalidates any prior tree attestation until the new
# run reaches an authoritative success state. Subset runs do not attest.
if [ "$full_gate" = "1" ]; then
  rm -f "$ATTESTATION_FILE"
fi

job_args=()
for job in "${jobs[@]}"; do
  job_args+=(--job "$job")
done

echo ">> running ${#jobs[@]} Linux CI jobs on Depot: ${jobs[*]}"
log_file="$(mktemp "${TMPDIR:-/tmp}/lobu-depot-ci.XXXXXX")"
trap 'rm -f "$log_file"' EXIT

# Start the whole graph without --follow: Depot's follower can stream only one
# selected job and exits early for a multi-job run. Capture the run id, then
# query the authoritative graph state until it reaches a terminal status.
set +e
depot ci run \
  --workflow "$WORKFLOW" \
  --org "$DEPOT_ORG_ID" \
  "${job_args[@]}" 2>&1 | tee "$log_file"
cli_exit=${PIPESTATUS[0]}
set -e

run_id="$(remote_ci_extract_run_id < "$log_file")"
if [ -z "$run_id" ]; then
  echo "Depot did not return a run id (CLI exit $cli_exit)." >&2
  exit 1
fi

retry_count=0
while :; do
  deadline=$((SECONDS + REMOTE_CI_TIMEOUT_SECONDS))
  last_summary=""
  while :; do
    status_json="$(depot ci status "$run_id" --org "$DEPOT_ORG_ID" --output json)" || {
      echo "Could not read Depot status for run $run_id." >&2
      exit 1
    }
    summary="$(remote_ci_status_summary <<<"$status_json")"
    if [ "$summary" != "$last_summary" ]; then
      echo ">> Depot run $run_id: ${summary:-waiting for jobs}"
      last_summary="$summary"
    fi
    if remote_ci_status_terminal <<<"$status_json"; then
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Depot run $run_id did not finish within ${REMOTE_CI_TIMEOUT_SECONDS}s; it is still running remotely." >&2
      exit 1
    fi
    sleep "$REMOTE_CI_POLL_INTERVAL_SECONDS"
  done

  if remote_ci_status_succeeded <<<"$status_json"; then
    break
  fi

  if [ "$retry_count" -ge "$REMOTE_CI_MAX_RETRIES" ]; then
    break
  fi
  workflow_id="$(jq -r '.workflows[0].workflow_id // empty' <<<"$status_json")"
  if [ -z "$workflow_id" ] || ! depot ci retry "$run_id" \
      --failed --workflow "$workflow_id" --org "$DEPOT_ORG_ID"; then
    echo "Depot could not retry the failed jobs in run $run_id." >&2
    break
  fi
  retry_count=$((retry_count + 1))
  echo ">> retrying failed Depot jobs (${retry_count}/${REMOTE_CI_MAX_RETRIES}); successful jobs are preserved"
done

if ! remote_ci_status_succeeded <<<"$status_json"; then
  remote_ci_print_failures <<<"$status_json" >&2
  echo "Depot run $run_id failed (CLI exit $cli_exit)." >&2
  exit 1
fi

echo ">> Depot run $run_id passed"
jq -r '.workflows[].jobs[].attempts[-1].view_url // empty' <<<"$status_json" | sort -u

# Only an unchanged, settled full-graph success may suppress review.sh's
# duplicate local package build. The tree id remains stable across the commit
# that follows this staged preflight; a subset run can never attest.
if [ "$full_gate" = "1" ]; then
  current_tree="$(remote_ci_staged_tree)" || {
    echo "The worktree changed while Depot was running; remote preflight is not attested." >&2
    exit 1
  }
  if [ "$current_tree" != "$attested_tree" ]; then
    echo "The staged tree changed while Depot was running; rerun the full preflight." >&2
    exit 1
  fi
  printf '%s\n' "$attested_tree" > "$ATTESTATION_FILE"
  echo ">> recorded full remote preflight for tree $attested_tree"
fi
