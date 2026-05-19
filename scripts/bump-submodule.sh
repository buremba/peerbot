#!/usr/bin/env bash
# bump-submodule.sh — open a one-line submodule pointer PR via a lightweight worktree.
#
# Usage:
#   make bump SUBMODULE=packages/owletto                       # bump to origin/main
#   make bump SUBMODULE=packages/owletto TARGET=abc123def      # bump to specific SHA / ref
#   make bump SUBMODULE=packages/owletto NAME=cancel-button    # custom slug
#
# This is the cheap shortcut for the trivial "bump a submodule pointer" case.
# For agent work that also touches submodule code, use `make task-setup` instead,
# which sets up the full dev environment (ports, .env, bun install, etc).
#
# What this script DOES NOT do that task-setup does:
#   - bun install            (no dev server runs here)
#   - .env copy              (no secrets needed for a pointer commit)
#   - port allocation        (no listener)
#   - Lobu CLI context       (nothing to talk to)
#
# It just creates a worktree off origin/main, advances the submodule pointer,
# commits, pushes, and opens an auto-merge PR.
#
# Why this exists: the convention is `~/Code/lobu` is read-only for agents
# (see AGENTS.md "Scope discipline"). Without this shortcut, agents reach
# for the main checkout to do "trivial" bumps because task-setup feels
# heavyweight for a one-line change. This makes worktree the easy path.
set -euo pipefail

SUBMODULE=${1:?Usage: bump-submodule.sh <submodule-path> [target-sha-or-ref]}
TARGET=${2:-origin/main}

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Verify SUBMODULE is actually a configured submodule
if ! grep -qE "^\s*path\s*=\s*${SUBMODULE//\//\\/}$" .gitmodules 2>/dev/null; then
    echo "error: '$SUBMODULE' is not a configured submodule (no matching path= entry in .gitmodules)" >&2
    echo "available submodules:" >&2
    grep -E '^\s*path\s*=' .gitmodules | awk -F= '{print "  " $2}' >&2
    exit 1
fi

NAME=${NAME:-"$(basename "$SUBMODULE")-$(date +%Y%m%d-%H%M%S)"}
SLUG="bump-${NAME}"
BRANCH="chore/${SLUG}"
WT="$REPO_ROOT/.claude/worktrees/$SLUG"

if [[ -e "$WT" ]]; then
    echo "error: worktree $WT already exists; pick a different NAME or run: make task-clean NAME=$SLUG FORCE=1" >&2
    exit 1
fi

echo "→ fetching latest main"
git fetch origin main --quiet

echo "→ creating worktree at $WT on branch $BRANCH"
git worktree add "$WT" -b "$BRANCH" origin/main >/dev/null
# Drop the same .task marker task-setup uses so `git worktree list` can tell
# this apart from agent-* isolation worktrees, and so task-clean knows where to look.
touch "$WT/.task"

echo "→ initializing $SUBMODULE in the new worktree"
git -C "$WT" submodule update --init -- "$SUBMODULE" >/dev/null

echo "→ resolving $TARGET in $SUBMODULE"
git -C "$WT/$SUBMODULE" fetch origin --quiet
# Cleanup helper: remove the worktree AND its branch ref so a re-run with the
# same NAME doesn't trip the "worktree already exists" or "branch already exists"
# guard. `git worktree remove` only removes the tree, not the branch.
cleanup_worktree() {
    git worktree remove "$WT" --force 2>/dev/null || true
    git branch -D "$BRANCH" 2>/dev/null || true
}

if ! TARGET_SHA=$(git -C "$WT/$SUBMODULE" rev-parse "$TARGET" 2>/dev/null); then
    echo "error: can't resolve $TARGET inside $SUBMODULE" >&2
    cleanup_worktree
    exit 1
fi
BEFORE_SHA=$(git -C "$WT/$SUBMODULE" rev-parse HEAD)
if [[ "$BEFORE_SHA" == "$TARGET_SHA" ]]; then
    echo "→ $SUBMODULE is already at $TARGET ($BEFORE_SHA); nothing to bump"
    cleanup_worktree
    exit 0
fi

SHORT_BEFORE=$(git -C "$WT/$SUBMODULE" rev-parse --short "$BEFORE_SHA")
SHORT_AFTER=$(git -C "$WT/$SUBMODULE" rev-parse --short "$TARGET_SHA")
TARGET_SUBJECT=$(git -C "$WT/$SUBMODULE" log -1 --format='%s' "$TARGET_SHA")

echo "→ advancing $SUBMODULE: $SHORT_BEFORE → $SHORT_AFTER"
git -C "$WT/$SUBMODULE" checkout --detach "$TARGET_SHA" >/dev/null 2>&1

echo "→ committing pointer bump"
git -C "$WT" add "$SUBMODULE"
git -C "$WT" commit -m "chore: bump $SUBMODULE pointer to $SHORT_AFTER

Picks up: $TARGET_SUBJECT

Before: $SHORT_BEFORE
After:  $SHORT_AFTER" >/dev/null

echo "→ pushing $BRANCH"
git -C "$WT" push -u origin "$BRANCH" --quiet

if command -v gh >/dev/null 2>&1; then
    echo "→ opening PR"
    PR_URL=$(gh pr create --base main --head "$BRANCH" \
        --title "chore: bump $SUBMODULE pointer to $SHORT_AFTER" \
        --body "Bumps \`$SUBMODULE\` pointer.

\`\`\`
Before: $SHORT_BEFORE
After:  $SHORT_AFTER
\`\`\`

Picks up: $TARGET_SUBJECT" 2>&1 | tail -1)
    echo "  $PR_URL"
    echo "→ enabling auto-merge (squash)"
    gh pr merge "$PR_URL" --auto --squash >/dev/null 2>&1 || \
        echo "  (auto-merge enable failed — admin-merge with: gh pr merge $PR_URL --squash --admin)"
else
    echo "→ gh CLI not available; open the PR manually for branch $BRANCH"
fi

echo
echo "✓ done. After the PR merges, clean up:"
echo "  make task-clean NAME=$SLUG FORCE=1"
