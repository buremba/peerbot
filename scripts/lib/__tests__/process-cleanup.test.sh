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

grep -Fq '&& exec "$LOBU_BIN" run --port "$GW_PORT"' \
  "$ROOT/scripts/published-artifact-smoke.sh" || \
  fail "published smoke does not track the actual lobu run process"

saw_force_kill=false
kill() {
  [[ "${1:-}" = "-9" ]] && saw_force_kill=true
  builtin kill "$@"
}

ready_fifo="$fake_bin/term-responsive-ready"
term_marker="$fake_bin/term-responsive-seen"
mkfifo "$ready_fifo"
bash -c 'trap '\''printf "TERM\n" > "$2"; exit 0'\'' TERM; printf "ready\n" > "$1"; while :; do sleep 0.05; done' _ "$ready_fifo" "$term_marker" &
listener_pid=$!
IFS= read -r ready < "$ready_fifo"
[[ "$ready" = "ready" ]] || fail "TERM-responsive child did not become ready"
lobu_terminate_child "$listener_pid"
if kill -0 "$listener_pid" 2>/dev/null; then
  fail "TERM-responsive child survived cleanup"
fi
[[ -f "$term_marker" ]] || fail "TERM-responsive child did not observe SIGTERM"
$saw_force_kill && fail "TERM-responsive child received unnecessary SIGKILL"
listener_pid=""

# Confirm the bounded SIGKILL fallback too. The FIFO handshake guarantees its
# ignored-SIGTERM disposition is installed before cleanup starts.
ready_fifo="$fake_bin/term-ignorer-ready"
mkfifo "$ready_fifo"
bash -c 'trap "" TERM; printf "ready\n" > "$1"; exec sleep 30' _ "$ready_fifo" &
listener_pid=$!
IFS= read -r ready < "$ready_fifo"
[[ "$ready" = "ready" ]] || fail "TERM-ignoring child did not become ready"
saw_force_kill=false
lobu_terminate_child "$listener_pid" 1
if kill -0 "$listener_pid" 2>/dev/null; then
  fail "TERM-ignoring child survived forced cleanup"
fi
$saw_force_kill || fail "TERM-ignoring child did not receive SIGKILL fallback"
listener_pid=""

echo "OK process cleanup tests"
