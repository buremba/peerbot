#!/usr/bin/env bash
set -euo pipefail

DAEMON="${1:-}"

die() { echo "error: $*" >&2; exit 1; }

[[ -n "$DAEMON" ]] || die "usage: verify-mac-device-daemon.sh <path>"
[[ -x "$DAEMON" ]] || die "Mac device daemon is missing or not executable: $DAEMON"

file "$DAEMON" | grep -q 'Mach-O 64-bit executable arm64' \
  || die "Mac device daemon is not an arm64 Mach-O: $DAEMON"

VERSION_JSON="$("$DAEMON" --version)"
case "$VERSION_JSON" in
  *'"name":"lobu-device-daemon"'*'"protocol":"device-daemon/v2"'*'"platform":"macos"'*) ;;
  *) die "Mac device daemon reported unexpected metadata: $VERSION_JSON" ;;
esac

echo "$VERSION_JSON"
