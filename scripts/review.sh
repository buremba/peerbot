#!/usr/bin/env bash
# Local review runner: an independent CLI reviewer over the diff against the
# base branch. Prints a JSON verdict on the last line.
#
# The deterministic suites (typecheck / unit / integration / migrations /
# frontend) run in GitHub CI, NOT here — they are separate required status
# checks on main, so auto-merge already blocks on them. This script's job is
# only the agent verdict: it snapshots the head commit's CI check state for
# the reviewer's context, runs the reviewer on the diff, and posts the
# verdict. Because nothing here boots Postgres or binds ports, reviews of
# different commits execute concurrently — there is no host-wide lock. The
# one serialization left is per commit: every run posts the same pi-review
# status for its HEAD sha, so a duplicate run of the SAME commit is refused
# rather than allowed to race the owner's status posts.
#
# Usage:
#   ./scripts/review.sh                 # base = origin/main when available
#   ./scripts/review.sh --base develop  # override base
#   BASE=develop ./scripts/review.sh    # env-var override
#
# Runs in $PWD — assumes deps installed. Push the branch first: the CI
# snapshot is empty for unpushed commits (the review still runs, diff-only).
#
# If a PR exists for the current branch, also posts an idempotent PR comment
# with the verdict (marker-keyed upsert). It posts a commit status named by
# PI_REVIEW_STATUS_CONTEXT (default: pi-review) whenever GitHub auth is
# available, so branch protection can require the local agent review.
# If there's no PR, the verdict still prints locally.
#
# Reviewer selection: Codex harnesses run Claude, while other environments
# (including Claude Code) run Codex. Override with REVIEWER_CLI=codex|claude.
# Auth uses the operator's selected CLI auth for the local review verdict, and
# `gh auth token` for GitHub (optional — missing auth just skips posting).
# Commit statuses use the legacy Statuses API because `gh api check-runs`
# requires GitHub App auth, and a user PAT cannot create check-runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/review-commit-lock.sh
. "$SCRIPT_DIR/lib/review-commit-lock.sh"
# shellcheck source=scripts/lib/review-process.sh
. "$SCRIPT_DIR/lib/review-process.sh"
# shellcheck source=scripts/lib/herdr-review-lifecycle.sh
. "$SCRIPT_DIR/lib/herdr-review-lifecycle.sh"
# shellcheck source=scripts/lib/review-reviewer.sh
. "$SCRIPT_DIR/lib/review-reviewer.sh"

# --- preflight --------------------------------------------------------------

for cmd in jq git node perl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd not found on PATH." >&2; exit 2; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not inside a git work tree." >&2; exit 2; }

GH_AVAILABLE=1
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  GH_AVAILABLE=0
  echo ">> gh unavailable or not authed — will skip GitHub post"
fi

# --- args -------------------------------------------------------------------

if [ -n "${BASE:-}" ]; then
  BASE_BRANCH="$BASE"
elif git show-ref --verify --quiet refs/remotes/origin/main; then
  # Task worktrees often outlive the primary checkout's local `main` ref. Use
  # the fetched remote-tracking branch by default so a stale local main cannot
  # silently widen or distort the diff sent to the reviewer.
  BASE_BRANCH="origin/main"
else
  BASE_BRANCH="main"
fi
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-fable}"
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
CODEX_REVIEW_MODEL="${CODEX_REVIEW_MODEL:-}"
REVIEWER_CLI="${REVIEWER_CLI:-auto}"
PI_REVIEW_STATUS_CONTEXT="${PI_REVIEW_STATUS_CONTEXT:-pi-review}"
PI_REVIEW_MIN_BUG_FREE="${PI_REVIEW_MIN_BUG_FREE:-80}"
PI_REVIEW_MAX_SLOP="${PI_REVIEW_MAX_SLOP:-15}"
PI_REVIEW_MIN_SIMPLICITY="${PI_REVIEW_MIN_SIMPLICITY:-70}"
# Herdr review tabs are opt-in. Default is inline so agents don't spam empty
# review tabs; set CLAUDE_REVIEW_HERDR=1 (or auto) when you want a visible tab.
# Name is historical — applies to either selected reviewer (codex|claude).
CLAUDE_REVIEW_HERDR="${CLAUDE_REVIEW_HERDR:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_BRANCH="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REVIEWER_CLI_SELECTED="$(review_select_reviewer "$REVIEWER_CLI")"
command -v "$REVIEWER_CLI_SELECTED" >/dev/null 2>&1 || {
  review_fail_closed_message "$REVIEWER_CLI_SELECTED" "command not found on PATH" >&2
  exit 2
}

HEAD_SHA="$(git rev-parse HEAD)"
MERGE_BASE="$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null || true)"
if [ -z "$MERGE_BASE" ]; then
  echo "could not find merge-base of HEAD and $BASE_BRANCH" >&2
  exit 2
fi

echo ">> cwd:  $(pwd)"
echo ">> base: $BASE_BRANCH (merge-base $MERGE_BASE)"
echo ">> head: $HEAD_SHA"
echo ">> reviewer: $REVIEWER_CLI_SELECTED"

post_review_status() {
  [ "$GH_AVAILABLE" = "1" ] || return 0
  local state="$1"
  local description="$2"
  local target_url="${3:-}"
  local repo
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  [ -n "$repo" ] || return 0

  # GitHub commit status descriptions are capped at 140 chars.
  description="${description:0:140}"
  local args=(-f "state=$state" -f "context=$PI_REVIEW_STATUS_CONTEXT" -f "description=$description")
  if [ -n "$target_url" ]; then
    args+=(-f "target_url=$target_url")
  fi
  gh api -X POST "repos/$repo/statuses/$HEAD_SHA" "${args[@]}" >/dev/null 2>&1 \
    || echo ">> warning: failed to post GitHub commit status '$PI_REVIEW_STATUS_CONTEXT'" >&2
}

REVIEW_STATUS_STARTED=0
REVIEW_STATUS_FINALIZED=0
finalize_review_status() {
  post_review_status "$1" "$2" "${3:-}"
  REVIEW_STATUS_FINALIZED=1
}

run_reviewer_inline() {
  local prompt_file="$1"
  local raw_file diagnostic_file
  raw_file="$(mktemp /tmp/lobu-review-"${REVIEWER_CLI_SELECTED}"-inline.XXXXXX)"
  diagnostic_file="${raw_file}.stderr"
  REVIEW_INLINE_RAW_FILE="$raw_file"
  REVIEW_INLINE_DIAGNOSTIC_FILE="$diagnostic_file"
  set +e
  case "$REVIEWER_CLI_SELECTED" in
    claude)
      run_review_child env \
        BASE_BRANCH="$BASE_BRANCH" \
        HEAD_SHA="$HEAD_SHA" \
        CI_CHECKS_FILE="$CI_CHECKS_FILE" \
        claude -p "$(cat "$prompt_file")" \
          --model "$CLAUDE_REVIEW_MODEL" \
          --effort "$CLAUDE_REVIEW_EFFORT" \
          --json-schema "$(cat "$SCHEMA_FILE")" \
          --output-format text \
          --no-session-persistence \
          --tools Bash,Read,Grep,LS \
          --permission-mode bypassPermissions < /dev/null > "$raw_file"
      ;;
    codex)
      # The review subcommand cannot combine --base with the Lobu prompt. Use
      # structured exec so deterministic test results remain part of the gate.
      local codex_args=(
        codex exec
        --sandbox read-only
        --output-schema "$SCHEMA_FILE"
        --output-last-message "$raw_file"
        --ephemeral
      )
      if [ -n "$CODEX_REVIEW_MODEL" ]; then
        codex_args+=(--model "$CODEX_REVIEW_MODEL")
      fi
      run_review_child env \
        BASE_BRANCH="$BASE_BRANCH" \
        HEAD_SHA="$HEAD_SHA" \
        CI_CHECKS_FILE="$CI_CHECKS_FILE" \
        "${codex_args[@]}" "$(cat "$prompt_file")" < /dev/null > /dev/null 2> "$diagnostic_file"
      ;;
  esac
  REVIEWER_EXIT=$?
  set -e
  RAW="$(cat "$raw_file" 2>/dev/null || true)"
  if [ "$REVIEWER_EXIT" -ne 0 ] && [ -s "$diagnostic_file" ]; then
    RAW="${RAW}${RAW:+$'\n'}$(cat "$diagnostic_file")"
  fi
  rm -f "$raw_file" "$diagnostic_file"
  REVIEW_INLINE_RAW_FILE=""
  REVIEW_INLINE_DIAGNOSTIC_FILE=""
}

run_reviewer_herdr() {
  local prompt_file="$1"
  local raw_file exit_file runner_file pane_name before_tabs tab_json tab_id pane_id started
  raw_file="$(mktemp /tmp/lobu-review-"${REVIEWER_CLI_SELECTED}"-raw.XXXXXX)"
  exit_file="$(mktemp /tmp/lobu-review-"${REVIEWER_CLI_SELECTED}"-exit.XXXXXX)"
  runner_file="$(mktemp /tmp/lobu-review-"${REVIEWER_CLI_SELECTED}"-runner.XXXXXX)"
  rm -f "$exit_file"
  herdr_review_track_files "$raw_file" "$exit_file" "$runner_file"
  pane_name="${REVIEWER_CLI_SELECTED}-review-${HEAD_SHA:0:8}-$$"

  if ! before_tabs="$(herdr_review_snapshot_tabs "$HERDR_WORKSPACE_ID")"; then
    rm -f "$raw_file" "$exit_file" "$runner_file"
    herdr_review_forget_files
    echo ">> could not snapshot Herdr tabs; running $REVIEWER_CLI_SELECTED inline" >&2
    run_reviewer_inline "$prompt_file"
    return
  fi
  herdr_review_track_locator "$HERDR_WORKSPACE_ID" "$pane_name" "$PWD" "$before_tabs"

  cat > "$runner_file" <<'RUNNER'
set +e
case "$REVIEWER_CLI_SELECTED" in
  claude)
    claude -p "$(cat "$PROMPT_FILE")" \
      --model "$CLAUDE_REVIEW_MODEL" \
      --effort "$CLAUDE_REVIEW_EFFORT" \
      --json-schema "$(cat "$SCHEMA_FILE")" \
      --output-format text \
      --no-session-persistence \
      --tools Bash,Read,Grep,LS \
      --permission-mode bypassPermissions < /dev/null | tee "$RAW_FILE"
    reviewer_exit=${PIPESTATUS[0]}
    ;;
  codex)
    # Structured verdict still lands in RAW_FILE via --output-last-message.
    # --json + the progress filter stream human-readable activity into the
    # Herdr pane so the tab is watchable (Codex alone is nearly silent here).
    codex_args=(
      codex exec
      --sandbox read-only
      --output-schema "$SCHEMA_FILE"
      --output-last-message "$RAW_FILE"
      --ephemeral
      --json
      --color never
    )
    if [ -n "$CODEX_REVIEW_MODEL" ]; then
      codex_args+=(--model "$CODEX_REVIEW_MODEL")
    fi
    set -o pipefail
    "${codex_args[@]}" "$(cat "$PROMPT_FILE")" < /dev/null 2>&1 \
      | python3 -u "$CODEX_PROGRESS_FILTER"
    reviewer_exit=${PIPESTATUS[0]}
    ;;
esac
exit_tmp="${EXIT_FILE}.tmp.$$"
printf "%s\n" "$reviewer_exit" > "$exit_tmp"
mv "$exit_tmp" "$EXIT_FILE"
exit "$reviewer_exit"
RUNNER

  echo ">> spawning Herdr tab '$pane_name' for $REVIEWER_CLI_SELECTED review"
  set +e
  tab_json="$(
    herdr tab create \
      --workspace "$HERDR_WORKSPACE_ID" \
      --cwd "$PWD" \
      --label "$pane_name" \
      --no-focus \
      --env "PATH=$PATH" \
      --env "HOME=$HOME" \
      --env "SHELL=${SHELL:-}" \
      --env "BASE_BRANCH=$BASE_BRANCH" \
      --env "HEAD_SHA=$HEAD_SHA" \
      --env "CI_CHECKS_FILE=$CI_CHECKS_FILE" \
      --env "REVIEWER_CLI_SELECTED=$REVIEWER_CLI_SELECTED" \
      --env "CLAUDE_REVIEW_MODEL=$CLAUDE_REVIEW_MODEL" \
      --env "CLAUDE_REVIEW_EFFORT=$CLAUDE_REVIEW_EFFORT" \
      --env "CODEX_REVIEW_MODEL=$CODEX_REVIEW_MODEL" \
      --env "PROMPT_FILE=$prompt_file" \
      --env "SCHEMA_FILE=$SCHEMA_FILE" \
      --env "RAW_FILE=$raw_file" \
      --env "EXIT_FILE=$exit_file" \
      --env "CODEX_PROGRESS_FILTER=$SCRIPT_DIR/lib/codex-jsonl-progress.py" 2>&1
  )"
  local start_exit=$?
  if [ $start_exit -eq 0 ]; then
    read -r tab_id pane_id <<<"$(herdr_review_parse_created_tab "$tab_json" 2>/dev/null || true)"
    [ -n "$tab_id" ] && herdr_review_track_tab "$tab_id"
    if [ -z "$tab_id" ] || [ -z "$pane_id" ]; then
      start_exit=1
      started="Herdr tab create returned no tab/pane id: $tab_json"
    else
      herdr pane rename "$pane_id" "$pane_name" >/dev/null 2>&1 || true
      # A transport failure can still mean the command reached Herdr. Mark the
      # runner as possibly live before dispatch so EXIT cleanup retains the
      # global lock until exact closure or its terminal marker is confirmed.
      herdr_review_mark_runner_may_be_live
      started="$(herdr pane run "$pane_id" "bash $(printf '%q' "$runner_file")" 2>&1)"
      start_exit=$?
    fi
  else
    started="$tab_json"
  fi
  set -e
  if [ $start_exit -ne 0 ]; then
    if ! herdr_review_cleanup; then
      echo ">> Herdr tab creation state is ambiguous; refusing inline fallback" >&2
      return 1
    fi
    echo ">> Herdr $REVIEWER_CLI_SELECTED tab failed to start; falling back to inline $REVIEWER_CLI_SELECTED" >&2
    printf '%s\n' "$started" >&2
    run_reviewer_inline "$prompt_file"
    return
  fi

  echo ">> $REVIEWER_CLI_SELECTED review is visible in Herdr tab '$pane_name'"
  local waited=0
  while [ ! -f "$exit_file" ]; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "${CLAUDE_REVIEW_TIMEOUT_SECONDS:-1200}" ]; then
      # Stop the tab first so tee flushes its final partial output, then copy it
      # into RAW before deleting the transport files.
      if ! herdr_review_close_tab; then
        RAW="$(cat "$raw_file" 2>/dev/null || true)"
        REVIEWER_EXIT=124
        echo ">> $REVIEWER_CLI_SELECTED review tab timed out and could not be closed" >&2
        return 1
      fi
      RAW="$(cat "$raw_file" 2>/dev/null || true)"
      REVIEWER_EXIT=124
      herdr_review_cleanup
      echo ">> $REVIEWER_CLI_SELECTED review tab timed out after ${waited}s" >&2
      return
    fi
  done

  RAW="$(cat "$raw_file" 2>/dev/null || true)"
  REVIEWER_EXIT="$(cat "$exit_file" 2>/dev/null || echo 1)"
  herdr_review_cleanup
  if review_should_retry_inline "$REVIEWER_EXIT" "$RAW"; then
    echo ">> $REVIEWER_CLI_SELECTED review returned empty output; retrying once inline" >&2
    run_reviewer_inline "$prompt_file"
  fi
}

run_reviewer() {
  local prompt_file="$1"
  # Opt-in: 1 or auto use Herdr when a workspace is available; default is 0.
  case "$CLAUDE_REVIEW_HERDR" in
    1|auto)
      if [ -n "${HERDR_WORKSPACE_ID:-}" ] && command -v herdr >/dev/null 2>&1; then
        run_reviewer_herdr "$prompt_file"
        return
      fi
      if [ "$CLAUDE_REVIEW_HERDR" = "1" ]; then
        echo ">> CLAUDE_REVIEW_HERDR=1 but no Herdr workspace is available; running $REVIEWER_CLI_SELECTED inline" >&2
      fi
      ;;
  esac
  run_reviewer_inline "$prompt_file"
}

extract_json_verdict() {
  local raw="$1"
  local fenced object
  fenced="$(
    printf '%s\n' "$raw" | awk '
      /^[[:space:]]*```json[[:space:]]*$/ { in_json = 1; next }
      /^[[:space:]]*```[[:space:]]*$/ && in_json { exit }
      in_json { print }
    '
  )"
  if [ -n "$fenced" ] && printf '%s\n' "$fenced" | jq -e . >/dev/null 2>&1; then
    printf '%s\n' "$fenced"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    object="$(
      printf '%s\n' "$raw" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");

function candidateFrom(start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] !== "{") continue;
  const candidate = candidateFrom(i);
  if (!candidate) continue;
  try {
    JSON.parse(candidate);
    process.stdout.write(candidate);
    process.exit(0);
  } catch {
  }
}

process.exit(1);
' 2>/dev/null || true
    )"
    if [ -n "$object" ] && printf '%s\n' "$object" | jq -e . >/dev/null 2>&1; then
      printf '%s\n' "$object"
      return
    fi
  fi

  printf '%s\n' "$raw" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//'
}

review_exit_cleanup() {
  local ec=$? post_failure_status=0
  trap - EXIT INT TERM HUP
  stop_active_review_child
  review_process_abort_inline
  # If the normal Herdr path completed, its tracked state is already empty.
  # Otherwise this closes the tab/process and keeps any non-empty partial raw
  # output for diagnosis before the script exits.
  herdr_review_abort_until_runner_stopped
  if [ "$ec" -ne 0 ] && \
     [ "$REVIEW_STATUS_STARTED" = "1" ] && [ "$REVIEW_STATUS_FINALIZED" != "1" ]; then
    post_failure_status=1
  fi
  if [ "$post_failure_status" = "1" ]; then
    post_review_status error "$REVIEWER_CLI_SELECTED review failed before verdict (exit $ec)"
  fi
  exit "$ec"
}
trap review_exit_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Refuse duplicate reviews of this exact commit BEFORE posting any status:
# a non-owner must never touch the owner's pi-review status lifecycle.
acquire_commit_review_lock "$HEAD_SHA"

REVIEW_STATUS_STARTED=1
post_review_status pending "$REVIEWER_CLI_SELECTED review running"

REVIEW_RUN_DIR="$(mktemp -d /tmp/lobu-review.XXXXXX)"

# --- CI check snapshot -------------------------------------------------------
# The deterministic suites run in GitHub CI as their own required status
# checks; branch protection enforces them independently of this verdict. The
# snapshot is context for the reviewer (correlate failures with the diff), not
# a gate — pending checks must not block or degrade the agent review.

CI_CHECKS_FILE="$REVIEW_RUN_DIR/ci-checks.txt"
CI_SNAPSHOT_OK=0
if [ "$GH_AVAILABLE" = "1" ]; then
  REPO_NWO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -n "$REPO_NWO" ] && gh api "repos/$REPO_NWO/commits/$HEAD_SHA/check-runs" --paginate \
      -q '.check_runs[] | "\(.name): \(.status)\(if .conclusion != null then " " + .conclusion else "" end)"' \
      2>/dev/null | sort -u > "$CI_CHECKS_FILE" && [ -s "$CI_CHECKS_FILE" ]; then
    CI_SNAPSHOT_OK=1
  fi
fi
if [ "$CI_SNAPSHOT_OK" != "1" ]; then
  echo "CI state unknown: no check runs found for $HEAD_SHA (unpushed commit, CI not started, or gh unavailable)" > "$CI_CHECKS_FILE"
fi
echo ">> CI check snapshot → $CI_CHECKS_FILE"
sed 's/^/>>   /' "$CI_CHECKS_FILE"

# --- build ------------------------------------------------------------------
# The reviewer's exploratory probes (targeted bun test runs, CLI invocations)
# need workspace packages built. Worktree's `dist/` may be stale or missing —
# always rebuild. Cheap if up-to-date.

BUILD_LOG="$REVIEW_RUN_DIR/build.log"
echo ">> make build-packages → $BUILD_LOG"
set +e
run_review_child make build-packages > "$BUILD_LOG" 2>&1
BUILD_EXIT=$?
set -e
if [ $BUILD_EXIT -ne 0 ]; then
  echo "!! build failed (exit $BUILD_EXIT) — proceeding so $REVIEWER_CLI_SELECTED can review the diff, but exploratory probes may fail" >&2
fi

# --- agent review -----------------------------------------------------------

PROMPT_FILE="$(pwd)/prompts/review-prompt.md"
SCHEMA_FILE="$(pwd)/prompts/review-output-schema.json"
[ -f "$PROMPT_FILE" ] || { echo "prompt not found: $PROMPT_FILE" >&2; exit 2; }
[ -f "$SCHEMA_FILE" ] || { echo "schema not found: $SCHEMA_FILE" >&2; exit 2; }

echo ">> invoking $REVIEWER_CLI_SELECTED review"
REVIEW_PROMPT_FILE="$(mktemp /tmp/lobu-review-prompt.XXXXXX)"
herdr_review_track_prompt "$REVIEW_PROMPT_FILE"
cat "$PROMPT_FILE" > "$REVIEW_PROMPT_FILE"
printf '\n\nReview the diff. Emit only the JSON verdict.\n' >> "$REVIEW_PROMPT_FILE"
run_reviewer "$REVIEW_PROMPT_FILE"
herdr_review_release_prompt

VERDICT="$RAW"
VERDICT="$(extract_json_verdict "$VERDICT")"

if ! echo "$VERDICT" | jq -e '
  (.bug_free_confidence | type == "number" and floor == . and . >= 0 and . <= 100) and
  (.bugs | type == "number" and floor == . and . >= 0) and
  (.slop | type == "number" and floor == . and . >= 0 and . <= 100) and
  (.simplicity | type == "number" and floor == . and . >= 0 and . <= 100) and
  (.blockers | type == "array") and
  (.change_type | IN("feat", "fix", "refactor", "docs", "chore", "test", "deps")) and
  (.behavior_change_risk | IN("none", "low", "medium", "high")) and
  (.tests_adequate | type == "boolean") and
  (.suggested_fixes | type == "array") and
  (.notes | type == "string") and
  (.categories | type == "object")
' >/dev/null 2>&1; then
  if [ "$REVIEWER_EXIT" -ne 0 ]; then
    REVIEW_FAILURE_DETAIL="reviewer process exited with status $REVIEWER_EXIT"
  else
    REVIEW_FAILURE_DETAIL="reviewer returned no schema-valid JSON verdict"
  fi
  finalize_review_status error "Independent $REVIEWER_CLI_SELECTED review could not be completed"
  review_fail_closed_message "$REVIEWER_CLI_SELECTED" "$REVIEW_FAILURE_DETAIL" >&2
  echo "logs: $BUILD_LOG $CI_CHECKS_FILE" >&2
  echo "raw output:" >&2
  printf '%s\n' "$RAW" >&2
  exit 1
fi

BUG_FREE="$(echo "$VERDICT" | jq -r .bug_free_confidence)"
BUGS="$(echo "$VERDICT" | jq -r .bugs)"
SLOP="$(echo "$VERDICT" | jq -r .slop)"
SIMPLICITY="$(echo "$VERDICT" | jq -r .simplicity)"
TESTS_ADEQUATE="$(echo "$VERDICT" | jq -r .tests_adequate)"
RISK="$(echo "$VERDICT" | jq -r .behavior_change_risk)"
BLOCKER_COUNT="$(echo "$VERDICT" | jq -r '.blockers|length')"
HEADLINE="bug_free $BUG_FREE, simplicity $SIMPLICITY, slop $SLOP, bugs $BUGS, $BLOCKER_COUNT blockers"
STATUS_STATE="success"
STATUS_REASONS=()
[ "$BUG_FREE" -ge "$PI_REVIEW_MIN_BUG_FREE" ] || STATUS_REASONS+=("bug_free<$PI_REVIEW_MIN_BUG_FREE")
[ "$BUGS" -eq 0 ] || STATUS_REASONS+=("bugs>0")
[ "$SLOP" -le "$PI_REVIEW_MAX_SLOP" ] || STATUS_REASONS+=("slop>$PI_REVIEW_MAX_SLOP")
[ "$SIMPLICITY" -ge "$PI_REVIEW_MIN_SIMPLICITY" ] || STATUS_REASONS+=("simplicity<$PI_REVIEW_MIN_SIMPLICITY")
[ "$BLOCKER_COUNT" -eq 0 ] || STATUS_REASONS+=("blockers>0")
[ "$TESTS_ADEQUATE" = "true" ] || STATUS_REASONS+=("tests inadequate")
[ "$RISK" != "high" ] || STATUS_REASONS+=("high risk needs human approval")
if [ "${#STATUS_REASONS[@]}" -gt 0 ]; then
  STATUS_STATE="failure"
  STATUS_DESCRIPTION="$HEADLINE; $(IFS=', '; echo "${STATUS_REASONS[*]}")"
else
  STATUS_DESCRIPTION="$HEADLINE"
fi

echo ""
echo "=========================================="
echo "verdict: $HEADLINE"
echo "  ci:    $CI_CHECKS_FILE"
echo "=========================================="

# --- optional GitHub post --------------------------------------------------

PR_NUMBER=""
PR_URL=""
if [ "$GH_AVAILABLE" = "1" ]; then
  PR_JSON="$(gh pr view --json number,url 2>/dev/null || true)"
  PR_NUMBER="$(echo "$PR_JSON" | jq -r '.number // empty' 2>/dev/null || true)"
  PR_URL="$(echo "$PR_JSON" | jq -r '.url // empty' 2>/dev/null || true)"
fi

finalize_review_status "$STATUS_STATE" "$STATUS_DESCRIPTION" "$PR_URL"

if [ -z "$PR_NUMBER" ]; then
  echo ">> no PR for current branch; skipping GitHub comment"
else
  NOTES="$(echo "$VERDICT" | jq -r '.notes // ""')"
  PRETTY="$(echo "$VERDICT" | jq .)"
  SUGGESTIONS_TABLE="$(echo "$VERDICT" | jq -r '
    if (.suggested_fixes // []) | length == 0 then ""
    else "\n\n### Suggested fixes\n\n| File | Line | Change |\n| --- | --- | --- |\n" +
      ((.suggested_fixes // []) | map("| `\(.file)` | \(.line // "") | \(.change) |") | join("\n"))
    end')"
  BLOCKERS_LIST="$(echo "$VERDICT" | jq -r '
    if (.blockers // []) | length == 0 then ""
    else "\n\n### Blockers\n\n" + ((.blockers // []) | map("- " + .) | join("\n"))
    end')"
  # shellcheck disable=SC2016
  SUMMARY="$(printf '**%s**\n\n%s%s%s\n\n<details><summary>Full verdict JSON</summary>\n\n```json\n%s\n```\n\n</details>\n\n_Local review gate — branch protection can require the `pi-review` commit status. See `docs/REVIEW_SCHEMA.md`._' \
    "$HEADLINE" "$NOTES" "$BLOCKERS_LIST" "$SUGGESTIONS_TABLE" "$PRETTY")"

  MARKER="<!-- pi-review-marker -->"
  COMMENT_BODY="$MARKER
$SUMMARY"
  EXISTING_COMMENT_ID="$(gh api "repos/lobu-ai/lobu/issues/$PR_NUMBER/comments" --paginate --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | head -n1)"
  if [ -n "$EXISTING_COMMENT_ID" ]; then
    echo ">> updating PR comment $EXISTING_COMMENT_ID"
    jq -n --arg body "$COMMENT_BODY" '{body:$body}' | gh api -X PATCH "repos/lobu-ai/lobu/issues/comments/$EXISTING_COMMENT_ID" --input - >/dev/null
  else
    echo ">> creating PR comment"
    jq -n --arg body "$COMMENT_BODY" '{body:$body}' | gh api -X POST "repos/lobu-ai/lobu/issues/$PR_NUMBER/comments" --input - >/dev/null
  fi
  echo ">> posted comment on PR #$PR_NUMBER"
fi

# Last line: machine-readable verdict for $(make review) capture.
echo "$VERDICT" | jq -c .
