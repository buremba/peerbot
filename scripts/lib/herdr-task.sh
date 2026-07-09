# herdr-task.sh — optional Herdr workspace wiring for task worktrees.
# Sourced by task-setup.sh / task-clean.sh. Set HERDR=0 to skip.
# shellcheck shell=bash

herdr_task_enabled() {
  [[ "${HERDR:-1}" != "0" ]] && command -v herdr >/dev/null 2>&1
}

# Store the Herdr identity in Git's per-worktree metadata directory. Unlike a
# marker inside the checkout, this does not dirty the worktree; unlike a lookup
# scoped to the caller's current Herdr workspace, it remains authoritative when
# task-clean is launched from another workspace or an ordinary terminal.
herdr_task_metadata_path() {
  git -C "$1" rev-parse --path-format=absolute --git-path lobu-herdr-task 2>/dev/null
}

herdr_task_metadata_write() {
  local worktree_path="$1" workspace_id="$2" tab_id="${3:-}" metadata_path
  metadata_path="$(herdr_task_metadata_path "$worktree_path")" || return 1
  printf 'workspace_id=%s\ntab_id=%s\n' "$workspace_id" "$tab_id" > "$metadata_path"
}

herdr_task_metadata_read() {
  local worktree_path="$1" metadata_path key value workspace_id="" tab_id=""
  metadata_path="$(herdr_task_metadata_path "$worktree_path")" || return 1
  [[ -f "$metadata_path" ]] || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      workspace_id) workspace_id="$value" ;;
      tab_id) tab_id="$value" ;;
    esac
  done < "$metadata_path"
  [[ -n "$workspace_id" ]] || return 1
  printf '%s %s\n' "$workspace_id" "$tab_id"
}

# A create request can reach the Herdr server even if its CLI response is
# truncated or otherwise cannot be parsed. Compare the tab list from before and
# after the request so a newly-created task tab can still be closed.
herdr_task_recover_new_tab() {
  local workspace_id="$1" worktree_path="$2" label="$3" before_json="$4"
  local after_json pane_json tab_id
  after_json="$(herdr tab list --workspace "$workspace_id" 2>/dev/null || true)"
  pane_json="$(herdr pane list --workspace "$workspace_id" 2>/dev/null || true)"
  tab_id="$(BEFORE_JSON="$before_json" AFTER_JSON="$after_json" PANE_JSON="$pane_json" WORKTREE_PATH="$worktree_path" LABEL="$label" python3 -c 'import json,os

def load(name):
  try:
    return json.loads(os.environ.get(name, ""))
  except Exception:
    return {}

before={tab.get("tab_id") for tab in load("BEFORE_JSON").get("result",{}).get("tabs",[]) if tab.get("tab_id")}
tabs=load("AFTER_JSON").get("result",{}).get("tabs",[])
path=os.environ["WORKTREE_PATH"]
prefix=path.rstrip("/")+"/"
matching_panes={pane.get("tab_id") for pane in load("PANE_JSON").get("result",{}).get("panes",[]) if pane.get("tab_id") and any(cwd==path or cwd.startswith(prefix) for cwd in (pane.get("cwd") or "", pane.get("foreground_cwd") or ""))}
new_tabs=[tab for tab in tabs if tab.get("tab_id") and tab.get("tab_id") not in before]
for tab in new_tabs:
  if tab.get("tab_id") in matching_panes:
    print(tab["tab_id"]); raise SystemExit
for tab in new_tabs:
  if tab.get("label")==os.environ.get("LABEL", ""):
    print(tab["tab_id"]); raise SystemExit
' 2>/dev/null || true)"
  [[ -n "$tab_id" ]] || return 1
  herdr tab close "$tab_id" >/dev/null 2>&1
}

# Same recovery for `herdr worktree open`: only a workspace absent from the
# pre-create snapshot is eligible, so a malformed response for an already-open
# worktree can never close an existing user workspace.
herdr_task_recover_new_workspace() {
  local worktree_path="$1" label="$2" before_json="$3"
  local after_json workspace_id
  after_json="$(herdr workspace list 2>/dev/null || true)"
  workspace_id="$(BEFORE_JSON="$before_json" AFTER_JSON="$after_json" WORKTREE_PATH="$worktree_path" LABEL="$label" python3 -c 'import json,os

def load(name):
  try:
    return json.loads(os.environ.get(name, ""))
  except Exception:
    return {}

before={workspace.get("workspace_id") for workspace in load("BEFORE_JSON").get("result",{}).get("workspaces",[]) if workspace.get("workspace_id")}
workspaces=[workspace for workspace in load("AFTER_JSON").get("result",{}).get("workspaces",[]) if workspace.get("workspace_id") and workspace.get("workspace_id") not in before]
for workspace in workspaces:
  if (workspace.get("worktree") or {}).get("checkout_path")==os.environ["WORKTREE_PATH"]:
    print(workspace["workspace_id"]); raise SystemExit
for workspace in workspaces:
  if workspace.get("label")==os.environ.get("LABEL", ""):
    print(workspace["workspace_id"]); raise SystemExit
' 2>/dev/null || true)"
  [[ -n "$workspace_id" ]] || return 1
  herdr worktree remove --workspace "$workspace_id" --force >/dev/null 2>&1 || \
    herdr workspace close "$workspace_id" >/dev/null 2>&1
}

herdr_task_snapshot_valid() {
  local json="$1" collection="$2"
  printf '%s' "$json" | COLLECTION="$collection" python3 -c 'import json,os,sys
d=json.load(sys.stdin)
value=d.get("result",{}).get(os.environ["COLLECTION"])
raise SystemExit(0 if isinstance(value,list) else 1)
' >/dev/null 2>&1
}

# Open a git worktree in Herdr. Prints workspace_id on stdout.
#
# When task-setup runs *inside* an existing Herdr pane (the common "click new →
# start agent → run make task-setup" flow), create a new tab for the worktree.
# The calling agent keeps its full-size pane and task commands remain easy to
# follow from the tab bar instead of being added as splits to the active tab.
herdr_task_open() {
  local repo="$1" worktree_path="$2" label="$3"
  local json ws tab metadata_ws metadata_tab before_json
  herdr_task_enabled || return 1

  # Refreshing an existing task must not create another tab and overwrite the
  # only identity task-clean knows about. Reuse the persisted live owner even
  # when setup is launched from another workspace or an ordinary terminal.
  if read -r metadata_ws metadata_tab <<<"$(herdr_task_metadata_read "$worktree_path" 2>/dev/null || true)" && [[ -n "$metadata_ws" ]]; then
    if [[ -n "$metadata_tab" ]] && herdr tab get "$metadata_tab" >/dev/null 2>&1; then
      printf '%s' "$metadata_ws"
      return 0
    fi
    if [[ -z "$metadata_tab" ]] && herdr workspace get "$metadata_ws" >/dev/null 2>&1; then
      printf '%s' "$metadata_ws"
      return 0
    fi
  fi

  if [[ -n "${HERDR_WORKSPACE_ID:-}" ]]; then
    before_json="$(herdr tab list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null)" || return 1
    herdr_task_snapshot_valid "$before_json" tabs || return 1
    if ! json="$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$worktree_path" --label "$label" --no-focus 2>/dev/null)"; then
      herdr_task_recover_new_tab "$HERDR_WORKSPACE_ID" "$worktree_path" "$label" "$before_json" || true
      return 1
    fi
    if ! tab="$(printf '%s' "$json" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print((d.get("result",{}).get("tab") or {}).get("tab_id",""))' 2>/dev/null)" || [[ -z "$tab" ]]; then
      herdr_task_recover_new_tab "$HERDR_WORKSPACE_ID" "$worktree_path" "$label" "$before_json" || true
      return 1
    fi
    if ! herdr_task_metadata_write "$worktree_path" "$HERDR_WORKSPACE_ID" "$tab"; then
      herdr tab close "$tab" >/dev/null 2>&1 || true
      return 1
    fi
    printf '%s' "$HERDR_WORKSPACE_ID"
    return 0
  fi
  before_json="$(herdr workspace list 2>/dev/null)" || return 1
  herdr_task_snapshot_valid "$before_json" workspaces || return 1
  if ! json="$(herdr worktree open --cwd "$repo" --path "$worktree_path" --label "$label" --no-focus --json 2>/dev/null)"; then
    herdr_task_recover_new_workspace "$worktree_path" "$label" "$before_json" || true
    return 1
  fi
  if ! ws="$(printf '%s' "$json" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d.get("result",{}).get("workspace",{}).get("workspace_id",""))' 2>/dev/null)" || [[ -z "$ws" ]]; then
    herdr_task_recover_new_workspace "$worktree_path" "$label" "$before_json" || true
    return 1
  fi
  herdr workspace rename "$ws" "$label" >/dev/null 2>&1 || true
  if ! herdr_task_metadata_write "$worktree_path" "$ws"; then
    herdr worktree remove --workspace "$ws" --force >/dev/null 2>&1 || \
      herdr workspace close "$ws" >/dev/null 2>&1 || true
    return 1
  fi
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
  local json ws matched_by tab candidate_ws metadata_ws metadata_tab
  herdr_task_enabled || return 1

  # Prefer the exact identity recorded at creation. This works even when the
  # caller is outside Herdr or in a different workspace.
  if read -r metadata_ws metadata_tab <<<"$(herdr_task_metadata_read "$worktree_path" 2>/dev/null || true)" && [[ -n "$metadata_ws" ]]; then
    if [[ -n "$metadata_tab" && "$metadata_tab" != "${HERDR_TAB_ID:-}" ]]; then
      if herdr tab close "$metadata_tab" >/dev/null 2>&1; then
        return 0
      fi
    elif [[ -z "$metadata_tab" && "$metadata_ws" != "${HERDR_WORKSPACE_ID:-}" ]]; then
      if herdr worktree remove --workspace "$metadata_ws" >/dev/null 2>&1 || \
         herdr worktree remove --workspace "$metadata_ws" --force >/dev/null 2>&1 || \
         herdr workspace close "$metadata_ws" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  # Metadata may be absent for legacy task tabs. Enumerate every workspace,
  # rather than only the caller's, and match panes by checkout cwd. Never close
  # the tab that is executing task-clean.
  json="$(herdr workspace list 2>/dev/null)" || return 1
  while IFS= read -r candidate_ws; do
    [[ -n "$candidate_ws" ]] || continue
    local pane_json
    pane_json="$(herdr pane list --workspace "$candidate_ws" 2>/dev/null)" || continue
    tab="$(printf '%s' "$pane_json" | WORKTREE_PATH="$worktree_path" CURRENT_TAB="${HERDR_TAB_ID:-}" python3 -c 'import os,sys,json
path=os.environ["WORKTREE_PATH"]
current=os.environ.get("CURRENT_TAB","")
prefix=path.rstrip("/")+"/"
for pane in json.load(sys.stdin).get("result",{}).get("panes",[]):
  tid=pane.get("tab_id") or ""
  cwd=pane.get("cwd") or ""
  foreground=pane.get("foreground_cwd") or ""
  if tid and tid != current and (cwd==path or cwd.startswith(prefix) or foreground==path or foreground.startswith(prefix)):
    print(tid); break
' 2>/dev/null)" || return 1
    if [[ -n "$tab" ]]; then
      herdr tab close "$tab" >/dev/null 2>&1 || return 1
      return 0
    fi
  done < <(printf '%s' "$json" | python3 -c 'import sys,json
for workspace in json.load(sys.stdin).get("result",{}).get("workspaces",[]):
  workspace_id=workspace.get("workspace_id") or ""
  if workspace_id: print(workspace_id)
' 2>/dev/null)

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
