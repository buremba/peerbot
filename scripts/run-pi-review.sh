#!/usr/bin/env bash
# Run `pi` against the review prompt for a given PR and emit the JSON verdict.
#
# Usage:
#   ./scripts/run-pi-review.sh <PR_NUMBER>
#
# Auth: reuses the operator's existing ~/.pi/agent state (ChatGPT-Codex).
# Provider/model/extensions come from ~/.pi/agent/settings.json — by default
# that's the openai-codex-3 profile (gpt-5.5 + thinking=high). This script
# never writes to ~/.pi/.
#
# Output: prints the JSON verdict to stdout. Non-zero exit if the model's
# output is not valid JSON.

set -euo pipefail

PR="${1:-}"
if [ -z "$PR" ]; then
  echo "usage: $0 <PR_NUMBER>" >&2
  exit 2
fi

if [ ! -f "$HOME/.pi/agent/auth.json" ]; then
  echo "~/.pi/agent/auth.json not found." >&2
  echo "Sign in to pi first (\`pi\` then complete the ChatGPT-Codex flow), or run from a host where pi is already authenticated." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$REPO_ROOT/prompts/review-prompt.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "prompt not found: $PROMPT_FILE" >&2
  exit 2
fi

# `pi --mode json` makes pi emit JSON envelopes per turn instead of streaming
# text. No --provider / --model flags: settings.json picks the defaults.
RAW="$(
  PR_NUMBER="$PR" pi \
    --mode json \
    --no-session \
    --no-extensions \
    --provider openai-codex-3 \
    --model gpt-5.5 \
    --thinking high \
    -p "@${PROMPT_FILE}" "PR_NUMBER=$PR — review this PR. Emit only the JSON verdict."
)"

# pi --mode json may wrap each message in an envelope (multi-turn) OR emit a
# single object. Try the multi-turn extraction first; fall back to the raw
# output. Then strip code fences if present, and validate as JSON.
VERDICT="$(printf '%s\n' "$RAW" | jq -rs '
  [.[] | select(.role == "assistant")] | last | .content // empty
' 2>/dev/null || true)"

if [ -z "$VERDICT" ]; then
  VERDICT="$RAW"
fi

VERDICT="$(printf '%s\n' "$VERDICT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"

echo "$VERDICT" | jq -e . >/dev/null || {
  echo "pi output is not valid JSON:" >&2
  echo "$VERDICT" >&2
  exit 1
}

echo "$VERDICT"
