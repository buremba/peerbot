#!/usr/bin/env bash
# task-use.sh — point external tools (Chrome extension, Xcode/Mac app) at a
# specific worktree's source by retargeting fixed symlinks.
#
# Usage:
#   scripts/task-use.sh <name>     # use the worktree at .claude/worktrees/<name>
#   scripts/task-use.sh main       # use the main checkout (no worktree)
#
# Symlinks (created/updated each run):
#   ~/.config/lobu-dev/active/chrome  →  <root>/packages/owletto/apps/chrome
#   ~/.config/lobu-dev/active/mac     →  <root>/packages/owletto/apps/mac
#
# Point Chrome's "Load unpacked" at ~/.config/lobu-dev/active/chrome ONCE.
# Open Xcode against ~/.config/lobu-dev/active/mac. Then `task-use <name>`
# swaps which worktree those resolve to; reload the extension / re-open the
# Xcode project to pick up the new source.

set -euo pipefail

usage() {
  echo "usage: $0 <name|main>" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
name="$1"

if [[ "$name" != "main" ]] && ! [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "error: name must be kebab-case or 'main': '$name'" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$script_dir/.." && pwd)"

if [[ "$name" == "main" ]]; then
  source_root="$repo"
else
  source_root="$repo/.claude/worktrees/$name"
  if [[ ! -d "$source_root" ]]; then
    echo "error: no worktree at $source_root" >&2
    exit 1
  fi
fi

active_dir="$HOME/.config/lobu-dev/active"
mkdir -p "$active_dir"

set_link() {
  local label="$1" target="$2" link="$3"
  if [[ -d "$target" ]]; then
    ln -sfn "$target" "$link"
    echo "→ $label: $link → $target"
  else
    # Source path missing in this worktree (e.g. submodule not initialized).
    # Leave the existing symlink alone rather than break it.
    echo "(skip $label: source not present at $target)"
  fi
}

set_link "chrome" "$source_root/packages/owletto/apps/chrome" "$active_dir/chrome"
set_link "mac"    "$source_root/packages/owletto/apps/mac"    "$active_dir/mac"

# Record the active task name for tooling that wants it (and for task-clean
# to know whether to reset to 'main' when cleaning the active worktree).
echo "$name" > "$active_dir/.active-name"
echo "✓ active worktree: $name"
echo ""
echo "  ↳ Chrome will not auto-reload the extension when the symlink retargets."
echo "    Click 'Reload' on the owletto extension in chrome://extensions to pick"
echo "    up the new source. (MV3 service workers re-register on extension reload,"
echo "    not on symlink change.)"
