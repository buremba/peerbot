#!/usr/bin/env bash
#
# Error-taxonomy end-to-end gate.
#
# The companion to sdk-e2e.sh (happy path). Instead of asserting a successful
# turn, it drives a real provider FAILURE end to end and asserts the unified
# AGENT_ERRORS catalog prose reaches the user — proving the whole
# worker→classifyAgentError→signalError(code,context)→gateway renderer chain,
# not just that a unit test classifies a string.
#
# The mock provider answers /chat/completions with z.ai's exact production 429
# body ("429 Weekly/Monthly Limit Exhausted. Your limit will reset at …"). A
# real agent turn is spawned through the worker; the failure must render as:
#     "Your mock provider's usage limit is used up. It resets 2026-07-10 …."
# and must NOT surface either the raw "429 Weekly/Monthly Limit Exhausted"
# (leaked provider text) or the generic "stopped responding" (sweep race
# terminalization) — the two divergent masks the taxonomy was built to kill.
#
# Runs against embedded Postgres + the deterministic mock, so it needs no
# provider key and is reproducible in CI. Self-contained, same boot flow as
# sdk-e2e.sh.
#
# Usage: scripts/sdk-e2e-error.sh
#        DATABASE_URL=... scripts/sdk-e2e-error.sh   (use an external Postgres)
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$WT/scripts/sdk-e2e"
LOBU="node $WT/packages/cli/bin/lobu.js"
GW_PORT="${GW_PORT:-8795}"
MOCK_PORT="${MOCK_PORT:-11436}"
RUN_DIR="$WT/.sdk-e2e-error-run"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
CHAT_OUT="$RUN_DIR/chat.out"

if [ -x /opt/homebrew/opt/node@22/bin/node ] && ! node --version 2>/dev/null | grep -qE '^v(22|23|24)\.'; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "❌ error-taxonomy e2e FAILED: $*" >&2; [ -f "$RUN_LOG" ] && { echo "--- last 40 lines of run.log ---" >&2; tail -40 "$RUN_LOG" >&2; }; exit 1; }

echo "▶ node $(node --version), gateway :$GW_PORT, mock :$MOCK_PORT (429 mode)"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR"
cleanup  # free ports from any prior run

if [ -z "${DATABASE_URL:-}" ]; then
  node "$HARNESS/fix-embedded-pg-icu.mjs" || fail "could not prepare embedded-postgres ICU symlinks"
fi

# 1) Mock provider in 429 mode — /models still 200s, /chat/completions 429s.
MOCK_PORT="$MOCK_PORT" MOCK_MODE="quota-429" node "$HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 || fail "mock server did not come up"
# Sanity: confirm the mock really 429s on chat before we spend a whole boot.
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}')"
[ "$code" = "429" ] || fail "mock did not return 429 on chat (got $code)"
echo "✓ mock provider up in 429 mode"

# 2) Scaffold a project routed through the mock (mirrors sdk-e2e.sh).
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
( cd "$PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -rf "$PROJ/package.json" "$PROJ/node_modules" "$PROJ/bun.lock"
cat > "$PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, secret } from "@lobu/cli/config";

const agent = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});

export default defineConfig({ agents: [agent] });
TS
mkdir -p "$PROJ/agents/echo"
[ -f "$PROJ/agents/echo/instructions.md" ] || echo "You are Echo." > "$PROJ/agents/echo/instructions.md"

{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  [ -n "${DATABASE_URL:-}" ] && echo "DATABASE_URL=$DATABASE_URL"
} >> "$PROJ/.env"

# Point the mock provider's upstream at THIS run's mock port (the shipped
# providers.json hardcodes 11434; we run on a distinct port so a concurrent
# happy-path gate can't collide).
REG="$RUN_DIR/providers.json"
sed "s#http://127.0.0.1:11434/v1#http://127.0.0.1:$MOCK_PORT/v1#" "$HARNESS/providers.json" > "$REG"
export LOBU_PROVIDER_REGISTRY_PATH="$REG"

# 3) Boot lobu run (auto-applies the project).
( cd "$PROJ" && $LOBU run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
for _ in $(seq 1 80); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done
grep -qi "Apply complete" "$RUN_LOG" || fail "auto-apply did not complete (skipped/halted?)"
echo "✓ lobu run auto-applied the project"

# 4) Drive a real turn — the mock 429s, so the turn FAILS. `lobu chat` may exit
# non-zero when the turn errors; that's expected here. What matters is the
# RENDERED text.
( cd "$PROJ" && timeout 90 $LOBU chat "say the safe word" -c local > "$CHAT_OUT" 2>&1 ) || true

echo "--- chat output ---"; cat "$CHAT_OUT"; echo "-------------------"

# 4a) The rendered catalog prose must reach the user.
grep -qiF "usage limit is used up" "$CHAT_OUT" \
  || fail "rendered PROVIDER_QUOTA_EXHAUSTED prose missing (got: $(tr -d '\n' < "$CHAT_OUT" | tail -c 300))"
# 4b) The reset time parsed out of the raw provider body must be threaded through.
grep -qF "2026-07-10 04:32:47" "$CHAT_OUT" \
  || fail "reset time not threaded into the rendered message"
# 4c) The provider label must be SPECIFIC (threaded from the worker's resolved
# provider), not the generic "Your AI provider" fallback. The resolved provider
# is the wire protocol the route composed to — here the mock registers with
# sdkCompat "openai", so a real openai-compatible route (z.ai included) surfaces
# as "openai provider". What we're guarding is that a concrete provider name
# reached the render context at all, i.e. the fallback did NOT fire.
grep -qiE "Your [a-z0-9_-]+ provider's usage limit" "$CHAT_OUT" \
  || fail "provider label not rendered from context"
if grep -qiF "Your AI provider's usage limit" "$CHAT_OUT"; then
  fail "generic provider fallback fired — resolved provider was not threaded into the render context"
fi

# 4d) NEGATIVE assertions — the two masks the taxonomy killed must NOT appear.
if grep -qiF "Weekly/Monthly Limit Exhausted" "$CHAT_OUT"; then
  fail "raw provider 429 body leaked to the user (should be catalog prose)"
fi
if grep -qiE "stopped responding|worker.*(unresponsive|not responding)" "$CHAT_OUT"; then
  fail "generic sweep 'stopped responding' surfaced instead of the real quota error"
fi

echo "✓ provider 429 rendered as unified catalog prose (code + reset + provider), no raw/generic leak"
echo "🎉 error-taxonomy e2e passed"
