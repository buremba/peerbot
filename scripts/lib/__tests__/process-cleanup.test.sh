#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=scripts/lib/process-cleanup.sh
. "$ROOT/scripts/lib/process-cleanup.sh"

listener_pid=""
fake_bin=""
original_path="$PATH"
cleanup() {
  [[ -n "$listener_pid" ]] && kill "$listener_pid" 2>/dev/null || true
  [[ -n "$fake_bin" ]] && rm -rf "$fake_bin"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

sleep 30 &
listener_pid=$!

# Stub lsof at the function boundary. The implementation must consume its
# output directly and must not depend on GNU xargs being available.
lsof() {
  printf '%s\n' "$listener_pid"
}

lobu_kill_listening_port 8795
wait "$listener_pid" 2>/dev/null || true
if kill -0 "$listener_pid" 2>/dev/null; then
  fail "listener survived cleanup"
fi
listener_pid=""

# No listener is a normal idempotent cleanup case.
lsof() {
  return 1
}
lobu_kill_listening_port 8795

# The published-artifact smoke's minimal Linux container has fuser but no
# lsof. Exercise that fallback with a fake fuser on an otherwise-empty PATH.
unset -f lsof
sleep 30 &
listener_pid=$!
export TEST_LISTENER_PID="$listener_pid"
fake_bin="$(mktemp -d)"
printf '%s\n' '#!/bin/sh' 'kill -9 "$TEST_LISTENER_PID"' > "$fake_bin/fuser"
chmod +x "$fake_bin/fuser"
PATH="$fake_bin"
lobu_kill_listening_port 8795
PATH="$original_path"
wait "$listener_pid" 2>/dev/null || true
if kill -0 "$listener_pid" 2>/dev/null; then
  fail "listener survived fuser cleanup"
fi
listener_pid=""

echo "OK process cleanup tests"
