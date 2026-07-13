#!/usr/bin/env bash
# Executable coverage for the Herdr Codex review runner shape in review.sh:
# codex exec --json --output-last-message $RAW | python3 -u progress-filter
# with exit status from codex (pipefail), not the filter.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
filter="$repo_root/scripts/lib/codex-jsonl-progress.py"
tmp="$(mktemp -d /tmp/lobu-codex-herdr-runner-test.XXXXXX)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$filter" ] || chmod +x "$filter"

# Stub codex: honor --output-last-message and optional --exit-code via env.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
out_file=""
args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    exec) ;;
    --output-last-message|-o)
      i=$((i + 1))
      out_file="${args[$i]}"
      ;;
    --output-schema|--sandbox|--model|--color) i=$((i + 1)) ;;
    --json|--ephemeral) ;;
    *)
      # remaining args are the prompt; ignore
      break
      ;;
  esac
  i=$((i + 1))
done
[ -n "$out_file" ] || { echo "stub codex: missing --output-last-message" >&2; exit 2; }

printf '%s\n' \
  '{"type":"thread.started","thread_id":"stub-thread"}' \
  '{"type":"turn.started"}' \
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Stub review in progress."}}' \
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git diff --stat","status":0}}' \
  '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}'

# Final structured verdict path used by review.sh (RAW_FILE).
printf '%s\n' '{"bug_free_confidence":90,"bugs":0,"slop":0,"simplicity":90,"blockers":[],"change_type":"fix","behavior_change_risk":"low","tests_adequate":true,"suggested_fixes":[],"notes":"stub","categories":{"src":1,"tests":1,"docs":0,"config":0,"deps":0,"migrations":0,"ci":0,"generated":0}}' > "$out_file"
exit "${STUB_CODEX_EXIT:-0}"
STUB
chmod +x "$tmp/bin/codex"

run_herdr_codex_shape() {
  local raw_file="$1"
  local progress_file="$2"
  local schema_file="$tmp/schema.json"
  printf '{}\n' > "$schema_file"
  # Mirror scripts/review.sh Herdr codex branch (pipefail + progress filter).
  set +e
  set -o pipefail
  PATH="$tmp/bin:$PATH" \
    codex exec \
      --sandbox read-only \
      --output-schema "$schema_file" \
      --output-last-message "$raw_file" \
      --ephemeral \
      --json \
      --color never \
      "stub prompt" < /dev/null 2>&1 \
    | python3 -u "$filter" > "$progress_file"
  local ec=$?
  set +o pipefail
  set -e
  printf '%s\n' "$ec"
}

# --- success path: progress visible, verdict in RAW_FILE, exit 0 ---
raw_ok="$tmp/raw-ok.json"
progress_ok="$tmp/progress-ok.txt"
ec="$(STUB_CODEX_EXIT=0 run_herdr_codex_shape "$raw_ok" "$progress_ok")"
[ "$ec" = "0" ] || fail "expected exit 0, got $ec"
grep -Fq 'codex: thread started (stub-thread)' "$progress_ok" || fail "progress missing thread started"
grep -Fq 'assistant: Stub review in progress.' "$progress_ok" || fail "progress missing assistant line"
grep -Fq 'shell: git diff --stat → 0' "$progress_ok" || fail "progress missing shell line"
grep -Fq 'codex: turn completed' "$progress_ok" || fail "progress missing turn completed"
# RAW_FILE must keep the structured verdict, not the progress stream.
grep -Fq '"tests_adequate":true' "$raw_ok" || fail "RAW_FILE missing structured verdict"
if grep -Fq 'codex: thread started' "$raw_ok"; then
  fail "progress stream leaked into RAW_FILE"
fi

# --- failure path: codex non-zero must surface through pipefail ---
raw_fail="$tmp/raw-fail.json"
progress_fail="$tmp/progress-fail.txt"
ec="$(STUB_CODEX_EXIT=17 run_herdr_codex_shape "$raw_fail" "$progress_fail")"
[ "$ec" = "17" ] || fail "expected exit 17 from stub codex, got $ec"
# Last message should still have been written before exit.
grep -Fq '"bug_free_confidence":90' "$raw_fail" || fail "RAW_FILE not written on failing exit"
grep -Fq 'assistant: Stub review in progress.' "$progress_fail" || fail "progress missing on failing exit"

echo "codex-herdr-runner tests passed"
