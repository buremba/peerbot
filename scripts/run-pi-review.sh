#!/usr/bin/env bash
# Run `pi` against the review prompt for a given PR and emit the JSON verdict.
#
# Usage:
#   ./scripts/run-pi-review.sh <PR_NUMBER>
#
# Env:
#   ANTHROPIC_API_KEY  required — pi is run against the anthropic provider.
#   PI_MODEL           optional — defaults to claude-sonnet-4-5.
#
# Output: prints the JSON verdict to stdout. Non-zero exit if the model's
# output is not valid JSON.

set -euo pipefail

PR="${1:-}"
if [ -z "$PR" ]; then
  echo "usage: $0 <PR_NUMBER>" >&2
  exit 2
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is required" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$REPO_ROOT/prompts/review-prompt.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "prompt not found: $PROMPT_FILE" >&2
  exit 2
fi

MODEL="${PI_MODEL:-claude-sonnet-4-5}"

# `pi --mode json` makes pi emit one JSON object per turn instead of the
# default streaming text. We feed the prompt file plus the PR number as the
# message; pi can call `gh` itself to fetch the diff.
RAW="$(
  PR_NUMBER="$PR" pi \
    --provider anthropic \
    --model "$MODEL" \
    --mode json \
    --no-session \
    -p "@${PROMPT_FILE}" "PR_NUMBER=$PR — review this PR. Emit only the JSON verdict."
)"

# pi --mode json wraps each message in a JSON envelope. The final assistant
# message body is what we want. Extract it, then validate it parses as the
# verdict JSON.
VERDICT="$(printf '%s\n' "$RAW" | jq -rs '
  [.[] | select(.role == "assistant")] | last | .content // empty
')"

if [ -z "$VERDICT" ]; then
  # Fallback: pi may emit a single-object stream; treat the whole thing as
  # the verdict.
  VERDICT="$RAW"
fi

# Strip code fences if the model added them despite instructions.
VERDICT="$(printf '%s\n' "$VERDICT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"

# Validate.
echo "$VERDICT" | jq -e . >/dev/null || {
  echo "pi output is not valid JSON:" >&2
  echo "$VERDICT" >&2
  exit 1
}

echo "$VERDICT"
