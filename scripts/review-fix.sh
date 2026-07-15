#!/usr/bin/env bash
# Pre-review fixer: runs the reviewer CLI over the local diff with WRITE
# access and prompts/review-fix-prompt.md, so review-grade findings get fixed
# BEFORE `make review` posts a pi-review status. Posts nothing; commits
# nothing. The driving agent inspects the edits (shown at the end), commits,
# then runs `make review` once on the settled HEAD.
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_BRANCH="${BASE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || { echo "usage: scripts/review-fix.sh [--base <branch>]" >&2; exit 2; }
      BASE_BRANCH="$2"
      shift 2
      ;;
    *)
      echo "usage: scripts/review-fix.sh [--base <branch>]" >&2
      exit 2
      ;;
  esac
done
if [ -z "$BASE_BRANCH" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    BASE_BRANCH="origin/main"
  else
    BASE_BRANCH="main"
  fi
fi

PROMPT_FILE="prompts/review-fix-prompt.md"
[ -f "$PROMPT_FILE" ] || { echo ">> missing $PROMPT_FILE" >&2; exit 1; }

if git diff --quiet "$BASE_BRANCH...HEAD" 2>/dev/null && git diff --quiet && git diff --cached --quiet; then
  echo ">> no diff against $BASE_BRANCH and no local changes; nothing to fix"
  exit 0
fi

command -v codex >/dev/null 2>&1 || { echo ">> codex not found on PATH" >&2; exit 1; }

LAST_MSG_FILE="$(mktemp /tmp/lobu-review-fix.XXXXXX)"
trap 'rm -f "$LAST_MSG_FILE"' EXIT

echo ">> pre-review fixer (codex, base $BASE_BRANCH) — edits the working tree, posts nothing"
CODEX_ARGS=(codex exec --sandbox workspace-write --output-last-message "$LAST_MSG_FILE" --ephemeral)
if [ -n "${CODEX_REVIEW_MODEL:-}" ]; then
  CODEX_ARGS+=(--model "$CODEX_REVIEW_MODEL")
fi

set +e
env BASE_BRANCH="$BASE_BRANCH" "${CODEX_ARGS[@]}" "$(cat "$PROMPT_FILE")" < /dev/null > /dev/null
FIXER_EXIT=$?
set -e

echo
echo "========== fixer summary =========="
if [ -s "$LAST_MSG_FILE" ]; then
  cat "$LAST_MSG_FILE"
else
  echo "(no summary emitted)"
fi
echo "==================================="
echo
echo ">> working-tree changes made by the fixer (staged + unstaged; verify before committing):"
git status --short
git diff --stat HEAD
exit "$FIXER_EXIT"
