# review-process.sh — process-session ownership for the destructive review gate.
# shellcheck shell=bash

REVIEW_PROCESS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEW_ACTIVE_CHILD_PID=""
REVIEW_ACTIVE_CONTROL_DIR=""
REVIEW_PREVIOUS_BACKGROUND_PID=""
REVIEW_INLINE_RAW_FILE=""

review_process_control_root() {
  if [ -n "${REVIEW_PROCESS_CONTROL_ROOT_FOR_TESTS:-}" ]; then
    printf '%s\n' "$REVIEW_PROCESS_CONTROL_ROOT_FOR_TESTS"
  else
    printf '/tmp/lobu-review-processes-%s\n' "$(id -u)"
  fi
}

review_read_pid_file() {
  local path="$1" value
  [ -f "$path" ] || return 1
  value="$(sed -n '1p' "$path" 2>/dev/null || true)"
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$value"
}

run_review_child() {
  local child_exit control_root control_dir supervisor_pid nounset_enabled
  local -a command
  [ "$#" -gt 0 ] || return 2

  control_root="$(review_process_control_root)"
  mkdir -p "$control_root"
  chmod 700 "$control_root"
  control_dir="$(mktemp -d "$control_root/run.XXXXXX")"
  nounset_enabled=0
  case "$-" in *u*) nounset_enabled=1; set +u ;; esac
  REVIEW_PREVIOUS_BACKGROUND_PID="$!"
  [ "$nounset_enabled" = "0" ] || set -u
  REVIEW_ACTIVE_CONTROL_DIR="$control_dir"
  REVIEW_ACTIVE_CHILD_PID=""

  if declare -F "$1" >/dev/null 2>&1; then
    # The function name is intentionally dynamic.
    # shellcheck disable=SC2163
    export -f "$1"
    command=(bash -c "$1")
  else
    command=("$@")
  fi

  python3 "$REVIEW_PROCESS_LIB_DIR/review-process-supervisor.py" \
    --control-dir "$control_dir" -- "${command[@]}" &
  if [ -n "${REVIEW_PARENT_PUBLISH_DELAY_FOR_TESTS:-}" ]; then
    sleep "$REVIEW_PARENT_PUBLISH_DELAY_FOR_TESTS"
  fi
  supervisor_pid=$!
  REVIEW_ACTIVE_CHILD_PID="$supervisor_pid"

  if wait "$supervisor_pid"; then
    child_exit=0
  else
    child_exit=$?
  fi

  REVIEW_ACTIVE_CHILD_PID=""
  REVIEW_ACTIVE_CONTROL_DIR=""
  REVIEW_PREVIOUS_BACKGROUND_PID=""
  rm -rf "$control_dir"
  return "$child_exit"
}

stop_active_review_child() {
  local control_dir supervisor_pid process_group last_background_pid attempts nounset_enabled
  control_dir="$REVIEW_ACTIVE_CONTROL_DIR"
  supervisor_pid="$REVIEW_ACTIVE_CHILD_PID"
  nounset_enabled=0
  case "$-" in *u*) nounset_enabled=1; set +u ;; esac
  last_background_pid="$!"
  [ "$nounset_enabled" = "0" ] || set -u
  [ -n "$control_dir" ] || return 0

  # If a signal interrupted the shell between `python3 ... &` and publishing
  # `$!`, wait for the supervisor's atomically-written identity instead of
  # guessing from the shell's previous background job.
  attempts=0
  while [ -z "$supervisor_pid" ] && [ "$attempts" -lt 100 ]; do
    supervisor_pid="$(review_read_pid_file "$control_dir/supervisor.pid" || true)"
    [ -n "$supervisor_pid" ] && break
    sleep 0.01
    attempts=$((attempts + 1))
  done
  if [ -z "$supervisor_pid" ] && [ -n "$last_background_pid" ] &&
    [ "$last_background_pid" != "$REVIEW_PREVIOUS_BACKGROUND_PID" ]; then
    supervisor_pid="$last_background_pid"
  fi

  if [ -n "$supervisor_pid" ]; then
    kill -TERM "$supervisor_pid" 2>/dev/null || true
  fi

  attempts=0
  while [ "$attempts" -lt 240 ]; do
    process_group="$(review_read_pid_file "$control_dir/process-group.pid" || true)"
    if [ -n "$supervisor_pid" ] && ! kill -0 "$supervisor_pid" 2>/dev/null; then
      if [ -z "$process_group" ] || ! kill -0 "-$process_group" 2>/dev/null; then
        break
      fi
    fi
    sleep 0.025
    attempts=$((attempts + 1))
  done

  process_group="$(review_read_pid_file "$control_dir/process-group.pid" || true)"
  if [ -n "$process_group" ] && kill -0 "-$process_group" 2>/dev/null; then
    kill -KILL "-$process_group" 2>/dev/null || true
    while kill -0 "-$process_group" 2>/dev/null; do
      sleep 0.025
    done
  fi

  if [ -n "$supervisor_pid" ] && kill -0 "$supervisor_pid" 2>/dev/null; then
    kill -KILL "$supervisor_pid" 2>/dev/null || true
  fi
  [ -z "$supervisor_pid" ] || wait "$supervisor_pid" 2>/dev/null || true

  REVIEW_ACTIVE_CHILD_PID=""
  REVIEW_ACTIVE_CONTROL_DIR=""
  REVIEW_PREVIOUS_BACKGROUND_PID=""
  rm -rf "$control_dir"
}

review_process_abort_inline() {
  if [ -n "$REVIEW_INLINE_RAW_FILE" ] && [ -s "$REVIEW_INLINE_RAW_FILE" ]; then
    echo ">> interrupted inline Claude output preserved at $REVIEW_INLINE_RAW_FILE" >&2
  else
    rm -f "${REVIEW_INLINE_RAW_FILE:-}"
  fi
  REVIEW_INLINE_RAW_FILE=""
}
