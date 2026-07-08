# herdr-task.sh — optional Herdr workspace wiring for task worktrees.
# Sourced by task-setup.sh / task-clean.sh. Set HERDR=0 to skip.

herdr_task_enabled() {
  [[ "${HERDR:-1}" != "0" ]] && command -v herdr >/dev/null 2>&1
}

# Open (or attach) an existing git worktree as a Herdr workspace. Prints workspace_id on stdout.
#
# When task-setup runs *inside* an existing Herdr pane (the common "click new →
# start agent → run make task-setup" flow), Herdr exports $HERDR_WORKSPACE_ID.
# In that case we relabel the *current* workspace to the task name instead of
# spawning a second one — otherwise the pane you're typing in keeps its launch
# label (e.g. "~") while an empty correctly-labeled workspace appears beside it.
herdr_task_open() {
  local repo="$1" worktree_path="$2" label="$3"
  local json ws
  herdr_task_enabled || return 1
  if [[ -n "${HERDR_WORKSPACE_ID:-}" ]]; then
    herdr workspace rename "$HERDR_WORKSPACE_ID" "$label" >/dev/null 2>&1 || true
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

# Close the Herdr workspace tied to a worktree path, if any.
#
# Prefers matching by the worktree's checkout_path (set when herdr_task_open
# spawned a dedicated worktree workspace). Falls back to matching by label ==
# task name: when task-setup ran inside an existing pane, herdr_task_open
# relabeled that workspace in place rather than binding it to a checkout, so
# Herdr has no checkout_path for it — the label is the only handle we have.
herdr_task_close() {
  local worktree_path="$1" label="${2:-}"
  local json ws matched_by
  herdr_task_enabled || return 1
  json="$(herdr workspace list 2>/dev/null)" || return 1
  # Emit "<match_kind> <workspace_id>": "path" when bound to the checkout,
  # else "label" when only the label matches. Path wins over label.
  read -r matched_by ws <<<"$(printf '%s' "$json" | WORKTREE_PATH="$worktree_path" LABEL="$label" python3 -c 'import os,sys,json
path=os.environ["WORKTREE_PATH"]
label=os.environ.get("LABEL","")
d=json.load(sys.stdin)
by_label=""
for w in d.get("result",{}).get("workspaces",[]):
  wt=w.get("worktree") or {}
  if wt.get("checkout_path")==path:
    print("path", w.get("workspace_id") or ""); break
  if label and not by_label and w.get("label")==label:
    by_label=w.get("workspace_id") or ""
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
