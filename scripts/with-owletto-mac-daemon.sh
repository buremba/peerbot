#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT/packages/owletto/apps/mac/Owletto/lobu-device-daemon"
DAEMON="$RESOURCE_DIR/lobu-device-daemon"

die() { echo "error: $*" >&2; exit 1; }
cleanup() { rm -f -- "$DAEMON"; }

[[ $# -gt 0 ]] || die "usage: with-owletto-mac-daemon.sh <command> [args...]"
[[ -d "$RESOURCE_DIR" ]] \
  || die "Owletto daemon resource directory is missing; update packages/owletto"

# The resource is generated from this root checkout and must never be committed
# as submodule state. Clean up on every exit path we can trap; SIGKILL and a
# lost machine still bypass the traps, so clear a leftover artifact up front
# rather than trusting the previous run to have unwound.
cleanup
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

OUTPUT="$DAEMON" "$ROOT/scripts/build-mac-device-daemon.sh"
"$ROOT/scripts/verify-mac-device-daemon.sh" "$DAEMON"
"$@"
