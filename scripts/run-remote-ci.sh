#!/usr/bin/env bash
# Run the Linux CI graph against local changes (optional; GitHub CI is canonical).
#
# Provider (REMOTE_CI_PROVIDER, default: auto):
#   auto    - Daytona ephemeral sandbox when the CLI exists AND is logged in;
#             otherwise run the SAME jobs on this machine. Never disruptive:
#             the command works without Daytona.
#   daytona - require Daytona (fail closed if unavailable).
#   local   - force the local fallback.
#   depot   - legacy Depot cloud CI (requires the Depot org; opt-in).
#
# Job list: pass job names as args (see scripts/lib/gate-runner.sh) or rely on
# the default full Linux graph. REMOTE_JOBS on the make target narrows it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/remote-ci.sh
. "$SCRIPT_DIR/lib/remote-ci.sh"
cd "$REPO_ROOT"

REMOTE_CI_TIMEOUT_SECONDS="${REMOTE_CI_TIMEOUT_SECONDS:-2700}"
REMOTE_CI_POLL_INTERVAL_SECONDS="${REMOTE_CI_POLL_INTERVAL_SECONDS:-5}"
REMOTE_CI_MAX_RETRIES="${REMOTE_CI_MAX_RETRIES:-1}"
WORKFLOW=".github/workflows/ci.yml"
SOURCE_ACTION=".github/actions/setup-submodule/action.yml"
DEPOT_ACTION=".depot/actions/setup-submodule/action.yml"

# All Linux jobs, including the two dependency aggregators. mac-build-smoke is
# intentionally absent: it requires macOS and remains on GitHub/Mac hardware.
# NOTE: keep in sync with GATE_JOBS in scripts/lib/gate-runner.sh (the
# daytona/local paths default through gate-runner; this list only feeds the
# Depot --job flags).
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

# ── provider resolution ────────────────────────────────────────────────────

# Daytona provider state: "ready" (usable), "absent" (CLI/jq not on PATH),
# or "faulty" (CLI present but not usable — e.g. not logged in). The caller
# decides: absent is a legitimate not-set-up case (fall back to local), but
# faulty is a misconfiguration/regression that must not be silently masked.
daytona_probe() {
  command -v daytona >/dev/null 2>&1 || { echo absent; return; }
  # Sandbox polling pipes `daytona list --format json` through jq; without
  # jq the run would fail mid-way, so treat a missing jq as faulty too.
  command -v jq >/dev/null 2>&1 || { echo faulty; return; }
  # `daytona list` fails when not logged in — that's the readiness probe.
  if daytona list >/dev/null 2>&1; then echo ready; else echo faulty; fi
}

daytona_ready() {
  [ "$(daytona_probe)" = "ready" ]
}

PROVIDER="${REMOTE_CI_PROVIDER:-auto}"
case "$PROVIDER" in
  auto)
    case "$(daytona_probe)" in
      ready)
        PROVIDER=daytona
        echo ">> provider: daytona (ephemeral sandbox)"
        ;;
      absent)
        PROVIDER=local
        echo ">> provider: local (Daytona CLI not available — fallback; GitHub CI is canonical)"
        ;;
      faulty)
        echo "Daytona CLI is installed but not usable (not logged in?) — refusing to silently" >&2
        echo "fall back to local. Run 'daytona login', or force the local fallback with" >&2
        echo "REMOTE_CI_PROVIDER=local." >&2
        exit 2
        ;;
    esac
    ;;
  daytona)
    daytona_ready || {
      echo "REMOTE_CI_PROVIDER=daytona but the Daytona CLI is not available or not logged in." >&2
      exit 2
    }
    ;;
  local) ;;
  depot) ;;
  *)
    echo "Unknown REMOTE_CI_PROVIDER '$PROVIDER' (auto | daytona | local | depot)." >&2
    exit 2
    ;;
esac

if [ "$#" -eq 0 ]; then
  jobs=("${DEFAULT_JOBS[@]}")
else
  jobs=("$@")
fi

# ── local fallback ─────────────────────────────────────────────────────────

run_local() {
  local jobs=("$@")
  echo ">> running ${#jobs[@]} jobs locally: ${jobs[*]}"
  bash scripts/lib/gate-runner.sh "${jobs[@]}"
}

# ── Daytona ephemeral sandbox ──────────────────────────────────────────────

run_daytona() {
  local jobs=("$@")
  # The sandbox only sees committed/staged content, so require a settled tree
  # (GATE_SKIP_SETTLED_CHECK=1 is a test-only escape hatch so the dispatch
  # tests don't depend on this checkout's tree state).
  if [ "${GATE_SKIP_SETTLED_CHECK:-0}" != "1" ]; then
    remote_ci_staged_tree >/dev/null || exit $?
  fi
  # base/name are GLOBALS on purpose: the EXIT trap runs after this function
  # returns, when its locals are gone — a local would silently skip cleanup.
  local stage ctx ws
  base="$(mktemp -d "${TMPDIR:-/tmp}/lobu-pr-full.XXXXXX")"
  stage="$base/stage"
  ctx="$base/ctx"
  mkdir -p "$stage" "$ctx"
  # Materialize the exact staged tree (index only — no untracked files).
  git checkout-index -a -f --prefix="$stage/"
  # Submodule content at the pinned commit (the sandbox has no .git to fetch
  # it; owletto is a private repo whose deploy key lives on GitHub only).
  # NOTE: .git is a FILE (gitdir: ...) in normal submodule checkouts, not a dir.
  if [ -e packages/owletto/.git ]; then
    git -C packages/owletto archive HEAD | tar -x -C "$stage/packages/owletto"
  else
    # Stub package.json (mirrors .github/actions/setup-submodule) so bun
    # install still resolves the workspace; frontend skips on the stub.
    printf '%s\n' '{' '  "name": "@lobu/owletto",' '  "private": true,' '  "version": "1.6.0",' '  "description": "Stub — private submodule not initialized"' '}' > "$stage/packages/owletto/package.json"
  fi
  # Daytona's build context excludes .github / .env* by default, and the CI
  # wrapper guards in format-lint read .github/actions + ci.yml. Ship the tree
  # as ONE tarball so nothing is filtered, and let the Dockerfile ADD-extract it.
  tar -czf "$ctx/repo.tar.gz" -C "$stage" .
  printf 'FROM ubuntu:24.04\nADD repo.tar.gz /workspace/lobu\nWORKDIR /workspace/lobu\n' > "$ctx/Dockerfile"
  # $$ keeps the name unique when a previous run is still deleting its sandbox.
  name="lobu-pr-full-$(git rev-parse --short HEAD 2>/dev/null || echo local)-$$"
  echo ">> creating ephemeral Daytona sandbox '$name' (${#jobs[@]} jobs)"
  local create_out create_rc=0
  # NOTE: --memory is in GB on CLI v0.204.0 despite the help text saying MB.
  # Empirically verified: --memory 4096 → API rejects "Memory request 4096GB
  # exceeds maximum allowed per sandbox (8GB)"; --memory 4 → sandbox reports
  # memory=4 (GB). Do NOT switch to MB units — that would request 4GB×1024.
  # The org's free tier caps total running memory (~10GiB), so default small.
  create_out="$(daytona create -c "$ctx" --dockerfile "$ctx/Dockerfile" --name "$name" \
    --cpu "${DAYTONA_CPU:-4}" --memory "${DAYTONA_MEMORY_GB:-4}" --disk "${DAYTONA_DISK_GB:-10}" \
    --auto-delete 0 --auto-stop 0 --ttl "${DAYTONA_TTL_MINUTES:-120}" \
    --target "${DAYTONA_TARGET:-eu}" 2>&1)" || create_rc=$?
  if [ "$create_rc" -ne 0 ]; then
    echo "Daytona create failed:" >&2
    echo "$create_out" >&2
    rm -rf "$base"
    exit 1
  fi
  echo "$create_out" | grep -viE '^\[[0-9]+m' | tail -3 || true

  # Cleanup: delete the sandbox and the context dir on every exit path.
  # The trap outlives run_daytona, so guard the function locals (set -u).
  cleanup() {
    if [ -n "${name:-}" ]; then
      # This CLI has no --force flag; delete by name.
      daytona delete "$name" >/dev/null 2>&1 || true
    fi
    if [ -n "${base:-}" ]; then
      rm -rf "$base"
    fi
  }
  trap cleanup EXIT

  # Wait for the sandbox to reach RUNNING.
  local deadline=$((SECONDS + 600))
  while ! daytona_sandbox_running "$name"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "sandbox $name did not reach RUNNING within 600s" >&2
      exit 1
    fi
    sleep 5
  done

  ws="/workspace/lobu"  # deterministic: the generated Dockerfile COPYs the tree here
  echo ">> sandbox running; workspace $ws"
  local job_args="" j
  for j in "${jobs[@]}"; do job_args+="$(printf '%q ' "$j")"; done
  local log rc=0 remote_rc
  log="$(mktemp "${TMPDIR:-/tmp}/lobu-pr-full-daytona.XXXXXX")"
  set +e
  daytona exec "$name" --cwd "$ws" --timeout "${DAYTONA_EXEC_TIMEOUT_SECONDS:-7200}" -- \
    bash -lc "cd '$ws' && GATE_PROVISION=1 bash scripts/lib/gate-runner.sh $job_args; echo GATE_REMOTE_EXIT=\$?" \
    2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  # -a: the gate log can contain binary (esbuild error dumps); force text
  # mode so the sentinel is still parseable, and ignore non-numeric noise.
  remote_rc="$(grep -a '^GATE_REMOTE_EXIT=' "$log" | tail -1 | cut -d= -f2 || true)"
  rm -f "$log"
  if [[ "$remote_rc" =~ ^[0-9]+$ ]]; then
    echo ">> remote gate exit: $remote_rc"
    rc="$remote_rc"
  elif [ "$rc" -ne 0 ]; then
    echo "daytona exec failed (exit $rc) before the gate produced a result." >&2
  fi
  return "$rc"
}

daytona_sandbox_running() { # name
  local name="$1" state
  # This CLI reports a usable sandbox as "started" (stopped/starting otherwise).
  state="$(daytona list --format json 2>/dev/null | jq -r --arg n "$name" '.items[] | select(.name == $n) | .state' | head -1)"
  [ "$state" = "started" ] || [ "$state" = "running" ]
}

# ── Depot (legacy, opt-in) ─────────────────────────────────────────────────

run_depot() {
  local jobs=("$@")
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
  depot ci migrate preflight --org "${DEPOT_ORG_ID:-b9ffw2rv84}" >/dev/null

  # `$#` is the ORIGINAL argv (run_depot receives raw args from the
  # dispatcher): the full-graph default keeps the staged-tree invariant,
  # an explicit job list only requires no-untracked.
  if [ "$#" -eq 0 ]; then
    jobs=("${DEFAULT_JOBS[@]}")
    remote_ci_staged_tree >/dev/null || exit $?
  else
    remote_ci_require_no_untracked || exit $?
  fi

  local job_args=() job
  for job in "${jobs[@]}"; do
    job_args+=(--job "$job")
  done

  echo ">> running ${#jobs[@]} Linux CI jobs on Depot: ${jobs[*]}"
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/lobu-depot-ci.XXXXXX")"
  trap 'rm -f "$log_file"' EXIT

  # Start the whole graph without --follow: Depot's follower can stream only one
  # selected job and exits early for a multi-job run. Capture the run id, then
  # query the authoritative graph state until it reaches a terminal status.
  set +e
  depot ci run \
    --workflow "$WORKFLOW" \
    --org "${DEPOT_ORG_ID:-b9ffw2rv84}" \
    "${job_args[@]}" 2>&1 | tee "$log_file"
  local cli_exit=${PIPESTATUS[0]}
  set -e

  local run_id
  run_id="$(remote_ci_extract_run_id < "$log_file")"
  if [ -z "$run_id" ]; then
    echo "Depot did not return a run id (CLI exit $cli_exit)." >&2
    exit 1
  fi

  local retry_count=0 status_json summary workflow_id
  while :; do
    local deadline=$((SECONDS + REMOTE_CI_TIMEOUT_SECONDS))
    local last_summary=""
    while :; do
      status_json="$(depot ci status "$run_id" --org "${DEPOT_ORG_ID:-b9ffw2rv84}" --output json)" || {
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
        --failed --workflow "$workflow_id" --org "${DEPOT_ORG_ID:-b9ffw2rv84}"; then
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
}

# ── dispatch ───────────────────────────────────────────────────────────────

case "$PROVIDER" in
  local) run_local "${jobs[@]}" ;;
  daytona) run_daytona "${jobs[@]}" ;;
  # depot gets the RAW args: run_depot resolves the default itself so its
  # full-graph staged-tree invariant keeps working (see its $# check).
  depot) run_depot "$@" ;;
esac
