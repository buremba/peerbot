# herdr-task.sh — optional Herdr workspace wiring for task worktrees.
# Sourced by task-setup.sh / task-clean.sh. Set HERDR=0 to skip.
# shellcheck shell=bash

herdr_task_enabled() {
  [[ "${HERDR:-1}" != "0" ]] && command -v herdr >/dev/null 2>&1
}

# Open a git worktree in Herdr. Prints workspace_id on stdout.
#
# When task-setup runs *inside* an existing Herdr pane (the common "click new →
# start agent → run make task-setup" flow), create a new tab for the worktree.
# The calling agent keeps its full-size pane and task commands remain easy to
# follow from the tab bar instead of being added as splits to the active tab.
herdr_task_open() {
  local repo="$1" worktree_path="$2" label="$3"
  local json ws tab
  herdr_task_enabled || return 1
  if [[ -n "${HERDR_WORKSPACE_ID:-}" ]]; then
    json="$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$worktree_path" --label "$label" --no-focus 2>/dev/null)" || return 1
    tab="$(printf '%s' "$json" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("result",{}).get("tab") or {}).get("tab_id",""))' 2>/dev/null)" || return 1
    [[ -n "$tab" ]] || return 1
    printf '%s' "$HERDR_WORKSPACE_ID"
    return 0
  fi
  json="$(herdr worktree open --cwd "$repo" --path "$worktree_path" --label "$label" --no-focus --json 2>/dev/null)" || return 1
  ws="$(printf '%s' "$json" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d.get("result",{}).get("workspace",{}).get("workspace_id",""))' 2>/dev/null)" || return 1
  [[ -n "$ws" ]] || return 1
  herdr workspace rename "$ws" "$label" >/dev/null 2>&1 || true
  printf '%s' "$ws"
}

# Close the Herdr tab or workspace tied to a worktree path, if any.
#
# Tabs are matched by pane cwd. Dedicated workspaces are matched by the
# worktree's checkout_path, with a legacy label fallback for workspaces made by
# older versions of this helper.
#
# NEVER closes the current tab or workspace. `make task-clean` may be run from
# inside the task itself, and tearing down that active session can kill the
# caller before git cleanup completes.
herdr_task_close() {
  local worktree_path="$1" label="${2:-}"
  local json ws matched_by tab
  herdr_task_enabled || return 1

  # Worktrees opened from an existing Herdr session live in their own tab.
  # Match by pane cwd first and label second, and never close the caller's tab.
  if [[ -n "${HERDR_WORKSPACE_ID:-}" ]]; then
    json="$(herdr pane list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null)" || return 1
    tab="$(printf '%s' "$json" | WORKTREE_PATH="$worktree_path" CURRENT_TAB="${HERDR_TAB_ID:-}" python3 -c 'import os,sys,json
path=os.environ["WORKTREE_PATH"]
current=os.environ.get("CURRENT_TAB","")
for pane in json.load(sys.stdin).get("result",{}).get("panes",[]):
  tid=pane.get("tab_id") or ""
  if tid and tid != current and (pane.get("cwd")==path or pane.get("foreground_cwd")==path):
    print(tid); break
' 2>/dev/null)" || return 1
    if [[ -n "$tab" ]]; then
      herdr tab close "$tab" >/dev/null 2>&1 || return 1
      return 0
    fi
  fi

  json="$(herdr workspace list 2>/dev/null)" || return 1
  # Emit "<match_kind> <workspace_id>": "path" when bound to the checkout,
  # else "label" when only the label matches. Path wins over label. The current
  # workspace is skipped in BOTH branches so we never close our own session.
  read -r matched_by ws <<<"$(printf '%s' "$json" | WORKTREE_PATH="$worktree_path" LABEL="$label" CURRENT_WS="${HERDR_WORKSPACE_ID:-}" python3 -c 'import os,sys,json
path=os.environ["WORKTREE_PATH"]
label=os.environ.get("LABEL","")
current=os.environ.get("CURRENT_WS","")
d=json.load(sys.stdin)
by_label=""
for w in d.get("result",{}).get("workspaces",[]):
  wid=w.get("workspace_id") or ""
  if wid and wid==current:
    continue  # never close the pane we are running in
  wt=w.get("worktree") or {}
  if wt.get("checkout_path")==path:
    print("path", wid); break
  if label and not by_label and w.get("label")==label:
    by_label=wid
else:
  if by_label: print("label", by_label)
' 2>/dev/null)"
  [[ -n "$ws" ]] || return 1
  if [[ "$matched_by" == "path" ]]; then
    herdr worktree remove --workspace "$ws" >/dev/null 2>&1 || \
      herdr worktree remove --workspace "$ws" --force >/dev/null 2>&1 || \
      herdr workspace close "$ws" >/dev/null 2>&1 || return 1
  else
    # Label-matched (relabeled-in-place) workspace: not worktree-backed, so
    # just close it — worktree removal is handled by the git worktree teardown.
    herdr workspace close "$ws" >/dev/null 2>&1 || return 1
  fi
  return 0
}
