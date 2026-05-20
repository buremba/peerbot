#!/usr/bin/env bash
# Local-only pi-review runner.
#
# Usage:
#   ./scripts/run-pi-review.sh <PR_NUMBER>
#
# GitHub Actions does NOT run pi-review — the agent (a Claude Code session)
# runs this script after finishing a PR. The script:
#   1. fetches the PR head into a dedicated worktree under ~/.pi-review-worktrees/
#   2. installs deps + builds workspace packages
#   3. runs the same test suites the old CI workflow ran (typecheck, unit,
#      integration), capturing exit codes + logs
#   4. invokes `pi` (using the operator's local ~/.pi/agent state) with the
#      review prompt + env-passed log paths/exit codes
#   5. extracts the JSON verdict
#   6. posts a `pi-review` check-run on the PR head SHA (idempotent — PATCH
#      if it already exists)
#   7. posts a PR comment with the verdict markdown (idempotent — edit the
#      existing comment with the marker if present)
#
# Auth: reuses the operator's ~/.pi/agent state — no PI_AUTH_BUNDLE needed.
# GitHub: uses `gh auth token`.

set -euo pipefail

PR="${1:-}"
if ! [[ "$PR" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 <PR_NUMBER>" >&2
  echo "PR_NUMBER must be a positive integer." >&2
  exit 2
fi

# --- preflight --------------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found on PATH. Install GitHub CLI first." >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run \`gh auth login\` first." >&2
  exit 2
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "pi not found on PATH. Install with: bun add -g @mariozechner/pi-coding-agent" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH. Install jq (brew install jq)." >&2
  exit 2
fi

LOBU_REPO="${LOBU_REPO:-$HOME/Code/lobu}"
if [ ! -d "$LOBU_REPO/.git" ]; then
  echo "Lobu source repo not found at $LOBU_REPO (override with LOBU_REPO=...)." >&2
  exit 2
fi

# --- resolve PR -------------------------------------------------------------

PR_JSON="$(gh pr view "$PR" --repo lobu-ai/lobu --json headRefOid,headRefName,baseRefName,number,title,url)"
HEAD_SHA="$(printf '%s' "$PR_JSON" | jq -r .headRefOid)"
HEAD_BRANCH="$(printf '%s' "$PR_JSON" | jq -r .headRefName)"
BASE_BRANCH="$(printf '%s' "$PR_JSON" | jq -r .baseRefName)"
PR_TITLE="$(printf '%s' "$PR_JSON" | jq -r .title)"
PR_URL="$(printf '%s' "$PR_JSON" | jq -r .url)"

if [ -z "$HEAD_SHA" ] || [ "$HEAD_SHA" = "null" ]; then
  echo "Could not resolve head SHA for PR #$PR." >&2
  exit 2
fi

echo ">> PR #$PR: $PR_TITLE"
echo ">> head: $HEAD_BRANCH @ $HEAD_SHA (base: $BASE_BRANCH)"

# --- worktree ---------------------------------------------------------------

WORKDIR="$HOME/.pi-review-worktrees/lobu-$PR"
PI_REVIEW_REF="refs/pi-review/$PR"

mkdir -p "$(dirname "$WORKDIR")"

if [ -d "$WORKDIR/.git" ] || git -C "$LOBU_REPO" worktree list --porcelain | grep -q "^worktree $WORKDIR$"; then
  echo ">> Reusing worktree at $WORKDIR"
  git -C "$LOBU_REPO" fetch origin "pull/$PR/head:$PI_REVIEW_REF" >/dev/null
  git -C "$WORKDIR" fetch origin "pull/$PR/head" >/dev/null
  git -C "$WORKDIR" reset --hard "$HEAD_SHA" >/dev/null
  git -C "$WORKDIR" clean -fdx -e node_modules -e .env >/dev/null
else
  echo ">> Creating fresh worktree at $WORKDIR"
  git -C "$LOBU_REPO" fetch origin "pull/$PR/head:$PI_REVIEW_REF" >/dev/null
  git -C "$LOBU_REPO" worktree add --detach "$WORKDIR" "$HEAD_SHA"
fi

# Init owletto submodule in the worktree. bun install --frozen-lockfile
# requires it.
git -C "$WORKDIR" submodule update --init packages/owletto >/dev/null

cd "$WORKDIR"

# --- env --------------------------------------------------------------------

TEST_DB="lobu_pi_review_$PR"
# Default DATABASE_URL — operator can override by exporting before running.
PG_BASE_URL="${PI_REVIEW_PG_BASE_URL:-postgres://postgres@127.0.0.1:5432}"
DATABASE_URL="${PI_REVIEW_DATABASE_URL:-${PG_BASE_URL}/${TEST_DB}}"

# Sanity-check Postgres reachability against the base (postgres db, no DB
# specified) so a missing test DB doesn't masquerade as "Postgres is down."
if ! psql "${PG_BASE_URL}/postgres" -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "Cannot reach Postgres at $PG_BASE_URL — start postgres or set PI_REVIEW_PG_BASE_URL / PI_REVIEW_DATABASE_URL." >&2
  exit 2
fi

# DROP + CREATE = idempotent per-PR test DB.
psql "${PG_BASE_URL}/postgres" -tAc "DROP DATABASE IF EXISTS \"$TEST_DB\"" >/dev/null
psql "${PG_BASE_URL}/postgres" -tAc "CREATE DATABASE \"$TEST_DB\"" >/dev/null
psql "$DATABASE_URL" -tAc "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null || true

cat > .env <<EOF
DATABASE_URL=$DATABASE_URL
BETTER_AUTH_SECRET=pi-review-local-not-prod-not-prod-not-prod
ENCRYPTION_KEY=pi-review-local-encryption-key-32b!
LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1
PORT=8787
EOF

# --- install + build --------------------------------------------------------

SETUP_OK=1
echo ">> bun install --frozen-lockfile"
if ! bun install --frozen-lockfile; then
  echo "!! bun install failed"
  SETUP_OK=0
fi
echo ">> make build-packages"
if ! make build-packages; then
  echo "!! make build-packages failed"
  SETUP_OK=0
fi

# --- test suites ------------------------------------------------------------

TYPECHECK_LOG="/tmp/pi-review-$PR-typecheck.log"
UNIT_LOG="/tmp/pi-review-$PR-unit.log"
INTEGRATION_LOG="/tmp/pi-review-$PR-integration.log"

echo ">> typecheck → $TYPECHECK_LOG"
set +e
bun run typecheck > "$TYPECHECK_LOG" 2>&1
TYPECHECK_EXIT=$?
set -e

echo ">> unit tests → $UNIT_LOG"
# Worst-exit aggregation: each `bun test` runs independently, the final exit
# code is the max across all of them. set +e so a single failure doesn't kill
# the loop.
set +e
UNIT_EXIT=0
{
  echo "::group::core + cli"
  bun test packages/core packages/cli; ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  echo "::endgroup::"
  echo "::group::agent-worker"
  bun test packages/agent-worker; ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  echo "::endgroup::"
  echo "::group::server unit subdirs"
  bun test packages/server/src/__tests__/unit; ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/server/src/auth/__tests__/tool-access.test.ts; ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  bun test packages/server/src/gateway/infrastructure/queue; ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  echo "::endgroup::"
  echo "::group::connector-worker"
  bun test packages/connector-worker; ec=$?; [ $ec -gt $UNIT_EXIT ] && UNIT_EXIT=$ec
  echo "::endgroup::"
} > "$UNIT_LOG" 2>&1
set -e

echo ">> integration tests → $INTEGRATION_LOG"
set +e
INTEGRATION_EXIT=0
{
  echo "::group::server vitest"
  (cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default); ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  echo "::endgroup::"
  echo "::group::server gateway (bun:test, Postgres)"
  (cd packages/server && bun test src/gateway/__tests__); ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  echo "::endgroup::"
  echo "::group::server lobu + workspace (bun:test, Postgres)"
  (cd packages/server && bun test src/lobu/__tests__ src/workspace/__tests__); ec=$?; [ $ec -gt $INTEGRATION_EXIT ] && INTEGRATION_EXIT=$ec
  echo "::endgroup::"
} > "$INTEGRATION_LOG" 2>&1
set -e

echo ">> suite exit codes: typecheck=$TYPECHECK_EXIT unit=$UNIT_EXIT integration=$INTEGRATION_EXIT (setup_ok=$SETUP_OK)"

# --- pi ---------------------------------------------------------------------

PROMPT_FILE="$WORKDIR/prompts/review-prompt.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "prompt not found: $PROMPT_FILE" >&2
  exit 2
fi

echo ">> invoking pi"
set +e
RAW="$(
  PR_NUMBER="$PR" \
  TYPECHECK_LOG="$TYPECHECK_LOG" \
  TYPECHECK_EXIT="$TYPECHECK_EXIT" \
  UNIT_LOG="$UNIT_LOG" \
  UNIT_EXIT="$UNIT_EXIT" \
  INTEGRATION_LOG="$INTEGRATION_LOG" \
  INTEGRATION_EXIT="$INTEGRATION_EXIT" \
  GH_TOKEN="$(gh auth token)" \
  DATABASE_URL="$DATABASE_URL" \
  pi \
    --mode json \
    --no-session \
    -p "@${PROMPT_FILE}" "PR_NUMBER=$PR — review this PR. Emit only the JSON verdict."
)"
PI_EXIT=$?
set -e

# pi --mode json may wrap each message in an envelope (multi-turn) OR emit a
# single object. Try the multi-turn extraction first; fall back to raw.
VERDICT="$(printf '%s\n' "$RAW" | jq -rs '
  [.[] | select(.role == "assistant")] | last | .content // empty
' 2>/dev/null || true)"
if [ -z "$VERDICT" ]; then
  VERDICT="$RAW"
fi
VERDICT="$(printf '%s\n' "$VERDICT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"

VALID=1
if ! echo "$VERDICT" | jq -e '.confidence != null and .bugs != null and .slop != null and (.blockers|type=="array")' >/dev/null 2>&1; then
  VALID=0
fi

# --- post check-run + comment ----------------------------------------------

if [ "$VALID" = "1" ]; then
  CONFIDENCE="$(echo "$VERDICT" | jq -r .confidence)"
  BUGS="$(echo "$VERDICT" | jq -r .bugs)"
  SLOP="$(echo "$VERDICT" | jq -r .slop)"
  BLOCKER_COUNT="$(echo "$VERDICT" | jq -r '.blockers|length')"
  HEADLINE="confidence $CONFIDENCE, bugs $BUGS, slop $SLOP, $BLOCKER_COUNT blockers"
  TITLE="pi: $HEADLINE"
  NOTES="$(echo "$VERDICT" | jq -r '.notes // ""')"
  PRETTY="$(echo "$VERDICT" | jq .)"
  SUGGESTIONS_TABLE="$(echo "$VERDICT" | jq -r '
    if (.suggested_fixes // []) | length == 0 then ""
    else
      "\n\n### Suggested fixes\n\n| File | Line | Change |\n| --- | --- | --- |\n" +
      ((.suggested_fixes // []) | map("| `\(.file)` | \(.line // "") | \(.change) |") | join("\n"))
    end
  ')"
  BLOCKERS_LIST="$(echo "$VERDICT" | jq -r '
    if (.blockers // []) | length == 0 then ""
    else
      "\n\n### Blockers\n\n" + ((.blockers // []) | map("- " + .) | join("\n"))
    end
  ')"
  # shellcheck disable=SC2016
  SUMMARY="$(printf '**%s**\n\n%s%s%s\n\n<details><summary>Full verdict JSON</summary>\n\n```json\n%s\n```\n\n</details>\n\n_Shadow mode — verdict does not gate merges. See `docs/REVIEW_SCHEMA.md`._' \
    "$HEADLINE" "$NOTES" "$BLOCKERS_LIST" "$SUGGESTIONS_TABLE" "$PRETTY")"
else
  TITLE="pi: error"
  SUMMARY="pi-review failed to produce a valid JSON verdict. pi exit=$PI_EXIT. Inspect logs at $TYPECHECK_LOG, $UNIT_LOG, $INTEGRATION_LOG."
fi

# Idempotent check-run upsert.
EXISTING_CHECK_ID="$(gh api "repos/lobu-ai/lobu/commits/$HEAD_SHA/check-runs?check_name=pi-review&app_id=15368" --jq '.check_runs[0].id' 2>/dev/null || true)"
if [ -z "$EXISTING_CHECK_ID" ] || [ "$EXISTING_CHECK_ID" = "null" ]; then
  # GH CLI auth uses an OAuth app — query by name instead of app_id.
  EXISTING_CHECK_ID="$(gh api "repos/lobu-ai/lobu/commits/$HEAD_SHA/check-runs" --jq '.check_runs[] | select(.name=="pi-review") | .id' 2>/dev/null | head -n1)"
fi

CHECK_PAYLOAD="$(jq -n \
  --arg name "pi-review" \
  --arg head_sha "$HEAD_SHA" \
  --arg title "$TITLE" \
  --arg summary "$SUMMARY" \
  '{name:$name, head_sha:$head_sha, status:"completed", conclusion:"neutral", output:{title:$title, summary:$summary}}')"

if [ -n "$EXISTING_CHECK_ID" ] && [ "$EXISTING_CHECK_ID" != "null" ]; then
  echo ">> updating existing check-run $EXISTING_CHECK_ID"
  CHECK_URL="$(echo "$CHECK_PAYLOAD" | gh api -X PATCH "repos/lobu-ai/lobu/check-runs/$EXISTING_CHECK_ID" --input - --jq .html_url)"
else
  echo ">> creating new check-run"
  CHECK_URL="$(echo "$CHECK_PAYLOAD" | gh api -X POST "repos/lobu-ai/lobu/check-runs" --input - --jq .html_url)"
fi

# Idempotent PR comment via marker.
MARKER="<!-- pi-review-marker -->"
COMMENT_BODY="$MARKER
$SUMMARY

[View check-run]($CHECK_URL)"

EXISTING_COMMENT_ID="$(gh api "repos/lobu-ai/lobu/issues/$PR/comments" --paginate --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | head -n1)"
if [ -n "$EXISTING_COMMENT_ID" ]; then
  echo ">> updating existing PR comment $EXISTING_COMMENT_ID"
  jq -n --arg body "$COMMENT_BODY" '{body:$body}' \
    | gh api -X PATCH "repos/lobu-ai/lobu/issues/comments/$EXISTING_COMMENT_ID" --input - >/dev/null
else
  echo ">> creating new PR comment"
  jq -n --arg body "$COMMENT_BODY" '{body:$body}' \
    | gh api -X POST "repos/lobu-ai/lobu/issues/$PR/comments" --input - >/dev/null
fi

echo ""
echo "=========================================="
echo "pi-review for PR #$PR complete."
echo "  PR:        $PR_URL"
echo "  check-run: $CHECK_URL"
echo "  worktree:  $WORKDIR (kept for re-runs)"
echo "  logs:      $TYPECHECK_LOG"
echo "             $UNIT_LOG"
echo "             $INTEGRATION_LOG"
echo "  verdict:   $TITLE"
echo "=========================================="

if [ "$VALID" != "1" ]; then
  exit 1
fi
