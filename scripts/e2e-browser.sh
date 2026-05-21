#!/usr/bin/env bash
# e2e-browser.sh — launch (or reuse) the stable Owletto Chrome harness for e2e.
#
# Mirrors the Mac-app model: one persistent browser profile, paired once,
# reused from every agent session. The extension's fixed manifest "key" pins
# its ID regardless of where it's loaded from, so the extension's
# chrome.storage.local (gateway URL + access/refresh tokens + workerId) lives
# in the --profile dir and survives restarts — and carries across worktrees,
# because the ID never changes. So you pair once and reuse forever, exactly
# like installing Owletto.app once.
#
# Usage:
#   scripts/e2e-browser.sh              # extension = current worktree, open its gateway
#   scripts/e2e-browser.sh --restart    # force a fresh launch (pick up extension edits or a new worktree)
#   make e2e-browser                    # same, from a worktree root
#
# Stable handles — reuse these verbatim from any agent session:
#   profile   ~/.config/lobu-dev/chrome   (--profile: persists pairing/cookies/storage)
#   session   owletto                      (--session: the daemon-managed browser)
#
# Drive it after launch:
#   agent-browser --session owletto snapshot -i      # refs for click/fill
#   agent-browser --session owletto open <url>        # navigate
#   agent-browser --session owletto close             # shut it down
#
# The headed window may close when left idle, but the daemon keeps the
# session's launch config: the next `agent-browser --session owletto <cmd>`
# (or re-running this script) revives the browser WITH the extension. So a
# vanished window is not a re-pair — just poke the session.
#
# After editing extension source, reload it (chrome://extensions -> reload) or
# re-run with --restart (the --extension flag only applies at browser launch).
# Mac e2e needs no equivalent: the installed Owletto.app reads
# ~/.config/lobu/config.json on every popover, so worktree Lobu contexts
# registered by task-setup show up in its picker automatically.

set -euo pipefail

restart=0
[[ "${1:-}" == "--restart" ]] && restart=1

command -v agent-browser >/dev/null 2>&1 || {
  echo "error: agent-browser not on PATH (npm i -g agent-browser, or brew install agent-browser)" >&2
  exit 1
}

source_root="$(git rev-parse --show-toplevel)"
ext="$source_root/packages/owletto/apps/chrome"
[[ -d "$ext" ]] || { echo "error: no extension source at $ext" >&2; exit 1; }

# Gateway URL = this worktree's PORT (.env.local), defaulting to the canonical 8787.
port=8787
if [[ -f "$source_root/.env.local" ]]; then
  p="$(awk -F= '/^PORT=/{print $2; exit}' "$source_root/.env.local" | tr -d '[:space:]')"
  [[ -n "$p" ]] && port="$p"
fi
url="http://localhost:$port"

profile="$HOME/.config/lobu-dev/chrome"
session="owletto"
mkdir -p "$profile"

# Decide reuse vs (re)launch. A session can linger in the daemon's list after
# its browser window has died, so don't trust `session list` alone — probe the
# actual browser with a gateway-independent navigation (about:blank succeeds
# even when `make dev` is down). RESTART=1 always relaunches.
relaunch=1
if [[ $restart -eq 0 ]] \
  && agent-browser session list 2>/dev/null | grep -qE "^[[:space:]]*${session}$"; then
  if agent-browser --session "$session" open "about:blank" >/dev/null 2>&1; then
    relaunch=0
  else
    echo "-> '$session' session was stale (browser gone); relaunching"
    agent-browser --session "$session" close >/dev/null 2>&1 || true
  fi
elif [[ $restart -eq 1 ]]; then
  agent-browser --session "$session" close >/dev/null 2>&1 || true
fi

if [[ $relaunch -eq 0 ]]; then
  echo "-> reusing running '$session' session"
  echo "   (use --restart to reload the extension after source/worktree changes)"
  # Non-fatal: a down gateway shouldn't fail the harness — the browser is up.
  agent-browser --session "$session" open "$url" >/dev/null 2>&1 || true
else
  agent-browser --session "$session" --profile "$profile" --extension "$ext" --headed open "$url" >/dev/null 2>&1 || true
  echo "-> launched '$session'"
  echo "   profile:   $profile"
  echo "   extension: $ext"
fi

echo "OK Owletto e2e browser ready"
echo "   gateway:   $url"
echo "   sidepanel: set 'Server URL' to $url the first time you pair against this worktree"
echo "   drive it:  agent-browser --session $session snapshot -i"
