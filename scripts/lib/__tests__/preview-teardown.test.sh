#!/usr/bin/env bash
#
# The preview deploy job's mid-flight teardown check, executed rather than
# read. Deploy and cleanup sit in disjoint concurrency groups so teardown is
# never cancelled; the cost is that a close/unlabel landing mid-deploy no
# longer cancels the deploy, and the surviving deploy would recreate the
# namespace cleanup just removed. This step closes that window, so its decision
# is load-bearing: a wrong answer either leaks a namespace forever or deletes a
# live preview out from under an open PR.
#
# `gh` and `kubectl` are stubbed on PATH; the assertion is whether the real
# script from the workflow issues the namespace delete.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW="$SCRIPT_DIR/../../../.github/workflows/preview.yml"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

# Pull the step's shell body straight out of the workflow: a copy in this file
# would drift from the thing that actually runs.
teardown_script="$(awk '
  /^      - name: Tear down if the PR closed or lost the preview label mid-deploy$/ { found = 1 }
  found && /^        run: \|$/ { capture = 1; next }
  capture && /^          / { print; next }
  capture && NF { exit }
' "$WORKFLOW")"
[ -n "$teardown_script" ] || fail "could not extract the mid-deploy teardown script"

STUBS="$(mktemp -d)"
trap 'rm -rf "$STUBS"' EXIT

cat >"$STUBS/gh" <<'STUB'
#!/usr/bin/env bash
# One `gh api <path>` returning the whole PR; the step reads both answers out
# of this single snapshot with jq. Serving one document is the point: the step
# must not be able to observe a half-changed PR.
labels='[]'
[ "$FAKE_PR_LABELED" = "true" ] && labels='[{"name":"preview"}]'
printf '{"state":"%s","labels":%s}\n' "$FAKE_PR_STATE" "$labels"
STUB

cat >"$STUBS/kubectl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$KUBECTL_LOG"
STUB

chmod +x "$STUBS/gh" "$STUBS/kubectl"

# state labeled -> "deleted" | "kept"
teardown_verdict() {
  local log
  log="$(mktemp)"
  local outfile
  outfile="$(mktemp)"
  FAKE_PR_STATE="$1" FAKE_PR_LABELED="$2" \
  KUBECTL_LOG="$log" PATH="$STUBS:$PATH" GITHUB_OUTPUT="$outfile" \
  REPO="lobu-ai/lobu" PR_NUMBER="123" PREVIEW_NS="lobu-preview-123" \
    bash -e -c "$teardown_script" >/dev/null 2>&1 ||
    { rm -f "$log" "$outfile"; echo "error"; return; }
  # The step's `wanted` output gates the "Preview environment ready" comment,
  # so it must agree with the delete decision or we announce a preview we just
  # deleted. Fold a disagreement into a distinct verdict rather than ignoring it.
  local wanted
  wanted="$(sed -n 's/^wanted=//p' "$outfile")"
  rm -f "$outfile"
  if grep -q 'delete namespace lobu-preview-123 --ignore-not-found' "$log"; then
    rm -f "$log"
    [ "$wanted" = "false" ] && echo deleted || echo "deleted-but-announced"
  else
    rm -f "$log"
    [ "$wanted" = "true" ] && echo kept || echo "kept-but-suppressed"
  fi
}

assert_teardown() {
  local expected="$1" state="$2" labeled="$3" got
  got="$(teardown_verdict "$state" "$labeled")"
  [ "$got" = "$expected" ] ||
    fail "teardown with state=$state labeled=$labeled -> $got, wanted $expected"
}

# The normal case: the PR is still open and still wants a preview. Deleting
# here would tear down a live preview on every single deploy.
assert_teardown kept open true
# Closed mid-deploy: cleanup already ran and this deploy recreated the
# namespace behind it. This is the leak the step exists to close.
assert_teardown deleted closed true
# Label pulled mid-deploy — same window, different trigger.
assert_teardown deleted open false
assert_teardown deleted closed false
# Defensive: `.state` only ever reads `open` or `closed` (a merged PR reads
# `closed`), so this stands in for any unexpected non-open value rather than a
# real API response — the branch must fail closed and delete.
assert_teardown deleted unexpected-state true

echo "ok - preview mid-deploy teardown decides correctly"
