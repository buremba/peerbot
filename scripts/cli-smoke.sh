#!/usr/bin/env bash
#
# CLI command-coverage smoke gate.
#
# Where scripts/sdk-e2e.sh proves the SDK *lifecycle* (apply -> prune -> worker
# turn -> connector -> watcher -> client), THIS gate proves that EVERY `lobu`
# command/subcommand actually RUNS -- argv parses, the handler executes, and a
# representative invocation returns the documented success marker (or, for the
# negative cases, fails gracefully with the documented message instead of a
# crash/stack trace).
#
# It boots ONE local `lobu run` (embedded Postgres + a deterministic mock
# OpenAI-compatible provider, reusing the scripts/sdk-e2e/ harness -- no provider
# key, reproducible in CI) under an ISOLATED $HOME, then walks the whole command
# surface. Unlike sdk-e2e it does NOT fail-fast: it records every miss and exits
# non-zero at the end with a summary, so one run tells you exactly which commands
# are broken.
#
# Commands that genuinely need a browser, a real TTY, an external Postgres, or a
# configured chat platform can't be driven unattended -- those are exercised at
# the "runs + fails gracefully" level or logged as SKIP with the reason.
#
# Kept ASCII-only on purpose: a stray non-ASCII byte hugging a $var expansion is
# swallowed into the variable name under a UTF-8 locale ("unbound variable").
#
# Usage: scripts/cli-smoke.sh         (embedded Postgres, the default)
#        DATABASE_URL=... scripts/cli-smoke.sh   (external Postgres; also exercises `token revoke`)
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$WT/scripts/sdk-e2e"          # reuse the deterministic provider + ICU fix
LOBU_BIN="$WT/packages/cli/bin/lobu.js"
GW_PORT="${GW_PORT:-8795}"
MOCK_PORT="${MOCK_PORT:-11436}"
MOCK_REPLY="CLI_SMOKE_OK"
RUN_DIR="$WT/.cli-smoke-run"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
OUT="$RUN_DIR/cmd.out"                 # scratch for the most-recent command

# Node 22-24 is required (the worker uses isolated-vm). Prefer a Homebrew
# node@22 locally; CI provides node via actions/setup-node.
if [ -x /opt/homebrew/opt/node@22/bin/node ] && ! node --version 2>/dev/null | grep -qE '^v(22|23|24)\.'; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

# Isolate ALL global CLI state under a throwaway HOME. The CLI reads/writes
# ~/.config/lobu/{config,credentials,threads}.json, ~/.openclaw/openclaw.json,
# and the embedded Postgres data dir defaults to ~/.lobu/pgdata. Overriding HOME
# contains every one of those in $RUN_DIR so the gate never clobbers the dev's
# real contexts/login (and gives a fresh DB each run).
export HOME="$RUN_DIR/home"

MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}
trap cleanup EXIT

# ---- Reporting --------------------------------------------------------------
PASSES=0; FAILS=0; SKIPS=0
pass() { echo "  [OK]   $*"; PASSES=$((PASSES + 1)); }
skip() { echo "  [SKIP] $*"; SKIPS=$((SKIPS + 1)); }
note() { echo ""; echo "== $* =="; }
softfail() {
  echo "  [FAIL] $*" >&2
  echo "         -- last 12 lines of output --" >&2
  tail -12 "$OUT" 2>/dev/null | sed 's/^/         /' >&2
  FAILS=$((FAILS + 1))
}
# Hard failure for setup prerequisites -- no point walking commands if the
# server never came up.
die() { echo "ABORT: CLI smoke -- $*" >&2; [ -f "$RUN_LOG" ] && { echo "--- last 40 lines of run.log ---" >&2; tail -40 "$RUN_LOG" >&2; }; exit 1; }

# Run `lobu <args>` in <cwd>, capture combined output to $OUT, set RC to the
# CLI's exit code. errexit is disabled; callers inspect RC explicitly.
RC=0
runlobu() {
  local cwd="$1"; shift
  ( cd "$cwd" && node "$LOBU_BIN" "$@" ) > "$OUT" 2>&1 </dev/null
  RC=$?
}

# expect_grep <desc> <marker> <cwd> <args...>  -> exit 0 AND <marker> present
expect_grep() {
  local desc="$1" marker="$2" cwd="$3"; shift 3
  runlobu "$cwd" "$@"
  if [ "$RC" -eq 0 ] && grep -qF -- "$marker" "$OUT"; then pass "$desc"
  else softfail "$desc (exit=$RC, missing marker: $marker) [lobu $*]"; fi
}

# expect_ok <desc> <cwd> <args...>  -> exit 0 (no marker)
expect_ok() {
  local desc="$1" cwd="$2"; shift 2
  runlobu "$cwd" "$@"
  if [ "$RC" -eq 0 ]; then pass "$desc"
  else softfail "$desc (exit=$RC) [lobu $*]"; fi
}

# expect_fail_grep <desc> <marker> <cwd> <args...>  -> graceful failure:
# non-zero exit AND the documented error message present (no crash/stack trace).
expect_fail_grep() {
  local desc="$1" marker="$2" cwd="$3"; shift 3
  runlobu "$cwd" "$@"
  if [ "$RC" -ne 0 ] && grep -qiF -- "$marker" "$OUT"; then pass "$desc (graceful: $marker)"
  else softfail "$desc (expected non-zero exit + '$marker', got exit=$RC) [lobu $*]"; fi
}

# expect_exit <desc> <code> <cwd> <args...>  -> exact exit code
expect_exit() {
  local desc="$1" code="$2" cwd="$3"; shift 3
  runlobu "$cwd" "$@"
  if [ "$RC" -eq "$code" ]; then pass "$desc (exit $code)"
  else softfail "$desc (expected exit $code, got $RC) [lobu $*]"; fi
}

echo ">> node $(node --version), gateway :$GW_PORT, mock :$MOCK_PORT, HOME=$HOME"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR" "$HOME"
cleanup  # free ports from any prior run

# 0) Embedded-PG ICU shims on Linux (no-op on macOS). See sdk-e2e.sh step 0.
if [ -z "${DATABASE_URL:-}" ]; then
  node "$HARNESS/fix-embedded-pg-icu.mjs" || die "could not prepare embedded-postgres ICU symlinks"
fi

# 1) Deterministic mock OpenAI-compatible provider.
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" node "$HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || die "mock server did not come up"

# The mock provider lives on $MOCK_PORT, but the shared harness providers.json
# hardcodes 11434. Rewrite a copy so the registry points at our port.
PROVIDERS="$RUN_DIR/providers.json"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const port=process.argv[2];for(const grp of j.providers||[])for(const sub of grp.providers||[])if(sub.upstreamBaseUrl)sub.upstreamBaseUrl=sub.upstreamBaseUrl.replace(/:\d+/,":"+port);fs.writeFileSync(process.argv[3],JSON.stringify(j,null,2))' "$HARNESS/providers.json" "$MOCK_PORT" "$PROVIDERS"
export LOBU_PROVIDER_REGISTRY_PATH="$PROVIDERS"

# ============================================================================
# STATIC COMMANDS (no server needed)
# ============================================================================
note "top-level"
VERSION="$(node "$LOBU_BIN" --version 2>/dev/null | tr -d '[:space:]')"
expect_grep "lobu --version" "$VERSION" "$WT" --version
expect_grep "lobu --help" "CLI for deploying and managing AI agents on Lobu" "$WT" --help
expect_exit "lobu <unknown-command> -> usage error" 1 "$WT" definitely-not-a-command

note "init / validate / doctor / telemetry / agent scaffold (static)"
expect_grep "lobu init --list-providers" "--provider" "$WT" init --list-providers

# Scaffold the project we'll boot. Mirror sdk-e2e: scaffold, drop package.json
# so jiti resolves the workspace @lobu/cli/config, then overwrite the config to
# point the agent at the deterministic mock provider.
#
# node_modules/bun.lock must go for the same reason as package.json: `lobu
# init` runs `bun install`, which plants the *published* @lobu/connector-sdk
# in $PROJ/node_modules. Compiled connector bundles are staged under cwd
# ($PROJ here), so their externalized bare `@lobu/connector-sdk` import would
# resolve that stale npm copy instead of the workspace dist under test --
# making the runtime-self-check fail for any in-repo connector that uses an
# SDK export newer than the last npm release (#1222).
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
expect_grep "lobu init . --here" "Lobu initialized" "$PROJ" init . -y --here --provider gemini
rm -rf "$PROJ/package.json" "$PROJ/node_modules" "$PROJ/bun.lock"
cat > "$PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, defineEntityType, secret } from "@lobu/cli/config";

const echo = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
const note = defineEntityType({ key: "note", name: "Note" });

export default defineConfig({ agents: [echo], entities: [note] });
TS

expect_grep "lobu validate" "is valid" "$PROJ" validate

# Negative: a syntactically broken config must be rejected (non-zero), not crash.
BADPROJ="$RUN_DIR/badproj"; mkdir -p "$BADPROJ"
printf 'import { defineConfig } from "@lobu/cli/config";\nexport default defineConfig({ agents: [ }\n' > "$BADPROJ/lobu.config.ts"
expect_exit "lobu validate (broken config -> non-zero)" 1 "$BADPROJ" validate

# doctor's DB line is backend-specific: embedded mode prints "embedded
# Postgres"; an external DATABASE_URL connects for real and prints no such
# marker. Gate the embedded assertion on the mode (mirrors sdk-e2e.sh); always
# assert there's no spurious connect failure.
runlobu "$PROJ" doctor
if grep -qiE "connect failed|ENOTFOUND" "$OUT"; then
  softfail "lobu doctor false-failed the DB check (lobu doctor)"
elif [ -z "${DATABASE_URL:-}" ] && ! grep -qF "embedded Postgres" "$OUT"; then
  softfail "lobu doctor did not recognize the embedded Postgres backend"
else
  pass "lobu doctor (DB check healthy)"
fi

expect_grep "lobu telemetry status" "Telemetry:" "$PROJ" telemetry status
expect_grep "lobu telemetry on" "Telemetry enabled" "$PROJ" telemetry on
expect_grep "lobu telemetry status (now on)" "Telemetry: on" "$PROJ" telemetry status
expect_grep "lobu telemetry off" "Telemetry disabled" "$PROJ" telemetry off

expect_grep "lobu agent scaffold (local)" "Scaffolded agent" "$PROJ" agent scaffold helper --name Helper
expect_fail_grep "lobu agent scaffold (dup -> graceful)" "already exists" "$PROJ" agent scaffold helper

note "context (local config CRUD)"
expect_grep "lobu context list" "contexts" "$PROJ" context list
expect_grep "lobu context current" "context" "$PROJ" context current
expect_grep "lobu context add" "Saved context" "$PROJ" context add smoke-ctx --url "http://localhost:$GW_PORT"
expect_grep "lobu context use" "Switched to context smoke-ctx" "$PROJ" context use smoke-ctx
expect_grep "lobu context rm" "Removed context smoke-ctx" "$PROJ" context rm smoke-ctx

note "connector runtime-self-check (CI smoke gate, no server)"
expect_ok "lobu connector runtime-self-check --json" "$PROJ" connector runtime-self-check --json

note "apply --only validation (no server)"
expect_exit "lobu apply --only bogus -> exit 2" 2 "$PROJ" apply --only bogus

# ============================================================================
# Boot the embedded stack (auto-applies the project -> registers `local` ctx)
# ============================================================================
note "boot: lobu run --port $GW_PORT"
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-smoke"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  [ -n "${DATABASE_URL:-}" ] && echo "DATABASE_URL=$DATABASE_URL"
} >> "$PROJ/.env"

( cd "$PROJ" && node "$LOBU_BIN" run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
# Wait on the auto-apply markers only -- "api docs:" prints BEFORE the project
# auto-applies, so breaking on it would race the apply (see sdk-e2e.sh).
for _ in $(seq 1 120); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done
grep -qi "Apply complete" "$RUN_LOG" || die "lobu run did not auto-apply (skipped/halted?)"
pass "lobu run booted + auto-applied the project"

# Trigger loopback auth (local-init) + resolve the bootstrap org slug.
runlobu "$PROJ" whoami -c local
ORG="$( ( cd "$PROJ" && node "$LOBU_BIN" org current -c local 2>/dev/null ) | grep -oE '[a-z0-9][a-z0-9-]*' | grep -vE '^local$|^org$|^for$|^context$|^current$|^no$|^active$|^set$' | tail -1 )"
[ -n "$ORG" ] || die "could not resolve the local org slug (lobu org current -c local)"
echo ">> resolved local org: $ORG"

# ============================================================================
# SERVER-BACKED COMMANDS (loopback `local` context, auto-authed via local-init)
# ============================================================================
note "identity / status / token"
expect_grep "lobu whoami -c local" "Context" "$PROJ" whoami -c local
expect_grep "lobu status -c local" "API:" "$PROJ" status -c local
expect_grep "lobu token -c local" "Token" "$PROJ" token -c local
runlobu "$PROJ" token -c local --raw
{ [ "$RC" -eq 0 ] && [ -s "$OUT" ]; } && pass "lobu token --raw (non-empty)" || softfail "lobu token --raw produced no token (exit=$RC)"
expect_grep "lobu token create -c local" "created" "$PROJ" token create -c local --scope "mcp:read mcp:write" --name smoke-token

# token revoke needs an EXTERNAL Postgres (direct INSERT into revoked_tokens).
# In embedded mode the shell DATABASE_URL is unset -> assert the documented
# guard fires gracefully; with an external DATABASE_URL, do a real revoke.
if [ -n "${DATABASE_URL:-}" ] && [[ "${DATABASE_URL:-}" == postgres* ]]; then
  JTI="$( ( cd "$PROJ" && node "$LOBU_BIN" token create -c local --scope "mcp:read" --json 2>/dev/null ) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.jti||j.id||"")}catch{}})' )"
  if [ -n "$JTI" ]; then expect_grep "lobu token revoke (external PG)" "revoked" "$PROJ" token revoke "$JTI"
  else skip "lobu token revoke -- token create --json exposed no jti"; fi
else
  ( cd "$PROJ" && env -u DATABASE_URL node "$LOBU_BIN" token revoke smoke-jti ) > "$OUT" 2>&1 </dev/null; RC=$?
  { [ "$RC" -ne 0 ] && grep -qiF "DATABASE_URL is not set" "$OUT"; } && pass "lobu token revoke (graceful: needs external PG)" || softfail "lobu token revoke (expected 'DATABASE_URL is not set', exit=$RC)"
fi

note "org"
expect_grep "lobu org list -c local" "rganization" "$PROJ" org list -c local
expect_grep "lobu org current -c local" "org" "$PROJ" org current -c local
expect_grep "lobu org set -c local" "set to" "$PROJ" org set "$ORG" -c local

note "agent CRUD (REST)"
expect_grep "lobu agent list -c local" "echo" "$PROJ" agent list -c local
expect_grep "lobu agent create -c local" "Created agent" "$PROJ" agent create smoke-agent -c local --name "Smoke Agent"
expect_grep "lobu agent get -c local" "smoke-agent" "$PROJ" agent get smoke-agent -c local
expect_grep "lobu agent update -c local" "Updated agent" "$PROJ" agent update smoke-agent -c local --name "Smoke Agent v2"
expect_fail_grep "lobu agent update (no flags -> graceful)" "at least one" "$PROJ" agent update smoke-agent -c local
# config get --output, then round-trip that config back through patch (always valid).
expect_grep "lobu agent config get --output -c local" "Wrote" "$PROJ" agent config get smoke-agent -c local --output "$RUN_DIR/agent-config.json"
expect_grep "lobu agent config patch -c local" "Updated config" "$PROJ" agent config patch smoke-agent -c local --file "$RUN_DIR/agent-config.json"
expect_fail_grep "lobu agent delete (no --yes -> graceful)" "Refusing to delete" "$PROJ" agent delete smoke-agent -c local
expect_grep "lobu agent delete --yes -c local" "Deleted agent" "$PROJ" agent delete smoke-agent -c local --yes

note "call (generic admin REST dispatcher)"
expect_grep "lobu call --list -c local" "tool(s)" "$PROJ" call --list -c local
expect_ok "lobu call manage_feeds list_feeds -c local" "$PROJ" call manage_feeds -c local --arg "action=list_feeds"

note "init --from-org (bootstrap a re-appliable project from a live org)"
# init takes no -c flag; it uses the active context (local-init switched it to
# `local`) + --url to pin the server. Scaffolds into $RUN_DIR/fromorg.
rm -rf "$RUN_DIR/fromorg"
( cd "$RUN_DIR" && node "$LOBU_BIN" init fromorg -y --from-org "$ORG" --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && [ -f "$RUN_DIR/fromorg/lobu.config.ts" ]; } && pass "lobu init --from-org (scaffolded from live org)" || softfail "lobu init --from-org (exit=$RC, no lobu.config.ts written)"

note "link / unlink (project-level)"
expect_grep "lobu link -c local" "linked" "$PROJ" link -c local --org "$ORG"
expect_grep "lobu unlink" "unlinked" "$PROJ" unlink

note "apply (dry-run + real, against the live server)"
( cd "$PROJ" && MOCK_API_KEY=mock-key-smoke node "$LOBU_BIN" apply --dry-run --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qiF "Dry run" "$OUT"; } && pass "lobu apply --dry-run" || softfail "lobu apply --dry-run (expected 'Dry run', exit=$RC)"
( cd "$PROJ" && MOCK_API_KEY=mock-key-smoke node "$LOBU_BIN" apply --only agents --yes --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qiE "Apply complete|Nothing to apply|Provider keys applied" "$OUT"; } && pass "lobu apply --only agents --yes" || softfail "lobu apply --only agents (expected complete/noop, exit=$RC)"

note "chat (a real worker turn through the mock provider)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "say the safe word" -c local --json ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qiF "complete" "$OUT"; } && pass "lobu chat --json (complete event)" || softfail "lobu chat --json (expected a 'complete' event, exit=$RC)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "again" -c local --new ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qF "$MOCK_REPLY" "$OUT"; } && pass "lobu chat --new (mock reply)" || softfail "lobu chat --new (expected reply $MOCK_REPLY, exit=$RC)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "dry" -c local --dry-run ) > "$OUT" 2>&1 </dev/null; RC=$?
[ "$RC" -eq 0 ] && pass "lobu chat --dry-run" || softfail "lobu chat --dry-run (exit=$RC)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "more" -c local -C ) > "$OUT" 2>&1 </dev/null; RC=$?
[ "$RC" -eq 0 ] && pass "lobu chat -C/--continue" || softfail "lobu chat --continue (exit=$RC)"

note "memory MCP"
expect_grep "lobu memory health -c local" "ok: true" "$PROJ" memory health -c local
expect_grep "lobu memory run (list tools) -c local" "tool(s)" "$PROJ" memory run -c local
expect_grep "lobu memory org current -c local" "org:" "$PROJ" memory org current -c local
expect_grep "lobu memory org set -c local" "memory org" "$PROJ" memory org set "$ORG" -c local
expect_grep "lobu memory configure" "Updated" "$PROJ" memory configure -c local
# memory seed needs a config with `org` set -- use a dedicated minimal project.
SEEDPROJ="$RUN_DIR/seedproj"; mkdir -p "$SEEDPROJ"
cat > "$SEEDPROJ/lobu.config.ts" <<TS
import { defineConfig, defineEntityType } from "@lobu/cli/config";
const note = defineEntityType({ key: "note", name: "Note" });
export default defineConfig({ org: "$ORG", agents: [], entities: [note] });
TS
expect_grep "lobu memory seed --dry-run" "Dry run" "$SEEDPROJ" memory seed --dry-run -c local
# memory exec -- run a trivial ClientSDK script.
echo 'export default async () => "cli-smoke-exec-ok";' > "$RUN_DIR/exec.ts"
expect_ok "lobu memory exec (ClientSDK script)" "$PROJ" memory exec "$RUN_DIR/exec.ts" -c local
# memory init -- wire a local MCP CLIENT (the --agent is a coding tool like
# openclaw/claude-code, NOT a Lobu agent id) to the memory MCP url. --url skips
# the picker; --skip-auth skips the login step; isolated HOME contains the write.
( cd "$PROJ" && timeout 30 node "$LOBU_BIN" memory init --url "http://localhost:$GW_PORT/mcp" --agent openclaw --skip-auth ) > "$OUT" 2>&1 </dev/null; RC=$?
[ "$RC" -eq 0 ] && pass "lobu memory init --url --agent --skip-auth" || softfail "lobu memory init (exit=$RC)"
expect_grep "lobu doctor --memory-only" "ok: true" "$PROJ" doctor --memory-only

note "login / logout (round-trip on a throwaway loopback context)"
PAT="$( ( cd "$PROJ" && node "$LOBU_BIN" token -c local --raw 2>/dev/null ) | tr -d '[:space:]' )"
expect_grep "lobu context add (for login)" "Saved context" "$PROJ" context add smoke-login --url "http://localhost:$GW_PORT"
if [ -n "$PAT" ]; then
  expect_grep "lobu login --token" "Logged in" "$PROJ" login --token "$PAT" -c smoke-login
else
  skip "lobu login --token -- could not mint a PAT to log in with"
fi
expect_grep "lobu logout -c smoke-login" "Logged out" "$PROJ" logout -c smoke-login
expect_grep "lobu context rm smoke-login" "Removed context" "$PROJ" context rm smoke-login
# Device-code login on a fresh (unauthed) context with no TTY must bail cleanly
# -- the same graceful headless path `lobu login`/--quiet takes in CI. Use a
# FRESH context: `local` is already authed (local-init) and would short-circuit.
runlobu "$PROJ" context add smoke-empty --url "http://localhost:$GW_PORT"
expect_fail_grep "lobu login (non-interactive device-code -> graceful bail)" "interactive terminal" "$PROJ" login -c smoke-empty
runlobu "$PROJ" context rm smoke-empty

note "connector run (needs Chrome/Playwright + a browser_session profile)"
# --check resolves+validates without executing; with no auth profile it errors --
# assert it fails gracefully (clean message, controlled exit), not a crash.
runlobu "$PROJ" connector run --check -c local
[ "$RC" -ne 0 ] && pass "lobu connector run --check (graceful failure without auth profile)" || softfail "lobu connector run --check unexpectedly succeeded (exit=$RC)"

note "browser/interactive paths -- not unattended-runnable"
skip "lobu login (interactive device-code happy path) -- needs a real TTY; --token + non-interactive bail covered above"
skip "lobu org create -- opens a browser to /orgs/new"
skip "lobu memory browser-auth (capture) -- needs local Chrome + Keychain prompt"
skip "lobu chat --user platform:id -- needs a configured Telegram/Slack connection"

# ============================================================================
echo ""
echo "================================================================"
echo "  CLI smoke summary: $PASSES passed, $FAILS failed, $SKIPS skipped"
echo "================================================================"
if [ "$FAILS" -gt 0 ]; then
  echo "RESULT: CLI smoke FAILED ($FAILS command(s) broken)"; exit 1
fi
echo "RESULT: CLI smoke PASSED -- every runnable command works"
