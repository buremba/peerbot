#!/usr/bin/env bash
# Run `claude` (Claude Code CLI) against the review prompt for a given PR
# and emit the JSON verdict.
#
# Usage:
#   ./scripts/run-claude-review.sh <PR_NUMBER>
#
# Env:
#   ANTHROPIC_API_KEY  required (or CLAUDE_CODE_OAUTH_TOKEN).
#
# Output: prints the JSON verdict to stdout. Non-zero exit if the model's
# output is not valid JSON.

set -euo pipefail

PR="${1:-}"
if [ -z "$PR" ]; then
  echo "usage: $0 <PR_NUMBER>" >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$REPO_ROOT/prompts/review-prompt.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "prompt not found: $PROMPT_FILE" >&2
  exit 2
fi

PROMPT_BODY="$(cat "$PROMPT_FILE")"

RAW="$(
  PR_NUMBER="$PR" claude -p \
    --output-format json \
    --permission-mode bypassPermissions \
    "$PROMPT_BODY

PR_NUMBER=$PR — review this PR. Emit only the JSON verdict."
)"

# claude --output-format json wraps the response. Extract the result field.
VERDICT="$(printf '%s\n' "$RAW" | jq -r '.result // empty')"
if [ -z "$VERDICT" ]; then
  VERDICT="$RAW"
fi

# Strip code fences if present.
VERDICT="$(printf '%s\n' "$VERDICT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"

echo "$VERDICT" | jq -e . >/dev/null || {
  echo "claude output is not valid JSON:" >&2
  echo "$VERDICT" >&2
  exit 1
}

echo "$VERDICT"
