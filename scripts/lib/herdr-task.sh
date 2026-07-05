# herdr-task.sh — optional Herdr workspace wiring for task worktrees.
# Sourced by task-setup.sh / task-clean.sh. Set HERDR=0 to skip.

herdr_task_enabled() {
  [[ "${HERDR:-1}" != "0" ]] && command -v herdr >/dev/null 2>&1
}

# Open (or attach) an existing git worktree as a Herdr workspace. Prints workspace_id on stdout.
herdr_task_open() {
  local repo="$1" worktree_path="$2" label="$3"
  local json ws
  herdr_task_enabled || return 1
  json="$(herdr worktree open --cwd "$repo" --path "$worktree_path" --label "$label" --no-focus --json 2>/dev/null)" || return 1
  ws="$(printf '%s' "$json" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d.get("result",{}).get("workspace",{}).get("workspace_id",""))' 2>/dev/null)" || return 1
  [[ -n "$ws" ]] || return 1
  herdr workspace rename "$ws" "$label" >/dev/null 2>&1 || true
  printf '%s' "$ws"
}

# Close the Herdr workspace tied to a worktree path, if any.
herdr_task_close() {
  local worktree_path="$1"
  local json ws
  herdr_task_enabled || return 1
  json="$(herdr workspace list --json 2>/dev/null)" || return 1
  ws="$(printf '%s' "$json" | WORKTREE_PATH="$worktree_path" python3 -c 'import os,sys,json
path=os.environ["WORKTREE_PATH"]
d=json.load(sys.stdin)
for w in d.get("result",{}).get("workspaces",[]):
  wt=w.get("worktree") or {}
  if wt.get("checkout_path")==path:
    print(w.get("workspace_id") or "")
    break
' 2>/dev/null)" || return 1
  [[ -n "$ws" ]] || return 1
  herdr worktree remove --workspace "$ws" >/dev/null 2>&1 || \
    herdr worktree remove --workspace "$ws" --force >/dev/null 2>&1 || \
    herdr workspace close "$ws" >/dev/null 2>&1 || return 1
  return 0
}