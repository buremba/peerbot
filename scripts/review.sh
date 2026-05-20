#!/usr/bin/env bash
# Local review runner: typecheck + unit + integration in cwd, then `pi` with
# the diff against the base branch. Prints a JSON verdict on the last line.
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
# with the verdict (marker-keyed upsert). If there's no PR, posting is
# skipped — the verdict still prints locally.
#
# Auth: uses the operator's ~/.pi/agent state for pi, `gh auth token` for
# GitHub (optional — missing auth just skips posting). Posting a check-run
# is not attempted: `gh api check-runs` requires GitHub App auth, and a
# user PAT cannot satisfy it.

set -euo pipefail

# --- preflight --------------------------------------------------------------

for cmd in pi jq git; do
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

# --- env --------------------------------------------------------------------

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL not set." >&2; exit 2; }

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
  echo "!! build failed (exit $BUILD_EXIT) — proceeding so pi can review the diff, but unit tests will likely fail" >&2
fi

# --- DB schema ownership ----------------------------------------------------
# Postgres 15+ restricts CREATE on the `public` schema to its owner. Integration
# tests run DDL as the DATABASE_URL user — make them the schema owner so
# `setupTestDatabase` doesn't trip on "must be owner of schema public".

DB_USER="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres(ql)?://([^:@/]+).*|\2|')"
if [ -n "$DB_USER" ] && [ "$DB_USER" != "$DATABASE_URL" ]; then
  psql "$DATABASE_URL" -tAc "ALTER SCHEMA public OWNER TO \"$DB_USER\"" >/dev/null 2>&1 || true
fi

# --- test suites ------------------------------------------------------------

TYPECHECK_LOG="/tmp/lobu-review-typecheck.log"
UNIT_LOG="/tmp/lobu-review-unit.log"
INTEGRATION_LOG="/tmp/lobu-review-integration.log"

echo ">> typecheck → $TYPECHECK_LOG"
set +e
bun run typecheck > "$TYPECHECK_LOG" 2>&1
TYPECHECK_EXIT=$?
set -e

echo ">> unit tests → $UNIT_LOG"
set +e
UNIT_EXIT=0
{
  bun test packages/core packages/cli;                              ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/agent-worker;                                   ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/server/src/__tests__/unit;                      ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/server/src/auth/__tests__/tool-access.test.ts;  ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/server/src/gateway/infrastructure/queue;        ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/connector-worker;                               ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
} > "$UNIT_LOG" 2>&1
set -e

echo ">> integration tests → $INTEGRATION_LOG"
set +e
INTEGRATION_EXIT=0
{
  (cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default); ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  (cd packages/server && bun test src/gateway/__tests__);                              ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  (cd packages/server && bun test src/lobu/__tests__ src/workspace/__tests__);         ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
} > "$INTEGRATION_LOG" 2>&1
set -e

echo ">> suite exit codes: typecheck=$TYPECHECK_EXIT unit=$UNIT_EXIT integration=$INTEGRATION_EXIT"

# --- pi ---------------------------------------------------------------------

PROMPT_FILE="$(pwd)/prompts/review-prompt.md"
[ -f "$PROMPT_FILE" ] || { echo "prompt not found: $PROMPT_FILE" >&2; exit 2; }

echo ">> invoking pi"
GH_TOKEN_VAL=""
[ "$GH_AVAILABLE" = "1" ] && GH_TOKEN_VAL="$(gh auth token)"

set +e
RAW="$(
  BASE_BRANCH="$BASE_BRANCH" \
  HEAD_SHA="$HEAD_SHA" \
  TYPECHECK_LOG="$TYPECHECK_LOG" TYPECHECK_EXIT="$TYPECHECK_EXIT" \
  UNIT_LOG="$UNIT_LOG" UNIT_EXIT="$UNIT_EXIT" \
  INTEGRATION_LOG="$INTEGRATION_LOG" INTEGRATION_EXIT="$INTEGRATION_EXIT" \
  GH_TOKEN="$GH_TOKEN_VAL" \
  DATABASE_URL="$DATABASE_URL" \
  pi --mode json --no-session -p "@${PROMPT_FILE}" "Review the diff. Emit only the JSON verdict." < /dev/null
)"
PI_EXIT=$?
set -e

# pi --mode json emits a stream of NDJSON envelopes. The last `agent_end`
# event has .messages[] with role+content; we want the LAST assistant
# message's last `text` content item — that's the verdict JSON string.
# Fall back to scanning all events for assistant messages if the agent_end
# envelope isn't present, then fall back to RAW.
VERDICT="$(printf '%s\n' "$RAW" | jq -rs '
  ( [.[] | select(.type == "agent_end") | .messages[]?] +
    [.[] | select(.role == "assistant")] )
  | map(select(.role == "assistant" and (.content | type) == "array"))
  | last
  | (.content // []) | map(select(.type == "text")) | last | .text // empty
' 2>/dev/null || true)"
[ -n "$VERDICT" ] || VERDICT="$RAW"
VERDICT="$(printf '%s\n' "$VERDICT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"

if ! echo "$VERDICT" | jq -e '.bug_free_confidence != null and .bugs != null and .slop != null and .simplicity != null and (.blockers|type=="array")' >/dev/null 2>&1; then
  echo "pi did not produce a valid JSON verdict. pi exit=$PI_EXIT" >&2
  echo "logs: $TYPECHECK_LOG $UNIT_LOG $INTEGRATION_LOG" >&2
  echo "raw output:" >&2
  printf '%s\n' "$RAW" >&2
  exit 1
fi

BUG_FREE="$(echo "$VERDICT" | jq -r .bug_free_confidence)"
BUGS="$(echo "$VERDICT" | jq -r .bugs)"
SLOP="$(echo "$VERDICT" | jq -r .slop)"
SIMPLICITY="$(echo "$VERDICT" | jq -r .simplicity)"
BLOCKER_COUNT="$(echo "$VERDICT" | jq -r '.blockers|length')"
HEADLINE="bug_free $BUG_FREE, simplicity $SIMPLICITY, slop $SLOP, bugs $BUGS, $BLOCKER_COUNT blockers"

echo ""
echo "=========================================="
echo "verdict: $HEADLINE"
echo "  logs:  $TYPECHECK_LOG $UNIT_LOG $INTEGRATION_LOG"
echo "=========================================="

# --- optional GitHub post --------------------------------------------------

PR_NUMBER=""
if [ "$GH_AVAILABLE" = "1" ]; then
  PR_NUMBER="$(gh pr view --json number -q .number 2>/dev/null || true)"
fi

if [ -z "$PR_NUMBER" ]; then
  echo ">> no PR for current branch; skipping GitHub post"
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
  SUMMARY="$(printf '**%s**\n\n%s%s%s\n\n<details><summary>Full verdict JSON</summary>\n\n```json\n%s\n```\n\n</details>\n\n_Shadow mode — verdict does not gate merges. See `docs/REVIEW_SCHEMA.md`._' \
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
