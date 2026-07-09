# herdr-review-lifecycle.sh — exact ownership and cleanup for a review tab.
# shellcheck shell=bash

HERDR_REVIEW_TAB_ID=""
HERDR_REVIEW_WORKSPACE_ID=""
HERDR_REVIEW_TAB_LABEL=""
HERDR_REVIEW_CWD=""
HERDR_REVIEW_BEFORE_TAB_IDS=""
HERDR_REVIEW_RAW_FILE=""
HERDR_REVIEW_EXIT_FILE=""
HERDR_REVIEW_RUNNER_FILE=""
HERDR_REVIEW_PROMPT_FILE=""
HERDR_REVIEW_RUNNER_MAY_BE_LIVE=0

herdr_review_track_files() {
  HERDR_REVIEW_RAW_FILE="$1"
  HERDR_REVIEW_EXIT_FILE="$2"
  HERDR_REVIEW_RUNNER_FILE="$3"
}

herdr_review_track_prompt() {
  HERDR_REVIEW_PROMPT_FILE="$1"
}

herdr_review_track_tab() {
  HERDR_REVIEW_TAB_ID="$1"
}

herdr_review_mark_runner_may_be_live() {
  HERDR_REVIEW_RUNNER_MAY_BE_LIVE=1
}

herdr_review_runner_termination_confirmed() {
  local exit_value
  [ "$HERDR_REVIEW_RUNNER_MAY_BE_LIVE" = "1" ] || return 0
  [ -n "$HERDR_REVIEW_EXIT_FILE" ] && [ -f "$HERDR_REVIEW_EXIT_FILE" ] || return 1
  exit_value="$(sed -n '1p' "$HERDR_REVIEW_EXIT_FILE" 2>/dev/null || true)"
  case "$exit_value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  HERDR_REVIEW_RUNNER_MAY_BE_LIVE=0
}

herdr_review_track_locator() {
  HERDR_REVIEW_WORKSPACE_ID="$1"
  HERDR_REVIEW_TAB_LABEL="$2"
  HERDR_REVIEW_CWD="$3"
  HERDR_REVIEW_BEFORE_TAB_IDS="$4"
}

herdr_review_forget_tab() {
  HERDR_REVIEW_TAB_ID=""
  HERDR_REVIEW_WORKSPACE_ID=""
  HERDR_REVIEW_TAB_LABEL=""
  HERDR_REVIEW_CWD=""
  HERDR_REVIEW_BEFORE_TAB_IDS=""
}

herdr_review_parse_created_tab() {
  printf '%s' "$1" | python3 -c '
import json, sys
try:
    result = json.load(sys.stdin).get("result", {})
except (json.JSONDecodeError, AttributeError):
    raise SystemExit(1)
tab_id = (result.get("tab") or {}).get("tab_id") or ""
pane_id = (result.get("root_pane") or {}).get("pane_id") or ""
if not tab_id or not pane_id:
    raise SystemExit(1)
print(tab_id, pane_id)
'
}

herdr_review_snapshot_tabs() {
  local workspace_id="$1" tab_json
  tab_json="$(herdr tab list --workspace "$workspace_id" 2>/dev/null)" || return 1
  printf '%s' "$tab_json" | python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit(1)
if not isinstance(payload, dict):
    raise SystemExit(1)
result = payload.get("result")
if not isinstance(result, dict) or "tabs" not in result:
    raise SystemExit(1)
tabs = result["tabs"]
if not isinstance(tabs, list):
    raise SystemExit(1)
for tab in tabs:
    if not isinstance(tab, dict):
        raise SystemExit(1)
    tab_id = tab.get("tab_id")
    if not isinstance(tab_id, str) or not tab_id:
        raise SystemExit(1)
    print(tab_id)
'
}

herdr_review_recover_tab() {
  local tab_json pane_json
  tab_json="$(herdr tab list --workspace "$HERDR_REVIEW_WORKSPACE_ID" 2>/dev/null)" || return 2
  pane_json="$(herdr pane list --workspace "$HERDR_REVIEW_WORKSPACE_ID" 2>/dev/null)" || return 2
  HERDR_REVIEW_TAB_JSON="$tab_json" \
    HERDR_REVIEW_PANE_JSON="$pane_json" \
    HERDR_REVIEW_TAB_LABEL="$HERDR_REVIEW_TAB_LABEL" \
    HERDR_REVIEW_CWD="$HERDR_REVIEW_CWD" \
    HERDR_REVIEW_BEFORE_TAB_IDS="$HERDR_REVIEW_BEFORE_TAB_IDS" \
    python3 -c '
import json, os

def collection(raw, name):
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError
    result = payload.get("result")
    if not isinstance(result, dict) or name not in result:
        raise ValueError
    values = result[name]
    if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
        raise ValueError
    return values

try:
    tabs = collection(os.environ["HERDR_REVIEW_TAB_JSON"], "tabs")
    panes = collection(os.environ["HERDR_REVIEW_PANE_JSON"], "panes")
except (json.JSONDecodeError, ValueError):
    raise SystemExit(2)

for tab in tabs:
    if not isinstance(tab.get("tab_id"), str) or not tab["tab_id"]:
        raise SystemExit(2)
    if "label" in tab and tab["label"] is not None and not isinstance(tab["label"], str):
        raise SystemExit(2)
for pane in panes:
    if not isinstance(pane.get("tab_id"), str) or not pane["tab_id"]:
        raise SystemExit(2)
    for key in ("cwd", "foreground_cwd"):
        if key in pane and pane[key] is not None and not isinstance(pane[key], str):
            raise SystemExit(2)

label = os.environ["HERDR_REVIEW_TAB_LABEL"]
expected_cwd = os.path.realpath(os.environ["HERDR_REVIEW_CWD"])
before = set(filter(None, os.environ["HERDR_REVIEW_BEFORE_TAB_IDS"].splitlines()))
new_tabs = [tab for tab in tabs if tab["tab_id"] not in before]
if not new_tabs:
    raise SystemExit(1)
new_labelled = [tab["tab_id"] for tab in new_tabs if tab.get("label") == label]
if not new_labelled:
    raise SystemExit(2)

matches = []
for tab_id in new_labelled:
    for pane in panes:
        if pane.get("tab_id") != tab_id:
            continue
        cwd = pane.get("foreground_cwd") or pane.get("cwd") or ""
        if cwd and os.path.realpath(cwd) == expected_cwd:
            matches.append(tab_id)
            break

if len(matches) != 1:
    raise SystemExit(2)
print(matches[0])
'
}

herdr_review_tab_absent() {
  local tab_id="$1" get_json list_json

  # A successful get proves the tab is still live. A failed get alone is not
  # enough—transport errors look the same—so require a valid list snapshot that
  # excludes the exact owned id before declaring closure.
  if get_json="$(herdr tab get "$tab_id" 2>/dev/null)"; then
    HERDR_REVIEW_TAB_ID_TO_FIND="$tab_id" printf '%s' "$get_json" | \
      HERDR_REVIEW_TAB_ID_TO_FIND="$tab_id" python3 -c '
import json, os, sys
try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit(1)
if not isinstance(payload, dict):
    raise SystemExit(1)
result = payload.get("result")
if not isinstance(result, dict) or "tab" not in result:
    raise SystemExit(1)
tab = result["tab"]
if tab is None:
    raise SystemExit(0)
if not isinstance(tab, dict):
    raise SystemExit(1)
found = tab.get("tab_id")
if not isinstance(found, str) or not found or found != os.environ["HERDR_REVIEW_TAB_ID_TO_FIND"]:
    raise SystemExit(1)
raise SystemExit(1)
' || return 1
  fi

  list_json="$(herdr tab list --workspace "$HERDR_REVIEW_WORKSPACE_ID" 2>/dev/null)" || return 1
  HERDR_REVIEW_TAB_ID_TO_FIND="$tab_id" printf '%s' "$list_json" | \
    HERDR_REVIEW_TAB_ID_TO_FIND="$tab_id" python3 -c '
import json, os, sys
try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit(1)
if not isinstance(payload, dict):
    raise SystemExit(1)
result = payload.get("result")
if not isinstance(result, dict) or "tabs" not in result:
    raise SystemExit(1)
tabs = result["tabs"]
if not isinstance(tabs, list):
    raise SystemExit(1)
for tab in tabs:
    if not isinstance(tab, dict):
        raise SystemExit(1)
    found = tab.get("tab_id")
    if not isinstance(found, str) or not found:
        raise SystemExit(1)
target = os.environ["HERDR_REVIEW_TAB_ID_TO_FIND"]
raise SystemExit(1 if any(tab.get("tab_id") == target for tab in tabs) else 0)
'
}

herdr_review_close_tab() {
  local tab_id="$HERDR_REVIEW_TAB_ID" recovered recovery_exit attempts
  if [ -z "$tab_id" ] && { [ -z "$HERDR_REVIEW_WORKSPACE_ID" ] || [ -z "$HERDR_REVIEW_TAB_LABEL" ]; }; then
    return 0
  fi
  command -v herdr >/dev/null 2>&1 || return 1

  if [ -z "$tab_id" ]; then
    if recovered="$(herdr_review_recover_tab)"; then
      recovery_exit=0
    else
      recovery_exit=$?
    fi
    if [ "$recovery_exit" -eq 0 ] && [ -n "$recovered" ]; then
      tab_id="$recovered"
      HERDR_REVIEW_TAB_ID="$tab_id"
    elif [ "$recovery_exit" -eq 1 ]; then
      # A valid before/after snapshot proves this invocation created no tab.
      herdr_review_forget_tab
      return 0
    else
      echo ">> warning: could not uniquely recover the Herdr review tab" >&2
      return 1
    fi
  fi

  herdr tab close "$tab_id" >/dev/null 2>&1 || true
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if herdr_review_tab_absent "$tab_id"; then
      herdr_review_forget_tab
      return 0
    fi
    sleep 0.05
    attempts=$((attempts + 1))
  done
  echo ">> warning: Herdr review tab $tab_id closure was not confirmed" >&2
  return 1
}

herdr_review_forget_files() {
  HERDR_REVIEW_RAW_FILE=""
  HERDR_REVIEW_EXIT_FILE=""
  HERDR_REVIEW_RUNNER_FILE=""
  HERDR_REVIEW_RUNNER_MAY_BE_LIVE=0
}

herdr_review_release_prompt() {
  rm -f "$HERDR_REVIEW_PROMPT_FILE"
  HERDR_REVIEW_PROMPT_FILE=""
}

herdr_review_cleanup() {
  if ! herdr_review_close_tab; then
    echo ">> Herdr review diagnostics retained because tab closure is unconfirmed" >&2
    return 1
  fi
  rm -f "$HERDR_REVIEW_RAW_FILE" "$HERDR_REVIEW_EXIT_FILE" "$HERDR_REVIEW_RUNNER_FILE"
  herdr_review_forget_files
}

herdr_review_abort() {
  local raw_file="$HERDR_REVIEW_RAW_FILE"
  if ! herdr_review_close_tab; then
    echo ">> Herdr review state retained because tab closure is unconfirmed" >&2
    return 1
  fi
  rm -f "$HERDR_REVIEW_EXIT_FILE" "$HERDR_REVIEW_RUNNER_FILE"
  if [ -n "$raw_file" ] && [ -s "$raw_file" ]; then
    echo ">> interrupted Claude output preserved at $raw_file" >&2
  else
    rm -f "$raw_file"
  fi
  herdr_review_release_prompt
  herdr_review_forget_files
}

# The Herdr runner is external to this shell and cannot inherit the host flock.
# If exact tab closure is ambiguous, keep this process (and therefore FD 9)
# alive until either a retry confirms the tab is absent or the runner writes its
# terminal exit marker. Only then can another destructive review safely start.
herdr_review_abort_until_safe_to_release_lock() {
  local announced=0 retry_seconds="${REVIEW_CLOSE_RETRY_SECONDS_FOR_TESTS:-0.25}"
  while true; do
    if herdr_review_abort; then
      return 0
    fi
    if herdr_review_runner_termination_confirmed; then
      echo ">> Herdr review runner terminated; retained tab diagnostics for manual cleanup" >&2
      return 0
    fi
    if [ "$announced" = "0" ]; then
      echo ">> retaining full review lock until the Herdr runner is confirmed stopped" >&2
      announced=1
    fi
    sleep "$retry_seconds"
  done
}
