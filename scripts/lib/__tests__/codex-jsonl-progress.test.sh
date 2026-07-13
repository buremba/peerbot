#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
filter="$repo_root/scripts/lib/codex-jsonl-progress.py"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$filter" ] || chmod +x "$filter"

out="$(
  python3 -u "$filter" <<'JSONL'
{"type":"thread.started","thread_id":"t-1"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Looking at the diff."}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git diff origin/main","status":0}}
{"type":"token_count","info":{"total_tokens":1}}
not-json keep me
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}
JSONL
)"

printf '%s\n' "$out" | grep -Fq 'codex: thread started (t-1)' || fail "missing thread started"
printf '%s\n' "$out" | grep -Fq 'codex: turn started' || fail "missing turn started"
printf '%s\n' "$out" | grep -Fq 'assistant: Looking at the diff.' || fail "missing agent message"
printf '%s\n' "$out" | grep -Fq 'shell: git diff origin/main → 0' || fail "missing shell item"
printf '%s\n' "$out" | grep -Fq 'not-json keep me' || fail "non-json lines must pass through"
printf '%s\n' "$out" | grep -Fq 'codex: turn completed (input_tokens=10, output_tokens=2)' || fail "missing turn completed"
if printf '%s\n' "$out" | grep -Fq 'token_count'; then
  fail "token_count noise should be filtered"
fi

echo "codex-jsonl-progress tests passed"
