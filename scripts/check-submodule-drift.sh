#!/usr/bin/env bash
# Validate the parent Owletto pointer without coupling unrelated PRs to the
# latest commit racing onto owletto/main.

set -euo pipefail

SUBMODULE_PATH="${SUBMODULE_PATH:-packages/owletto}"
EVENT_NAME="${EVENT_NAME:?EVENT_NAME is required}"
BOT_AUTHOR_EMAIL="${BOT_AUTHOR_EMAIL:-fluxcd@lobu.ai}"
BOT_SUBJECT="${BOT_SUBJECT:-chore: update images}"

die() {
  echo "::error::$*" >&2
  exit 1
}

PINNED="$(git -C "$SUBMODULE_PATH" rev-parse HEAD)"
git -C "$SUBMODULE_PATH" fetch --quiet origin main
REMOTE="$(git -C "$SUBMODULE_PATH" rev-parse origin/main)"

echo "Pinned (parent): $PINNED"
echo "owletto/main:    $REMOTE"

# Every proposed pin must be published on Owletto main. This remains a hard
# failure for all event types because off-main SHAs break deployment clones.
if ! git -C "$SUBMODULE_PATH" merge-base --is-ancestor "$PINNED" origin/main; then
  die "Pinned SHA $PINNED is not reachable from owletto/main."
fi

if [ "$EVENT_NAME" = "pull_request" ]; then
  PR_BASE_POINTER="${PR_BASE_POINTER:?PR_BASE_POINTER is required for pull_request}"
  PR_HEAD_POINTER="${PR_HEAD_POINTER:?PR_HEAD_POINTER is required for pull_request}"

  # Pointer PRs may advance to any already-merged Owletto commit. They do not
  # have to chase commits that land after the PR was opened, but rollbacks stay
  # review-blocking.
  if [ "$PR_BASE_POINTER" != "$PR_HEAD_POINTER" ]; then
    if ! git -C "$SUBMODULE_PATH" merge-base --is-ancestor "$PR_BASE_POINTER" "$PR_HEAD_POINTER"; then
      die "Owletto pointer moves backwards or sideways: $PR_BASE_POINTER -> $PR_HEAD_POINTER."
    fi
    # Git's submodule merge can fast-forward the synthetic merge commit past
    # the PR's requested pointer when base already carries a newer descendant.
    # Accept that result, but never a merge result that drops the requested SHA.
    if ! git -C "$SUBMODULE_PATH" merge-base --is-ancestor "$PR_HEAD_POINTER" "$PINNED"; then
      die "Checked-out pointer $PINNED does not include PR head pointer $PR_HEAD_POINTER."
    fi
  fi
fi

if [ "$PINNED" = "$REMOTE" ]; then
  echo "Submodule pin matches owletto/main — no drift."
  exit 0
fi

# Capture the log first so set -e propagates a git failure. tformat guarantees
# a trailing newline so read does not drop the last commit.
LOG="$(git -C "$SUBMODULE_PATH" log \
  --pretty='tformat:%h|%ae|%s' "$PINNED..origin/main")"

# FluxCD image-only commits do not require a parent pointer bump. Match both
# identity and exact subject, then verify the changed paths, so a human commit
# cannot bypass the drift signal with a lookalike subject.
DRIFT=""
while IFS='|' read -r sha email subject; do
  [ -z "$sha" ] && continue
  if [ "$email" = "$BOT_AUTHOR_EMAIL" ] && [ "$subject" = "$BOT_SUBJECT" ]; then
    outside="$(git -C "$SUBMODULE_PATH" show --name-only \
      --pretty='format:' "$sha" \
      | sed '/^$/d' \
      | grep -v '^deploy/' || true)"
    if [ -z "$outside" ]; then
      continue
    fi
    echo "::warning::Commit $sha matches bot author/subject but touches non-deploy paths; treating as drift."
  fi
  DRIFT+="$sha $subject"$'\n'
done <<< "$LOG"

if [ -z "$DRIFT" ]; then
  echo "owletto/main is ahead, but only by FluxCD image-tag commits — no parent bump needed."
  exit 0
fi

if [ "$EVENT_NAME" = "pull_request" ]; then
  if [ "$PR_BASE_POINTER" = "$PR_HEAD_POINTER" ]; then
    echo "::warning::owletto/main is ahead of the parent pin; this unrelated PR is not blocked."
  else
    echo "::notice::This PR advances the Owletto pointer safely; later Owletto commits remain for a follow-up bump."
  fi
  printf 'Commits still needing a parent bump:\n%s' "$DRIFT"
  exit 0
fi

echo "::error::owletto/main has merged commits past the pinned SHA. The parent bump is missing."
echo ""
echo "Pinned:       $PINNED"
echo "owletto/main: $REMOTE"
echo ""
echo "Commits needing a parent bump:"
printf '%s' "$DRIFT"
exit 1
