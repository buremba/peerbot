#!/usr/bin/env bash
set -euo pipefail

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

helm template lobu charts/lobu --namespace lobu \
  --set metrics.prometheusRule.enabled=true >"$rendered"

rule="$(awk '/^        - alert: LobuChatRunFailure$/{found=1} found{print} found && /^        - alert: / && $0 !~ /LobuChatRunFailure/{exit}' "$rendered")"
test -n "$rule"

# No failures: the strict > 0 predicate is false for increase == 0.
grep -q 'sum(increase(lobu_runs_failed_total{run_type="chat_message"}\[15m\])) > 0' <<<"$rule"
# One/sustained increase: increase is positive and the 15m `for` avoids a
# short scrape blip while retaining the repository's low-noise warning style.
grep -q '^          for: 15m$' <<<"$rule"
# Counter reset: increase(), rather than raw counter comparison, is required.
! grep -q 'lobu_runs_failed_total{run_type="chat_message"}[[:space:]]*>' <<<"$rule"
# Other run types excluded: selector is exact and has no regex/wildcard.
grep -q 'run_type="chat_message"' <<<"$rule"
! grep -q 'run_type=~' <<<"$rule"
# No high-cardinality queue grouping or duplicate per-queue alerts.
! grep -q 'by (.*queue' <<<"$rule"
test "$(grep -c '^        - alert: LobuChatRunFailure$' "$rendered")" -eq 1
# Exact labels and annotations.
grep -q '^            severity: warning$' <<<"$rule"
grep -q '^            service: lobu$' <<<"$rule"
grep -q '^            summary: "Lobu chat run failed terminally"$' <<<"$rule"
grep -q '^            description: ' <<<"$rule"

echo "chat-run-failure-alert: rendered rule checks passed"
