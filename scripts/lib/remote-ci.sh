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
      and all(.jobs[]; .status == "finished")
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
      | select(.status != "finished")
      | "job \(.job_key): \(.status)"
        + (if (.attempts[-1].view_url // "") != ""
           then " — " + .attempts[-1].view_url
           else ""
           end))
  '
}

remote_ci_attestation_matches() {
  local expected_sha="$1"
  local marker_file="$2"

  [ -f "$marker_file" ] && [ "$(cat "$marker_file")" = "$expected_sha" ]
}
