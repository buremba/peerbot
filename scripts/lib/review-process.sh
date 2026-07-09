# review-process.sh — child and Herdr lifecycle ownership for the review gate.
# shellcheck shell=bash

REVIEW_ACTIVE_CHILD_PID=""
REVIEW_HERDR_PANE_ID=""
REVIEW_HERDR_PANE_NAME=""
REVIEW_HERDR_RAW_FILE=""
REVIEW_HERDR_EXIT_FILE=""
REVIEW_INLINE_RAW_FILE=""

run_review_child() {
  local child_exit
  "$@" &
  REVIEW_ACTIVE_CHILD_PID=$!
  if wait "$REVIEW_ACTIVE_CHILD_PID"; then
    child_exit=0
  else
    child_exit=$?
  fi
  REVIEW_ACTIVE_CHILD_PID=""
  return "$child_exit"
}

review_descendant_pids() {
  local parent_pid="$1"
  local child_pid
  for child_pid in $(pgrep -P "$parent_pid" 2>/dev/null || true); do
    printf '%s\n' "$child_pid"
    review_descendant_pids "$child_pid"
  done
}

stop_active_review_child() {
  local child_pid descendant pid alive attempts
  local -a descendants
  child_pid="$REVIEW_ACTIVE_CHILD_PID"
  [ -n "$child_pid" ] || return 0

  descendants=()
  while IFS= read -r descendant; do
    [ -n "$descendant" ] && descendants[${#descendants[@]}]="$descendant"
  done < <(review_descendant_pids "$child_pid")
  kill -TERM "$child_pid" "${descendants[@]}" 2>/dev/null || true

  attempts=0
  while [ "$attempts" -lt 40 ]; do
    alive=0
    for pid in "$child_pid" "${descendants[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
        break
      fi
    done
    [ "$alive" = "1" ] || break
    sleep 0.05
    attempts=$((attempts + 1))
  done

  if [ "$alive" = "1" ]; then
    kill -KILL "$child_pid" "${descendants[@]}" 2>/dev/null || true
  fi
  wait "$child_pid" 2>/dev/null || true
  REVIEW_ACTIVE_CHILD_PID=""
}

register_review_herdr_pane() {
  local pane_name="$1"
  local start_output="$2"
  local pane_id
  REVIEW_HERDR_PANE_NAME="$pane_name"
  pane_id="$(printf '%s\n' "$start_output" | jq -r \
    '.result.pane_id // .result.pane.pane_id // .pane_id // empty' 2>/dev/null || true)"
  if [ -z "$pane_id" ]; then
    pane_id="$(herdr pane list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null | jq -r \
      --arg label "$pane_name" \
      '.result.panes[]? | select(.label == $label) | .pane_id' | head -n1)"
  fi
  REVIEW_HERDR_PANE_ID="$pane_id"
}

close_review_herdr_pane() {
  local pane_id="$REVIEW_HERDR_PANE_ID"
  if [ -z "$pane_id" ] && [ -n "$REVIEW_HERDR_PANE_NAME" ] &&
    command -v herdr >/dev/null 2>&1; then
    pane_id="$(herdr pane list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null | jq -r \
      --arg label "$REVIEW_HERDR_PANE_NAME" \
      '.result.panes[]? | select(.label == $label) | .pane_id' | head -n1)"
  fi
  if [ -n "$pane_id" ] && command -v herdr >/dev/null 2>&1; then
    herdr pane close "$pane_id" >/dev/null 2>&1 || true
  fi
  # Remove after pane termination so a racing writer cannot recreate the exit
  # marker after cleanup.
  rm -f "${REVIEW_HERDR_RAW_FILE:-}" "${REVIEW_HERDR_EXIT_FILE:-}"
  rm -f "${REVIEW_INLINE_RAW_FILE:-}"
  REVIEW_HERDR_PANE_ID=""
  REVIEW_HERDR_PANE_NAME=""
  REVIEW_HERDR_RAW_FILE=""
  REVIEW_HERDR_EXIT_FILE=""
  REVIEW_INLINE_RAW_FILE=""
}
