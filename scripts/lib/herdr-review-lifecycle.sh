# herdr-review-lifecycle.sh — ownership and cleanup for a review tab.
# Sourced by review.sh. The caller may also invoke herdr_review_abort from its
# EXIT trap so Ctrl-C and unexpected failures cannot orphan a privileged review.
# shellcheck shell=bash

HERDR_REVIEW_TAB_ID=""
HERDR_REVIEW_WORKSPACE_ID=""
HERDR_REVIEW_TAB_LABEL=""
HERDR_REVIEW_RAW_FILE=""
HERDR_REVIEW_EXIT_FILE=""
HERDR_REVIEW_RUNNER_FILE=""
HERDR_REVIEW_PROMPT_FILE=""

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

herdr_review_track_locator() {
  HERDR_REVIEW_WORKSPACE_ID="$1"
  HERDR_REVIEW_TAB_LABEL="$2"
}

herdr_review_forget_tab() {
  HERDR_REVIEW_TAB_ID=""
  HERDR_REVIEW_WORKSPACE_ID=""
  HERDR_REVIEW_TAB_LABEL=""
}

herdr_review_close_tab() {
  local tab_id="$HERDR_REVIEW_TAB_ID" tab_json
  command -v herdr >/dev/null 2>&1 || return 0
  # If interruption lands after tab creation but before its JSON was parsed,
  # recover the id from the unique per-run label.
  if [ -z "$tab_id" ] && [ -n "$HERDR_REVIEW_WORKSPACE_ID" ] && [ -n "$HERDR_REVIEW_TAB_LABEL" ]; then
    tab_json="$(herdr tab list --workspace "$HERDR_REVIEW_WORKSPACE_ID" 2>/dev/null || true)"
    tab_id="$(printf '%s' "$tab_json" | HERDR_REVIEW_TAB_LABEL="$HERDR_REVIEW_TAB_LABEL" python3 -c 'import json,os,sys
label=os.environ["HERDR_REVIEW_TAB_LABEL"]
for tab in json.load(sys.stdin).get("result", {}).get("tabs", []):
  if tab.get("label")==label:
    print(tab.get("tab_id") or ""); break
' 2>/dev/null || true)"
  fi
  if [ -z "$tab_id" ]; then
    herdr_review_forget_tab
    return 0
  fi
  # Closing the tab terminates its shell and any still-running Claude process.
  if herdr tab close "$tab_id" >/dev/null 2>&1; then
    herdr_review_forget_tab
    return 0
  fi
  echo ">> warning: failed to close Herdr review tab $tab_id" >&2
  return 1
}

herdr_review_forget_files() {
  HERDR_REVIEW_RAW_FILE=""
  HERDR_REVIEW_EXIT_FILE=""
  HERDR_REVIEW_RUNNER_FILE=""
}

herdr_review_release_prompt() {
  rm -f "$HERDR_REVIEW_PROMPT_FILE"
  HERDR_REVIEW_PROMPT_FILE=""
}

# Normal completion: the caller has already copied RAW/CLAUDE_EXIT into shell
# variables, so the tab and all transport files can be removed.
herdr_review_cleanup() {
  herdr_review_close_tab || true
  rm -f "$HERDR_REVIEW_RAW_FILE" "$HERDR_REVIEW_EXIT_FILE" "$HERDR_REVIEW_RUNNER_FILE"
  herdr_review_forget_files
}

# Abnormal completion: stop the tab/process, retain non-empty partial output for
# diagnosis, and remove only the runner/control files. This is called by the
# top-level EXIT trap on Ctrl-C, TERM, or an unexpected script error.
herdr_review_abort() {
  local raw_file="$HERDR_REVIEW_RAW_FILE"
  herdr_review_close_tab || true
  rm -f "$HERDR_REVIEW_EXIT_FILE" "$HERDR_REVIEW_RUNNER_FILE"
  if [ -n "$raw_file" ] && [ -s "$raw_file" ]; then
    echo ">> interrupted Claude output preserved at $raw_file" >&2
  else
    rm -f "$raw_file"
  fi
  herdr_review_release_prompt
  herdr_review_forget_files
}
