#!/usr/bin/env bash
# Checkout packages/owletto to the SHA pinned by the parent repo.
#
# Safe by default: exits if the submodule has local edits. Pass RESET_OWLETTO=1
# to discard uncommitted owletto changes (reset --hard + clean -fd).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWLETTO="$ROOT/packages/owletto"
cd "$ROOT"

owletto_dirty() {
  [ -d "$OWLETTO/.git" ] || [ -f "$OWLETTO/.git" ] || return 1
  ! git -C "$OWLETTO" diff --quiet \
    || ! git -C "$OWLETTO" diff --cached --quiet \
    || [ -n "$(git -C "$OWLETTO" ls-files --others --exclude-standard)" ]
}

if owletto_dirty; then
  if [ "${RESET_OWLETTO:-}" != "1" ]; then
    echo "error: packages/owletto has local changes (uncommitted or untracked)." >&2
    echo >&2
    git -C "$OWLETTO" status --short >&2 || true
    echo >&2
    cat >&2 <<'EOF'
Refusing to overwrite them. Options:
  • Keep your work: commit in packages/owletto, or use a worktree (make task-setup)
    for owletto development.
  • Discard owletto-only edits and continue:
    RESET_OWLETTO=1 make owletto-mac
    RESET_OWLETTO=1 make owletto-mac-e2e
EOF
    exit 1
  fi

  echo ">> RESET_OWLETTO=1 — discarding local packages/owletto edits"
  git -C "$OWLETTO" reset --hard
  git -C "$OWLETTO" clean -fd
fi

git submodule update --init packages/owletto