#!/usr/bin/env bash
# task-use.sh — point the Chrome extension at a specific worktree's source by
# retargeting a fixed symlink.
#
# Usage:
#   scripts/task-use.sh <name>     # use the worktree at .claude/worktrees/<name>
#   scripts/task-use.sh main       # use the main checkout (no worktree)
#
# Symlink (created/updated each run):
#   ~/.config/lobu-dev/active/chrome  →  <root>/packages/owletto/apps/chrome
#
# Point Chrome's "Load unpacked" at ~/.config/lobu-dev/active/chrome ONCE.
# Then `task-use <name>` swaps which worktree it resolves to; reload the
# extension at chrome://extensions to pick up the new source.
#
# The Chrome extension's gateway URL is configured separately in the
# sidepanel ("Server URL"). Because each worktree's `make dev` runs on its
# own PORT (assigned in .env.local), the symlink retarget alone does NOT
# repoint the extension at the new server — re-open the sidepanel and update
# the URL to http://localhost:<PORT> for the active worktree.
#
# Xcode/Mac is intentionally NOT symlinked. Open the .xcodeproj at the
# worktree path directly (`packages/owletto/apps/mac` inside the worktree).
# The Mac menubar reads ~/.config/lobu/config.json on every popover, so
# per-worktree Lobu contexts (registered by task-setup) appear in its picker
# automatically — no separate "active mac" indirection is required.

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
# Resolve `repo` to the main checkout, not whatever worktree the script
# happens to live inside. Worktrees share the working tree (scripts/
# included), so a naive `$script_dir/..` returns the calling worktree's
# root — and task-use would retarget the active/chrome symlink at
# `<calling-worktree>/.claude/worktrees/<name>/packages/...`, nested inside
# whatever worktree the operator happened to be in. Same fix as
# task-setup.sh (#899/#900): use git's shared .git path with
# --path-format=absolute so the resolution is invariant to cwd.
repo="$(dirname "$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)")"

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

# Record the active task name for tooling that wants it (and for task-clean
# to know whether to reset to 'main' when cleaning the active worktree).
echo "$name" > "$active_dir/.active-name"

# Surface the worktree's PORT so the operator is reminded to update the
# Chrome extension's "Server URL" sidepanel setting — the source symlink
# and the gateway URL are independent switches, and stale URLs are the
# single most common footgun across worktree switches.
active_port=""
if [[ "$name" != "main" ]]; then
  env_local="$source_root/.env.local"
  if [[ -f "$env_local" ]]; then
    active_port="$(awk -F= '/^PORT=/{print $2; exit}' "$env_local" | tr -d '[:space:]')"
  fi
fi

echo "✓ active worktree: $name"
if [[ -n "$active_port" ]]; then
  echo "  ↳ Chrome ext: set Server URL to http://localhost:$active_port"
  echo "    (open the owletto sidepanel; or reset via chrome://extensions → Reload)"
else
  echo "  ↳ Chrome ext: confirm Server URL points at this worktree's gateway"
fi
echo "    MV3 service workers re-register on extension reload, not on symlink change."
