#!/usr/bin/env bash
# Local review runner: typecheck + unit + integration in cwd, then Claude CLI
# with the diff against the base branch. Prints a JSON verdict on the last line.
#
# Usage:
#   ./scripts/review.sh                 # base = main
#   ./scripts/review.sh --base develop  # override base
#   BASE=develop ./scripts/review.sh    # env-var override
#
# Runs in $PWD — assumes deps installed, dist built, .env in place, postgres
# reachable. Does NOT create a worktree, install deps, or manage the test DB.
#
# If a PR exists for the current branch, also posts an idempotent PR comment
# with the verdict (marker-keyed upsert). It posts a commit status named by
# PI_REVIEW_STATUS_CONTEXT (default: pi-review) whenever GitHub auth is
# available, so branch protection can require the local agent review.
# If there's no PR, the verdict still prints locally.
#
# Auth: uses the operator's Claude CLI auth for the local review verdict, and
# `gh auth token` for GitHub (optional — missing auth just skips posting).
# Do not route the verdict through Codex/OpenAI providers here: the gate should
# work from Codex sessions even when Codex provider quota is exhausted.
# Commit statuses use the legacy Statuses API because `gh api check-runs`
# requires GitHub App auth, and a user PAT cannot create check-runs.

set -euo pipefail

# --- preflight --------------------------------------------------------------

for cmd in claude jq git; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd not found on PATH." >&2; exit 2; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not inside a git work tree." >&2; exit 2; }

GH_AVAILABLE=1
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  GH_AVAILABLE=0
  echo ">> gh unavailable or not authed — will skip GitHub post"
fi

# --- args -------------------------------------------------------------------

BASE_BRANCH="${BASE:-main}"
CLAUDE_REVIEW_MODEL="${CLAUDE_REVIEW_MODEL:-opus}"
CLAUDE_REVIEW_EFFORT="${CLAUDE_REVIEW_EFFORT:-high}"
PI_REVIEW_STATUS_CONTEXT="${PI_REVIEW_STATUS_CONTEXT:-pi-review}"
PI_REVIEW_MIN_BUG_FREE="${PI_REVIEW_MIN_BUG_FREE:-80}"
PI_REVIEW_MAX_SLOP="${PI_REVIEW_MAX_SLOP:-15}"
PI_REVIEW_MIN_SIMPLICITY="${PI_REVIEW_MIN_SIMPLICITY:-70}"
CLAUDE_REVIEW_HERDR="${CLAUDE_REVIEW_HERDR:-auto}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_BRANCH="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

HEAD_SHA="$(git rev-parse HEAD)"
MERGE_BASE="$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null || true)"
if [ -z "$MERGE_BASE" ]; then
  echo "could not find merge-base of HEAD and $BASE_BRANCH" >&2
  exit 2
fi

echo ">> cwd:  $(pwd)"
echo ">> base: $BASE_BRANCH (merge-base $MERGE_BASE)"
echo ">> head: $HEAD_SHA"

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

REVIEW_STATUS_FINALIZED=0
finalize_review_status() {
  post_review_status "$1" "$2" "${3:-}"
  REVIEW_STATUS_FINALIZED=1
}

run_claude_review_inline() {
  local prompt_file="$1"
  set +e
  RAW="$(
    BASE_BRANCH="$BASE_BRANCH" \
    HEAD_SHA="$HEAD_SHA" \
    TYPECHECK_LOG="$TYPECHECK_LOG" TYPECHECK_EXIT="$TYPECHECK_EXIT" \
    UNIT_LOG="$UNIT_LOG" UNIT_EXIT="$UNIT_EXIT" \
    INTEGRATION_LOG="$INTEGRATION_LOG" INTEGRATION_EXIT="$INTEGRATION_EXIT" \
    DATABASE_URL="${DATABASE_URL:-}" \
    claude -p "$(cat "$prompt_file")" \
      --model "$CLAUDE_REVIEW_MODEL" \
      --effort "$CLAUDE_REVIEW_EFFORT" \
      --output-format text \
      --no-session-persistence \
      --tools Bash,Read,Grep,LS \
      --permission-mode bypassPermissions < /dev/null
  )"
  CLAUDE_EXIT=$?
  set -e
}

run_claude_review_herdr() {
  local prompt_file="$1"
  local raw_file exit_file pane_name started
  raw_file="$(mktemp /tmp/lobu-review-claude-raw.XXXXXX)"
  exit_file="$(mktemp /tmp/lobu-review-claude-exit.XXXXXX)"
  rm -f "$exit_file"
  pane_name="claude-review-${HEAD_SHA:0:8}-$$"

  echo ">> spawning Herdr pane '$pane_name' for Claude review"
  set +e
  started="$(
    herdr agent start "$pane_name" \
      --workspace "$HERDR_WORKSPACE_ID" \
      --cwd "$PWD" \
      --split down \
      --no-focus \
      --env "PATH=$PATH" \
      --env "HOME=$HOME" \
      --env "SHELL=${SHELL:-}" \
      --env "BASE_BRANCH=$BASE_BRANCH" \
      --env "HEAD_SHA=$HEAD_SHA" \
      --env "TYPECHECK_LOG=$TYPECHECK_LOG" \
      --env "TYPECHECK_EXIT=$TYPECHECK_EXIT" \
      --env "UNIT_LOG=$UNIT_LOG" \
      --env "UNIT_EXIT=$UNIT_EXIT" \
      --env "INTEGRATION_LOG=$INTEGRATION_LOG" \
      --env "INTEGRATION_EXIT=$INTEGRATION_EXIT" \
      --env "DATABASE_URL=${DATABASE_URL:-}" \
      --env "CLAUDE_REVIEW_MODEL=$CLAUDE_REVIEW_MODEL" \
      --env "CLAUDE_REVIEW_EFFORT=$CLAUDE_REVIEW_EFFORT" \
      --env "PROMPT_FILE=$prompt_file" \
      --env "RAW_FILE=$raw_file" \
      --env "EXIT_FILE=$exit_file" \
      -- bash -lc '
        set +e
        claude -p "$(cat "$PROMPT_FILE")" \
          --model "$CLAUDE_REVIEW_MODEL" \
          --effort "$CLAUDE_REVIEW_EFFORT" \
          --output-format text \
          --no-session-persistence \
          --tools Bash,Read,Grep,LS \
          --permission-mode bypassPermissions < /dev/null | tee "$RAW_FILE"
        claude_exit=${PIPESTATUS[0]}
        printf "%s\n" "$claude_exit" > "$EXIT_FILE"
        exit "$claude_exit"
      ' 2>&1
  )"
  local start_exit=$?
  set -e
  if [ $start_exit -ne 0 ]; then
    echo ">> Herdr Claude pane failed to start; falling back to inline Claude" >&2
    printf '%s\n' "$started" >&2
    run_claude_review_inline "$prompt_file"
    return
  fi

  echo ">> Claude review is visible in Herdr pane '$pane_name'"
  local waited=0
  while [ ! -f "$exit_file" ]; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "${CLAUDE_REVIEW_TIMEOUT_SECONDS:-1200}" ]; then
      RAW="$(cat "$raw_file" 2>/dev/null || true)"
      CLAUDE_EXIT=124
      rm -f "$raw_file" "$exit_file"
      echo ">> Claude review pane timed out after ${waited}s" >&2
      return
    fi
  done

  RAW="$(cat "$raw_file" 2>/dev/null || true)"
  CLAUDE_EXIT="$(cat "$exit_file" 2>/dev/null || echo 1)"
  rm -f "$raw_file" "$exit_file"
}

run_claude_review() {
  local prompt_file="$1"
  if [ "$CLAUDE_REVIEW_HERDR" != "0" ] &&
     [ -n "${HERDR_WORKSPACE_ID:-}" ] &&
     command -v herdr >/dev/null 2>&1; then
    run_claude_review_herdr "$prompt_file"
  else
    if [ "$CLAUDE_REVIEW_HERDR" = "1" ]; then
      echo ">> CLAUDE_REVIEW_HERDR=1 but no Herdr workspace is available; running inline" >&2
    fi
    run_claude_review_inline "$prompt_file"
  fi
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

trap 'ec=$?; if [ $ec -ne 0 ] && [ "${REVIEW_STATUS_FINALIZED:-0}" != "1" ]; then post_review_status error "Claude review failed before verdict (exit $ec)"; fi' EXIT

post_review_status pending "Claude review running"

# --- env --------------------------------------------------------------------

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Tests must NOT run against whatever DATABASE_URL .env points at (often a
# shared/tailnet DB) — they run DDL like `DROP SCHEMA public`. Unset it so the
# test harness spawns an isolated, ephemeral embedded Postgres per run (see
# packages/server/src/__tests__/setup/embedded-postgres-backend.ts). This also
# removes the old "ALTER SCHEMA public OWNER" hack: the embedded cluster's
# bootstrap role already owns its schema.
unset DATABASE_URL

# The dev .env also sets PUBLIC_GATEWAY_URL=http://localhost:8787, which makes the
# public-origin / public-pages-contract tests fail ("expected 'localhost' to be
# null") — they assert the unconfigured-origin contract. It is the only var the
# canonical-origin resolution reads (src/utils/public-origin.ts), so clear it.
unset PUBLIC_GATEWAY_URL

# --- build ------------------------------------------------------------------
# Tests need workspace packages built. Worktree's `dist/` may be stale or
# missing — always rebuild before tests. Cheap if up-to-date.

BUILD_LOG="/tmp/lobu-review-build.log"
echo ">> make build-packages → $BUILD_LOG"
set +e
make build-packages > "$BUILD_LOG" 2>&1
BUILD_EXIT=$?
set -e
if [ $BUILD_EXIT -ne 0 ]; then
  echo "!! build failed (exit $BUILD_EXIT) — proceeding so Claude can review the diff, but unit tests will likely fail" >&2
fi

# --- test suites ------------------------------------------------------------

TYPECHECK_LOG="/tmp/lobu-review-typecheck.log"
UNIT_LOG="/tmp/lobu-review-unit.log"
INTEGRATION_LOG="/tmp/lobu-review-integration.log"
DETERMINISTIC_TEST_ENV=(
  env
  ANTHROPIC_API_KEY=
  ANTHROPIC_AUTH_TOKEN=
  CLAUDE_CODE_OAUTH_TOKEN=
  OPENAI_API_KEY=
  OPENAI_AUTH_TOKEN=
)

echo ">> typecheck → $TYPECHECK_LOG"
set +e
"${DETERMINISTIC_TEST_ENV[@]}" bun run typecheck > "$TYPECHECK_LOG" 2>&1
TYPECHECK_EXIT=$?
set -e

echo ">> unit tests → $UNIT_LOG"
set +e
UNIT_EXIT=0
{
  # Guard: every packages/server *.test.ts must run in >=1 runner (vitest or a
  # bun job). Fails loudly if a file drifts into running nowhere — the
  # silent-skip class this change fixes.
  "${DETERMINISTIC_TEST_ENV[@]}" node scripts/check-test-runner-coverage.mjs;                      ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  # Guard: no raw JS array bound as a SQL param (the fetch_types:false trap —
  # a malformed array literal that Postgres rejects, historically silent).
  "${DETERMINISTIC_TEST_ENV[@]}" node scripts/check-raw-array-params.mjs;                          ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  # Guard: the per-user connection-visibility READ-SEAM gate must come from the
  # one compiler (authz/connection-visibility.ts), not be re-derived inline —
  # that is how the authz gate silently drifts and leaks private-connection data.
  "${DETERMINISTIC_TEST_ENV[@]}" node scripts/check-connection-visibility-compiler.mjs;            ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  "${DETERMINISTIC_TEST_ENV[@]}" bun test packages/core packages/cli packages/connectors;          ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  "${DETERMINISTIC_TEST_ENV[@]}" bun test packages/agent-worker;                                   ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  "${DETERMINISTIC_TEST_ENV[@]}" bun test packages/server/src/__tests__/unit;                      ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  "${DETERMINISTIC_TEST_ENV[@]}" bun test packages/server/src/auth/__tests__/tool-access.test.ts;  ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  # NOTE: src/gateway/infrastructure/queue runs in the gateway integration loop
  # below (not here) — see #1238; running it in both jobs double-executes it.
  "${DETERMINISTIC_TEST_ENV[@]}" bun test packages/connector-worker;                               ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
} > "$UNIT_LOG" 2>&1
set -e

echo ">> make clean-test-pg before integration"
make clean-test-pg

echo ">> integration tests → $INTEGRATION_LOG"
set +e
INTEGRATION_EXIT=0
{
  (cd packages/server && "${DETERMINISTIC_TEST_ENV[@]}" node ../../node_modules/.bin/vitest run --reporter=default); ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  # Each gateway test file runs in its own bun process: bun has no per-file
  # isolation and the gateway suites aren't mutually hermetic, so co-running a
  # whole __tests__ dir in one process leaks DB/module state across files (see
  # #1238 and the ci.yml comment). `find` auto-discovers nested dirs; the
  # coverage gate fails if any gateway test file escapes this loop. Run all,
  # fail at the end.
  ( cd packages/server
    dirs=$(find src/gateway -type d -name __tests__ | sort)
    [ -n "$dirs" ] || { echo "no gateway __tests__ dirs found" >&2; exit 1; }
    rc=0
    for d in $dirs; do
      files=$(find "$d" -maxdepth 1 -type f -name '*.test.ts' | sort)
      for f in $files; do
        "${DETERMINISTIC_TEST_ENV[@]}" bun test "$f" || rc=1
      done
    done
    exit $rc );                                                                        ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  (cd packages/server && "${DETERMINISTIC_TEST_ENV[@]}" bun test src/lobu/__tests__ src/scheduled src/workspace/__tests__ src/tools/admin/__tests__ src/auth/oauth/__tests__); ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
} > "$INTEGRATION_LOG" 2>&1
set -e

echo ">> suite exit codes: typecheck=$TYPECHECK_EXIT unit=$UNIT_EXIT integration=$INTEGRATION_EXIT"

# --- Claude review ----------------------------------------------------------

PROMPT_FILE="$(pwd)/prompts/review-prompt.md"
[ -f "$PROMPT_FILE" ] || { echo "prompt not found: $PROMPT_FILE" >&2; exit 2; }

echo ">> invoking Claude CLI (model: $CLAUDE_REVIEW_MODEL, effort: $CLAUDE_REVIEW_EFFORT)"
CLAUDE_PROMPT_FILE="$(mktemp /tmp/lobu-review-prompt.XXXXXX)"
cat "$PROMPT_FILE" > "$CLAUDE_PROMPT_FILE"
printf '\n\nReview the diff. Emit only the JSON verdict.\n' >> "$CLAUDE_PROMPT_FILE"
run_claude_review "$CLAUDE_PROMPT_FILE"
rm -f "$CLAUDE_PROMPT_FILE"

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
  finalize_review_status error "Claude review did not produce a valid JSON verdict"
  echo "Claude review did not produce a valid JSON verdict. claude exit=$CLAUDE_EXIT" >&2
  echo "logs: $TYPECHECK_LOG $UNIT_LOG $INTEGRATION_LOG" >&2
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
echo "  logs:  $TYPECHECK_LOG $UNIT_LOG $INTEGRATION_LOG"
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
