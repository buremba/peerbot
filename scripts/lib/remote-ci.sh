#!/usr/bin/env bash

# Pure helpers shared by the Depot runner and the review gate. Keep these free
# of process exits so the fail-closed status rules stay fixture-testable.

remote_ci_extract_run_id() {
  sed -n 's/^Run: \([[:alnum:]]*\)$/\1/p' | head -n 1
}

remote_ci_status_succeeded() {
  jq -e '
    .status == "finished"
    and (.workflows | length > 0)
    and all(.workflows[];
      .status == "finished"
      and (.jobs | length > 0)
      # Conditional GitHub jobs are terminal successes when their `if` is
      # false. Depot reports them as skipped rather than finished.
      and all(.jobs[]; .status == "finished" or .status == "skipped")
    )
  ' >/dev/null
}

remote_ci_status_terminal() {
  jq -e '.status == "finished" or .status == "failed" or .status == "cancelled"' >/dev/null
}

remote_ci_status_summary() {
  jq -r '
    [.workflows[].jobs[].status]
    | group_by(.)
    | map("\(.[0])=\(length)")
    | join(" ")
  '
}

remote_ci_print_failures() {
  jq -r '
    "Depot run status: \(.status)",
    (.workflows[]
      | select(.status != "finished")
      | "workflow \(.name): \(.status)"),
    (.workflows[].jobs[]
      | select(.status != "finished" and .status != "skipped")
      | "job \(.job_key): \(.status)"
        + (if (.attempts[-1].view_url // "") != ""
           then " — " + .attempts[-1].view_url
           else ""
           end))
  '
}

remote_ci_require_no_untracked() {
  local untracked
  untracked="$(git ls-files --others --exclude-standard)"
  if [ -n "$untracked" ]; then
    echo "Remote CI cannot include untracked files." >&2
    echo "Stage each intended new file explicitly before rerunning:" >&2
    printf '%s\n' "$untracked" | sed 's/^/  git add -- /' >&2
    return 1
  fi
}

# Return the exact Git tree the full remote gate will attest. Requiring a
# settled index makes the attestation survive the subsequent commit: the
# commit's tree id equals this tree id even though the commit SHA is new.
remote_ci_staged_tree() {
  remote_ci_require_no_untracked || return 1
  if ! git diff --quiet --ignore-submodules=none --; then
    echo "Full remote CI requires all intended changes to be staged." >&2
    echo "Run git add -- <explicit-paths>, then rerun make pre-pr-remote." >&2
    return 1
  fi
  git write-tree
}
